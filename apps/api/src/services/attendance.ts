import { and, asc, eq, gte, lte } from 'drizzle-orm';
import {
  DomainError,
  assertNotSelf,
  canAccess,
  checkAccess,
  isWorkingDay,
  localDateString,
  localParts,
  minutesAfterStart,
} from '@retarget/shared';
import { z } from 'zod';
import { attendance, memberships, users } from '../db/schema.js';
import { notFound, scheduleOf, type Ctx, type ResolvedActor } from './context.js';
import { audit } from './org.js';

export const locationInput = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** When the office location is set, "Keldim" requires a location within the radius. */
function checkLocation(actor: ResolvedActor, loc: z.infer<typeof locationInput>): number | null {
  const c = actor.company;
  if (c.officeLat == null || c.officeLng == null) return null;
  if (loc.lat == null || loc.lng == null) throw new DomainError('VALIDATION', 'Joylashuvni yuboring');
  const d = distanceM(c.officeLat, c.officeLng, loc.lat, loc.lng);
  if (d > c.officeRadiusM) throw new DomainError('VALIDATION', `Siz ofisdan ${d} m uzoqdasiz`);
  return d;
}

export async function checkIn(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof locationInput>) {
  const loc = locationInput.parse(input);
  const distance = checkLocation(actor, loc);
  const now = ctx.now();
  const schedule = scheduleOf(actor.company);
  const day = localDateString(now, schedule.timezone);
  const p = localParts(now, schedule.timezone);
  const working = isWorkingDay({ y: p.year, m: p.month, d: p.day, weekday: p.weekday }, schedule);
  const [existing] = await ctx.db.select().from(attendance).where(and(eq(attendance.companyId, actor.companyId), eq(attendance.userId, actor.userId), eq(attendance.day, day)));
  if (existing?.checkIn) throw new DomainError('VALIDATION', 'Bugun allaqachon "Keldim" bosilgan');
  const [row] = await ctx.db
    .insert(attendance)
    .values({
      companyId: actor.companyId,
      userId: actor.userId,
      day,
      checkIn: now,
      checkInLat: loc.lat ?? null,
      checkInLng: loc.lng ?? null,
      lateMinutes: working ? Math.max(0, minutesAfterStart(now, schedule)) : 0,
      distanceM: distance,
    })
    .returning();
  return row!;
}

export async function checkOut(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof locationInput>) {
  const loc = locationInput.parse(input);
  const now = ctx.now();
  const day = localDateString(now, actor.company.timezone);
  const [row] = await ctx.db.select().from(attendance).where(and(eq(attendance.companyId, actor.companyId), eq(attendance.userId, actor.userId), eq(attendance.day, day)));
  if (!row?.checkIn) throw new DomainError('VALIDATION', 'Avval "Keldim" bosing');
  if (row.checkOut) throw new DomainError('VALIDATION', 'Bugun allaqachon "Ketdim" bosilgan');
  const [u] = await ctx.db
    .update(attendance)
    .set({ checkOut: now, checkOutLat: loc.lat ?? null, checkOutLng: loc.lng ?? null })
    .where(eq(attendance.id, row.id))
    .returning();
  return u!;
}

export async function today(ctx: Ctx, actor: ResolvedActor) {
  const day = localDateString(ctx.now(), actor.company.timezone);
  const [row] = await ctx.db.select().from(attendance).where(and(eq(attendance.companyId, actor.companyId), eq(attendance.userId, actor.userId), eq(attendance.day, day)));
  return {
    day,
    checkIn: row?.checkIn ?? null,
    checkOut: row?.checkOut ?? null,
    lateMinutes: row?.lateMinutes ?? 0,
    needsLocation: actor.company.officeLat != null,
  };
}

export const listAttendanceInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  userId: z.string().uuid().optional(),
});

export async function listAttendance(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof listAttendanceInput>) {
  const f = listAttendanceInput.parse(input);
  const conds = [eq(attendance.companyId, actor.companyId), gte(attendance.day, f.from), lte(attendance.day, f.to)];
  if (f.userId) conds.push(eq(attendance.userId, f.userId));
  const rows = await ctx.db
    .select({ a: attendance, departmentId: memberships.departmentId, firstName: users.firstName, lastName: users.lastName })
    .from(attendance)
    .innerJoin(memberships, and(eq(memberships.userId, attendance.userId), eq(memberships.companyId, attendance.companyId)))
    .innerJoin(users, eq(users.id, attendance.userId))
    .where(and(...conds))
    .orderBy(asc(attendance.day));
  return rows
    .filter((r) => canAccess(actor, 'attendance.view', { companyId: actor.companyId, departmentId: r.departmentId, ownerUserIds: [r.a.userId] }))
    .map((r) => ({ ...r.a, name: [r.firstName, r.lastName].filter(Boolean).join(' ') }));
}

export const editAttendanceInput = z.object({
  userId: z.string().uuid(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkIn: z.coerce.date().nullable(),
  checkOut: z.coerce.date().nullable(),
  note: z.string().trim().min(3).max(300),
});

/** HR corrections — never on one's own record, always with a note, always audited. */
export async function editAttendance(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof editAttendanceInput>) {
  const data = editAttendanceInput.parse(input);
  const [m] = await ctx.db.select().from(memberships).where(and(eq(memberships.companyId, actor.companyId), eq(memberships.userId, data.userId)));
  if (!m) throw notFound('Hodim');
  checkAccess(actor, 'attendance.manage', { companyId: actor.companyId, departmentId: m.departmentId, ownerUserIds: [data.userId] });
  assertNotSelf(actor, 'attendance.manage', data.userId);
  const schedule = scheduleOf(actor.company);
  const lateMinutes = data.checkIn ? Math.max(0, minutesAfterStart(data.checkIn, schedule)) : 0;
  const values = { checkIn: data.checkIn, checkOut: data.checkOut, note: data.note, editedBy: actor.userId, lateMinutes };
  const [row] = await ctx.db
    .insert(attendance)
    .values({ companyId: actor.companyId, userId: data.userId, day: data.day, ...values })
    .onConflictDoUpdate({ target: [attendance.companyId, attendance.userId, attendance.day], set: values })
    .returning();
  await audit(ctx.db, actor, 'attendance.edit', 'attendance', row!.id, { userId: data.userId, day: data.day, note: data.note });
  return row!;
}
