import { and, asc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { DomainError, canAccess, checkAccess, localDateString, zonedTime } from '@retarget/shared';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { companies, memberships, projects, shoots, users } from '../db/schema.js';
import { notFound, type Ctx, type ResolvedActor } from './context.js';
import { audit } from './org.js';

export const SHOOT_TYPES = ['PHOTO', 'VIDEO', 'REELS', 'EVENT', 'INTERVIEW', 'PODCAST'] as const;
export const SHOOT_STATUSES = ['PLANNING', 'SCHEDULED', 'CONFIRMED', 'DONE', 'CANCELLED'] as const;
const TYPE_LABEL: Record<string, string> = { PHOTO: 'Foto', VIDEO: 'Video', REELS: 'Reels', EVENT: 'Tadbir', INTERVIEW: 'Intervyu', PODCAST: 'Podkast' };

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Vaqt HH:MM ko‘rinishida');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Sana YYYY-MM-DD ko‘rinishida');

export const shootInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    projectId: z.string().uuid().nullable().optional(),
    type: z.enum(SHOOT_TYPES).default('VIDEO'),
    status: z.enum(SHOOT_STATUSES).default('SCHEDULED'),
    day,
    startTime: hm,
    endTime: hm,
    location: z.string().trim().max(200).nullable().optional(),
    crew: z.array(z.string().uuid()).max(30).default([]),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .refine((v) => v.startTime < v.endTime, { message: 'Tugash vaqti boshlanishdan keyin bo‘lishi kerak', path: ['endTime'] });

type Shoot = typeof shoots.$inferSelect;

function instants(d: string, start: string, end: string, tz: string) {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  const [sh, sm] = start.split(':').map(Number) as [number, number];
  const [eh, em] = end.split(':').map(Number) as [number, number];
  return { startsAt: zonedTime(y, m, dd, sh, sm, tz), endsAt: zonedTime(y, m, dd, eh, em, tz) };
}

async function assertCrew(db: Db, companyId: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await db
    .select({ id: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.companyId, companyId), inArray(memberships.userId, ids), eq(memberships.status, 'ACTIVE')));
  if (rows.length !== new Set(ids).size) throw new DomainError('VALIDATION', "Jamoada kompaniya a'zosi bo'lmaganlar bor");
}

async function assertProject(db: Db, companyId: string, projectId: string | null | undefined) {
  if (!projectId) return;
  const [p] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)));
  if (!p) throw notFound('Loyiha');
}

function assertCanManage(actor: ResolvedActor, projectId: string | null | undefined) {
  checkAccess(actor, 'shoot.manage', { companyId: actor.companyId, projectId: projectId ?? null });
}

export function canManageShoot(actor: ResolvedActor, projectId: string | null) {
  return canAccess(actor, 'shoot.manage', { companyId: actor.companyId, projectId });
}

/** Crew members already busy at an overlapping time on the same day (a warning, not a block). */
export async function crewConflicts(db: Db, companyId: string, s: { id?: string; day: string; startTime: string; endTime: string; crew: string[] }) {
  if (!s.crew.length) return [];
  const same = await db
    .select()
    .from(shoots)
    .where(
      and(
        eq(shoots.companyId, companyId),
        eq(shoots.day, s.day),
        ne(shoots.status, 'CANCELLED'),
        s.id ? ne(shoots.id, s.id) : sql`true`,
        sql`${shoots.crew} && ${sql.raw(`ARRAY[${s.crew.map((c) => `'${c.replace(/[^0-9a-f-]/gi, '')}'`).join(',')}]::uuid[]`)}`,
      ),
    );
  const out: Array<{ userId: string; shootId: string; title: string; startTime: string; endTime: string }> = [];
  for (const o of same) {
    if (!(o.startTime < s.endTime && s.startTime < o.endTime)) continue;
    for (const u of o.crew) if (s.crew.includes(u)) out.push({ userId: u, shootId: o.id, title: o.title, startTime: o.startTime, endTime: o.endTime });
  }
  return out;
}

const MONTHS = ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function humanDay(d: string) {
  const [, m, dd] = d.split('-').map(Number) as [number, number, number];
  return `${dd}-${MONTHS[m - 1]}`;
}

export function shootText(s: Pick<Shoot, 'title' | 'type' | 'day' | 'startTime' | 'endTime' | 'location' | 'notes'>, projectName: string | null, head: string) {
  return [
    `${head}\n<b>${esc(s.title)}</b>`,
    projectName ? `📁 ${esc(projectName)}` : null,
    `🎬 ${TYPE_LABEL[s.type] ?? s.type}`,
    `🗓 ${humanDay(s.day)}, ${s.startTime}–${s.endTime}`,
    s.location ? `📍 ${esc(s.location)}` : null,
    s.notes ? `📝 ${esc(s.notes.slice(0, 400))}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

async function notifyCrew(ctx: Ctx, s: Shoot, userIds: string[], head: string) {
  if (!userIds.length) return;
  const people = await ctx.db.select({ tg: users.telegramId }).from(users).where(inArray(users.id, userIds));
  const [p] = s.projectId ? await ctx.db.select({ name: projects.name }).from(projects).where(eq(projects.id, s.projectId)) : [];
  const text = shootText(s, p?.name ?? null, head);
  for (const u of people) await ctx.notifier.direct(u.tg, text).catch(() => undefined);
}

// ------------------------------------------------------------------------------------------ queries

export async function listShoots(ctx: Ctx, actor: ResolvedActor, q: { from: string; to: string }) {
  const from = day.parse(q.from);
  const to = day.parse(q.to);
  const rows = await ctx.db
    .select({ s: shoots, projectName: projects.name, projectColor: projects.color })
    .from(shoots)
    .leftJoin(projects, eq(projects.id, shoots.projectId))
    .where(and(eq(shoots.companyId, actor.companyId), gte(shoots.day, from), lte(shoots.day, to)))
    .orderBy(asc(shoots.day), asc(shoots.startTime));
  const crewIds = [...new Set(rows.flatMap((r) => r.s.crew))];
  const people = crewIds.length
    ? await ctx.db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, photoUrl: users.photoUrl }).from(users).where(inArray(users.id, crewIds))
    : [];
  const byId = new Map(people.map((p) => [p.id, { id: p.id, name: [p.firstName, p.lastName].filter(Boolean).join(' '), photoUrl: p.photoUrl }]));
  // "Only my projects": shoots of other projects stay hidden.
  return rows
    .filter(({ s }) => !s.projectId || canAccess(actor, 'project.view', { companyId: actor.companyId, projectId: s.projectId }))
    .map(({ s, projectName, projectColor }) => ({
    id: s.id,
    title: s.title,
    type: s.type,
    status: s.status,
    day: s.day,
    startTime: s.startTime,
    endTime: s.endTime,
    location: s.location,
    notes: s.notes,
    projectId: s.projectId,
    project: projectName,
    color: projectColor ?? '#34D399',
    crew: s.crew.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x),
    canEdit: canManageShoot(actor, s.projectId),
  }));
}

async function loadShoot(db: Db, companyId: string, id: string) {
  const [s] = await db.select().from(shoots).where(and(eq(shoots.id, id), eq(shoots.companyId, companyId)));
  if (!s) throw notFound('Syomka');
  return s;
}

// ------------------------------------------------------------------------------------------ commands

export async function createShoot(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof shootInput>) {
  const data = shootInput.parse(input);
  assertCanManage(actor, data.projectId);
  await assertProject(ctx.db, actor.companyId, data.projectId);
  const crew = [...new Set(data.crew)];
  await assertCrew(ctx.db, actor.companyId, crew);
  const [c] = await ctx.db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, actor.companyId));
  const now = ctx.now();
  const [s] = await ctx.db
    .insert(shoots)
    .values({
      companyId: actor.companyId,
      projectId: data.projectId ?? null,
      title: data.title,
      type: data.type,
      status: data.status,
      day: data.day,
      startTime: data.startTime,
      endTime: data.endTime,
      ...instants(data.day, data.startTime, data.endTime, c!.tz),
      location: data.location ?? null,
      crew,
      notes: data.notes ?? null,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await audit(ctx.db, actor, 'shoot.create', 'shoot', s!.id, { title: data.title, day: data.day });
  if (s!.status !== 'PLANNING') await notifyCrew(ctx, s!, crew.filter((u) => u !== actor.userId), '🎬 <b>Yangi syomka</b>');
  return { shoot: s!, conflicts: await crewConflicts(ctx.db, actor.companyId, s!) };
}

export async function updateShoot(ctx: Ctx, actor: ResolvedActor, id: string, input: Partial<z.input<typeof shootInput>>) {
  const before = await loadShoot(ctx.db, actor.companyId, id);
  assertCanManage(actor, before.projectId);
  const merged = shootInput.parse({
    title: before.title,
    projectId: before.projectId,
    type: before.type,
    status: before.status,
    day: before.day,
    startTime: before.startTime,
    endTime: before.endTime,
    location: before.location,
    crew: before.crew,
    notes: before.notes,
    ...input,
  });
  if (merged.projectId !== before.projectId) {
    assertCanManage(actor, merged.projectId);
    await assertProject(ctx.db, actor.companyId, merged.projectId);
  }
  const crew = [...new Set(merged.crew)];
  await assertCrew(ctx.db, actor.companyId, crew);
  const [c] = await ctx.db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, actor.companyId));
  const moved = merged.day !== before.day || merged.startTime !== before.startTime || merged.endTime !== before.endTime;
  const [s] = await ctx.db
    .update(shoots)
    .set({
      projectId: merged.projectId ?? null,
      title: merged.title,
      type: merged.type,
      status: merged.status,
      day: merged.day,
      startTime: merged.startTime,
      endTime: merged.endTime,
      ...instants(merged.day, merged.startTime, merged.endTime, c!.tz),
      location: merged.location ?? null,
      crew,
      notes: merged.notes ?? null,
      // A new time means the reminders are due again.
      ...(moved ? { remindersSent: [] } : {}),
      updatedAt: ctx.now(),
    })
    .where(eq(shoots.id, id))
    .returning();
  await audit(ctx.db, actor, 'shoot.update', 'shoot', id, { ...input });

  const others = (ids: string[]) => ids.filter((u) => u !== actor.userId);
  const added = crew.filter((u) => !before.crew.includes(u));
  const removed = before.crew.filter((u) => !crew.includes(u));
  if (s!.status === 'CANCELLED' && before.status !== 'CANCELLED') {
    await notifyCrew(ctx, s!, others(before.crew), '✖️ <b>Syomka bekor qilindi</b>');
  } else if (s!.status !== 'PLANNING' && s!.status !== 'CANCELLED') {
    const wasHidden = before.status === 'PLANNING' || before.status === 'CANCELLED';
    await notifyCrew(ctx, s!, others(wasHidden ? crew : added), '🎬 <b>Siz syomkaga qo‘shildingiz</b>');
    if (!wasHidden && moved) await notifyCrew(ctx, s!, others(crew.filter((u) => !added.includes(u))), '🔁 <b>Syomka vaqti o‘zgardi</b>');
    if (!wasHidden && s!.status === 'CONFIRMED' && before.status !== 'CONFIRMED') await notifyCrew(ctx, s!, others(crew.filter((u) => !added.includes(u))), '✅ <b>Syomka tasdiqlandi</b>');
  }
  if (removed.length && before.status !== 'PLANNING' && before.status !== 'CANCELLED') {
    await notifyCrew(ctx, s!, others(removed), '➖ <b>Siz syomkadan chiqarildingiz</b>');
  }
  return { shoot: s!, conflicts: await crewConflicts(ctx.db, actor.companyId, s!) };
}

export async function deleteShoot(ctx: Ctx, actor: ResolvedActor, id: string) {
  const s = await loadShoot(ctx.db, actor.companyId, id);
  assertCanManage(actor, s.projectId);
  await ctx.db.delete(shoots).where(eq(shoots.id, id));
  await audit(ctx.db, actor, 'shoot.delete', 'shoot', id, { title: s.title, day: s.day });
  if (s.status !== 'PLANNING' && s.status !== 'CANCELLED' && s.endsAt > ctx.now()) {
    await notifyCrew(ctx, s, s.crew.filter((u) => u !== actor.userId), '✖️ <b>Syomka bekor qilindi</b>');
  }
}

// ------------------------------------------------------------------------------------------ reminders

const H = 3_600_000;

/**
 * Crew reminders: the day before (24 h) and 2 h before the start. Each key is claimed atomically
 * in `reminders_sent`, so a restart or a second worker never double-sends.
 */
export async function runShootReminders(ctx: Ctx): Promise<number> {
  const now = ctx.now();
  const rows = await ctx.db
    .select({ s: shoots, projectName: projects.name, tz: companies.timezone })
    .from(shoots)
    .innerJoin(companies, eq(companies.id, shoots.companyId))
    .leftJoin(projects, eq(projects.id, shoots.projectId))
    .where(and(inArray(shoots.status, ['SCHEDULED', 'CONFIRMED']), gte(shoots.startsAt, now), lte(shoots.startsAt, new Date(now.getTime() + 24 * H))));
  let sent = 0;
  for (const { s, projectName, tz } of rows) {
    const untilStart = s.startsAt.getTime() - now.getTime();
    // Only the most relevant reminder: within 2 h → "soon", otherwise → "tomorrow/today".
    const key = untilStart <= 2 * H ? 'h2' : 'h24';
    if (s.remindersSent.includes(key) || (key === 'h24' && s.remindersSent.includes('h2'))) continue;
    // A shoot created less than 2 h before the "day-before" moment needs no second nudge.
    if (key === 'h24' && s.createdAt.getTime() > s.startsAt.getTime() - 26 * H) continue;
    if (key === 'h2' && s.createdAt.getTime() > s.startsAt.getTime() - 3 * H) continue;
    const claimed = await ctx.db
      .update(shoots)
      .set({ remindersSent: sql`array_append(${shoots.remindersSent}, ${key})` })
      .where(and(eq(shoots.id, s.id), sql`not (${key} = any(${shoots.remindersSent}))`))
      .returning({ id: shoots.id });
    if (!claimed.length || !s.crew.length) continue;
    const people = await ctx.db.select({ tg: users.telegramId }).from(users).where(inArray(users.id, s.crew));
    const today = localDateString(now, tz) === s.day;
    const head = key === 'h2' ? '⏰ <b>Syomka 2 soatdan keyin</b>' : today ? '📅 <b>Bugun syomka</b>' : '📅 <b>Ertaga syomka</b>';
    const text = shootText(s, projectName, head);
    for (const u of people) {
      await ctx.notifier.direct(u.tg, text).catch(() => undefined);
      sent++;
    }
  }
  return sent;
}
