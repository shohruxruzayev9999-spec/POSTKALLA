import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DomainError, ROLES, assertCanGrantRole, canAccess, checkAccess, type Role } from '@retarget/shared';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { companies, departments, joinRequests, memberships, telegramGroups, users } from '../db/schema.js';
import { audit } from './org.js';
import { loadActor, notFound, type Ctx, type ResolvedActor } from './context.js';

/**
 * Joining through Telegram groups (no self-registration):
 * the bot is added to a group → a leader's company claims it → people press the join button →
 * a CEO / admin / HR or the head of the group's department approves. CLIENT groups never turn
 * anyone into an employee.
 */

export type Group = typeof telegramGroups.$inferSelect;

const groupTarget = (companyId: string, departmentId: string | null) => ({ companyId, departmentId });

/** Companies where this user may claim a group: they can manage people there. */
export async function claimableCompanies(db: Db, userId: string) {
  const rows = await db
    .select({ id: companies.id, name: companies.name })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'ACTIVE')));
  const out: Array<{ id: string; name: string; departmentId: string | null }> = [];
  for (const c of rows) {
    const a = await loadActor(db, userId, c.id);
    if (canAccess(a, 'employee.manage', { companyId: c.id })) out.push({ ...c, departmentId: null });
    else if (a.headOfDepartmentIds.length) out.push({ ...c, departmentId: a.headOfDepartmentIds[0]! });
  }
  return out;
}

/** The bot was added to a group by `userId`: link it to `companyId` (or move it there). */
export async function registerGroup(ctx: Ctx, userId: string, companyId: string, chatId: number, title: string): Promise<Group> {
  const options = await claimableCompanies(ctx.db, userId);
  const pick = options.find((c) => c.id === companyId);
  if (!pick) throw new DomainError('FORBIDDEN', "Guruhni faqat kompaniya rahbari yoki bo'lim boshlig'i ulay oladi");
  const [existing] = await ctx.db.select().from(telegramGroups).where(eq(telegramGroups.chatId, chatId));
  if (existing && existing.companyId !== companyId && existing.active) {
    throw new DomainError('VALIDATION', 'Bu guruh boshqa kompaniyaga ulangan');
  }
  const values = { companyId, chatId, title, active: true, addedBy: userId, departmentId: existing?.departmentId ?? pick.departmentId };
  const [g] = existing
    ? await ctx.db.update(telegramGroups).set(values).where(eq(telegramGroups.id, existing.id)).returning()
    : await ctx.db.insert(telegramGroups).values({ ...values, createdAt: ctx.now() }).returning();
  const actor = await loadActor(ctx.db, userId, companyId);
  await audit(ctx.db, actor, 'group.register', 'telegram_group', g!.id, { chatId, title });
  return g!;
}

export async function groupByChat(db: Db, chatId: number): Promise<Group | undefined> {
  const [g] = await db.select().from(telegramGroups).where(and(eq(telegramGroups.chatId, chatId), eq(telegramGroups.active, true)));
  return g;
}

export async function deactivateGroup(db: Db, chatId: number): Promise<void> {
  await db.update(telegramGroups).set({ active: false }).where(eq(telegramGroups.chatId, chatId));
}

export type JoinResult = { status: 'MEMBER' } | { status: 'PENDING'; isNew: boolean; requestId: string };

/** Someone pressed the join button in a group. */
export async function requestJoin(ctx: Ctx, userId: string, chatId: number): Promise<JoinResult> {
  const g = await groupByChat(ctx.db, chatId);
  if (!g) throw new DomainError('NOT_FOUND', 'Bu guruh POSTKALLA ga ulanmagan');
  if (g.kind === 'CLIENT') throw new DomainError('VALIDATION', "Bu mijoz guruhi: bu yerdan jamoaga qo'shilib bo'lmaydi");
  const [m] = await ctx.db.select().from(memberships).where(and(eq(memberships.companyId, g.companyId), eq(memberships.userId, userId)));
  if (m?.status === 'ACTIVE') return { status: 'MEMBER' };
  if (m) throw new DomainError('FORBIDDEN', 'Kirish huquqingiz yopilgan. Rahbaringizga murojaat qiling');

  const [prev] = await ctx.db.select().from(joinRequests).where(and(eq(joinRequests.companyId, g.companyId), eq(joinRequests.userId, userId)));
  if (prev?.status === 'PENDING') return { status: 'PENDING', isNew: false, requestId: prev.id };
  const [r] = prev
    ? await ctx.db
        .update(joinRequests)
        .set({ status: 'PENDING', groupId: g.id, decidedBy: null, decidedAt: null, createdAt: ctx.now() })
        .where(eq(joinRequests.id, prev.id))
        .returning()
    : await ctx.db.insert(joinRequests).values({ companyId: g.companyId, userId, groupId: g.id, createdAt: ctx.now() }).returning();

  await notifyApprovers(ctx, g, userId);
  return { status: 'PENDING', isNew: true, requestId: r!.id };
}

async function notifyApprovers(ctx: Ctx, g: Group, userId: string) {
  const [u] = await ctx.db.select().from(users).where(eq(users.id, userId));
  const rows = await ctx.db
    .select({ userId: memberships.userId, tg: users.telegramId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, g.companyId), eq(memberships.status, 'ACTIVE')));
  const name = [u?.firstName, u?.lastName].filter(Boolean).join(' ');
  for (const r of rows) {
    const a = await loadActor(ctx.db, r.userId, g.companyId);
    if (!canAccess(a, 'employee.manage', groupTarget(g.companyId, g.departmentId))) continue;
    await ctx.notifier
      .direct(r.tg, `🙋 <b>${escHtml(name)}</b>${u?.username ? ` (@${escHtml(u.username)})` : ''} «${escHtml(g.title)}» guruhidan jamoaga qo'shilmoqchi.`, {
        text: '✅ Ko‘rib chiqish',
        startParam: 'join_requests',
      })
      .catch(() => undefined);
  }
}

const escHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

// ---------------------------------------------------------------------------------------- manage

async function loadRequest(db: Db, companyId: string, id: string) {
  const [row] = await db
    .select({ r: joinRequests, g: telegramGroups })
    .from(joinRequests)
    .leftJoin(telegramGroups, eq(telegramGroups.id, joinRequests.groupId))
    .where(and(eq(joinRequests.id, id), eq(joinRequests.companyId, companyId)));
  if (!row) throw notFound("So'rov");
  return row;
}

export async function listJoinRequests(ctx: Ctx, actor: ResolvedActor) {
  const rows = await ctx.db
    .select({ r: joinRequests, u: users, group: telegramGroups.title, groupDept: telegramGroups.departmentId })
    .from(joinRequests)
    .innerJoin(users, eq(users.id, joinRequests.userId))
    .leftJoin(telegramGroups, eq(telegramGroups.id, joinRequests.groupId))
    .where(and(eq(joinRequests.companyId, actor.companyId), eq(joinRequests.status, 'PENDING')))
    .orderBy(asc(joinRequests.createdAt));
  return rows
    .filter((x) => canAccess(actor, 'employee.manage', groupTarget(actor.companyId, x.groupDept ?? null)))
    .map((x) => ({
      id: x.r.id,
      userId: x.u.id,
      name: [x.u.firstName, x.u.lastName].filter(Boolean).join(' '),
      username: x.u.username,
      photoUrl: x.u.photoUrl,
      group: x.group,
      departmentId: x.groupDept ?? null,
      createdAt: x.r.createdAt,
    }));
}

export const approveInput = z.object({
  departmentId: z.string().uuid().nullable().optional(),
  role: z.enum(ROLES).default('EMPLOYEE'),
  position: z.string().trim().max(60).nullable().optional(),
});

export async function approveJoin(ctx: Ctx, actor: ResolvedActor, id: string, input: z.input<typeof approveInput>) {
  const data = approveInput.parse(input ?? {});
  const { r, g } = await loadRequest(ctx.db, actor.companyId, id);
  if (r.status !== 'PENDING') throw new DomainError('VALIDATION', "So'rov allaqachon ko'rib chiqilgan");
  if (r.userId === actor.userId) throw new DomainError('SELF_ACTION_FORBIDDEN', "O'z so'rovingizni tasdiqlay olmaysiz");
  checkAccess(actor, 'employee.manage', groupTarget(actor.companyId, g?.departmentId ?? null));
  const departmentId = data.departmentId === undefined ? (g?.departmentId ?? null) : data.departmentId;
  if (departmentId) {
    checkAccess(actor, 'employee.manage', groupTarget(actor.companyId, departmentId));
    const [d] = await ctx.db.select().from(departments).where(and(eq(departments.id, departmentId), eq(departments.companyId, actor.companyId)));
    if (!d) throw notFound("Bo'lim");
  }
  assertCanGrantRole(actor, data.role as Role);

  await ctx.db.transaction(async (tx) => {
    // Claim the request first: of two approvers deciding at once, only one gets the row.
    const [claimed] = await tx
      .update(joinRequests)
      .set({ status: 'APPROVED', decidedBy: actor.userId, decidedAt: ctx.now() })
      .where(and(eq(joinRequests.id, r.id), eq(joinRequests.status, 'PENDING')))
      .returning({ id: joinRequests.id });
    if (!claimed) throw new DomainError('VALIDATION', "So'rov allaqachon ko'rib chiqilgan");
    const [m] = await tx.select().from(memberships).where(and(eq(memberships.companyId, actor.companyId), eq(memberships.userId, r.userId)));
    if (m) {
      await tx.update(memberships).set({ status: 'ACTIVE', roles: [data.role], departmentId, position: data.position ?? m.position }).where(eq(memberships.id, m.id));
    } else {
      await tx.insert(memberships).values({
        companyId: actor.companyId,
        userId: r.userId,
        roles: [data.role],
        departmentId,
        position: data.position ?? null,
        joinedAt: ctx.now(),
      });
    }
    await audit(tx as unknown as Db, actor, 'join.approve', 'join_request', r.id, { userId: r.userId, role: data.role, departmentId });
  });
  const [u] = await ctx.db.select().from(users).where(eq(users.id, r.userId));
  if (u)
    await ctx.notifier
      .direct(u.telegramId, `✅ Siz <b>${escHtml(actor.company.name)}</b> jamoasiga qo'shildingiz. Vazifa va loyihalaringiz ilovada.`, { text: '🚀 Ilovani ochish' })
      .catch(() => undefined);
  return { ok: true };
}

export async function rejectJoin(ctx: Ctx, actor: ResolvedActor, id: string) {
  const { r, g } = await loadRequest(ctx.db, actor.companyId, id);
  if (r.status !== 'PENDING') throw new DomainError('VALIDATION', "So'rov allaqachon ko'rib chiqilgan");
  checkAccess(actor, 'employee.manage', groupTarget(actor.companyId, g?.departmentId ?? null));
  const [claimed] = await ctx.db
    .update(joinRequests)
    .set({ status: 'REJECTED', decidedBy: actor.userId, decidedAt: ctx.now() })
    .where(and(eq(joinRequests.id, r.id), eq(joinRequests.status, 'PENDING')))
    .returning({ id: joinRequests.id });
  if (!claimed) throw new DomainError('VALIDATION', "So'rov allaqachon ko'rib chiqilgan");
  await audit(ctx.db, actor, 'join.reject', 'join_request', r.id, { userId: r.userId });
  return { ok: true };
}

/** For a user with no company yet: is anything waiting? Drives the "tasdiqlanmoqda" screen. */
export async function myJoinStatus(db: Db, userId: string) {
  const rows = await db
    .select({ status: joinRequests.status, company: companies.name, group: telegramGroups.title })
    .from(joinRequests)
    .innerJoin(companies, eq(companies.id, joinRequests.companyId))
    .leftJoin(telegramGroups, eq(telegramGroups.id, joinRequests.groupId))
    .where(and(eq(joinRequests.userId, userId), inArray(joinRequests.status, ['PENDING', 'REJECTED'])));
  return rows;
}

// ---------------------------------------------------------------------------------------- groups

export async function listGroups(ctx: Ctx, actor: ResolvedActor) {
  const rows = await ctx.db
    .select({ g: telegramGroups, dept: departments.name, pending: sql<number>`(select count(*)::int from join_requests j where j.group_id = ${telegramGroups.id} and j.status = 'PENDING')` })
    .from(telegramGroups)
    .leftJoin(departments, eq(departments.id, telegramGroups.departmentId))
    .where(and(eq(telegramGroups.companyId, actor.companyId), eq(telegramGroups.active, true)))
    .orderBy(asc(telegramGroups.title));
  return rows
    .filter((x) => canAccess(actor, 'employee.manage', groupTarget(actor.companyId, x.g.departmentId)))
    .map((x) => ({ id: x.g.id, title: x.g.title, kind: x.g.kind, departmentId: x.g.departmentId, department: x.dept, pending: x.pending }));
}

export const groupInput = z.object({
  kind: z.enum(['TEAM', 'CLIENT']).optional(),
  departmentId: z.string().uuid().nullable().optional(),
});

export async function updateGroup(ctx: Ctx, actor: ResolvedActor, id: string, input: z.input<typeof groupInput>) {
  const data = groupInput.parse(input);
  const [g] = await ctx.db.select().from(telegramGroups).where(and(eq(telegramGroups.id, id), eq(telegramGroups.companyId, actor.companyId)));
  if (!g) throw notFound('Guruh');
  checkAccess(actor, 'employee.manage', groupTarget(actor.companyId, g.departmentId));
  if (data.departmentId !== undefined) checkAccess(actor, 'employee.manage', groupTarget(actor.companyId, data.departmentId));
  const [u] = await ctx.db.update(telegramGroups).set(data).where(eq(telegramGroups.id, id)).returning();
  // A group turned into a client group: its waiting requests are closed.
  if (data.kind === 'CLIENT') {
    await ctx.db
      .update(joinRequests)
      .set({ status: 'REJECTED', decidedBy: actor.userId, decidedAt: ctx.now() })
      .where(and(eq(joinRequests.groupId, id), eq(joinRequests.status, 'PENDING')));
  }
  await audit(ctx.db, actor, 'group.update', 'telegram_group', id, data);
  return u!;
}
