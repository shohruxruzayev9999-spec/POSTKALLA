import { and, asc, eq, sql } from 'drizzle-orm';
import { DomainError, localParts } from '@retarget/shared';
import { z } from 'zod';
import { companies, projects, projectMonths, tasks, users } from '../db/schema.js';
import { type Ctx, type ResolvedActor, notFound } from './context.js';
import { ensureColumns, cardCounts } from './boards.js';
import { canSeeTask, type TaskRow } from './tasks.js';
import { audit } from './org.js';

export const monthInput = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
export function monthAt(now: Date, timezone: string) {
  const p = localParts(now, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}
function nextMonth(month: string) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, '0')}`;
}
const closed = (t: { status: string }) => ['DONE', 'CANCELLED'].includes(t.status);
const locked = new WeakSet<Ctx>();

/** All task/board mutations use the same transaction lock as month rollover. */
export async function calendarWrite<T>(ctx: Ctx, actor: ResolvedActor, work: (ctx: Ctx) => Promise<T>): Promise<T> {
  if (locked.has(ctx)) return work(ctx);
  return ctx.db.transaction(async tx => {
    const inner: Ctx = { ...ctx, db: tx as unknown as Ctx['db'] };
    locked.add(inner);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`calendar:${actor.companyId}`}))`);
    await sync(inner, actor.companyId, actor.company.timezone);
    const result = await work(inner);
    await sync(inner, actor.companyId, actor.company.timezone);
    await refresh(inner, actor.companyId, actor.company.timezone);
    return result;
  });
}

async function refresh(ctx: Ctx, companyId: string, timezone: string) {
  const current = monthAt(ctx.now(), timezone);
  const columns = await ensureColumns(ctx.db, companyId, 'main');
  const rows = await ctx.db.select({ t: tasks, u: users }).from(tasks).innerJoin(users, eq(users.id, tasks.assigneeUserId)).where(and(eq(tasks.companyId, companyId), sql`(${tasks.plannedMonth} is null or ${tasks.plannedMonth} >= ${current})`));
  const counts = await cardCounts(ctx.db, rows.map(r => r.t.id));
  const months = await ctx.db.select().from(projectMonths).where(and(eq(projectMonths.companyId, companyId), eq(projectMonths.archived, false), eq(projectMonths.deleted, false)));
  for (const period of months) {
    const selected = rows.filter(({ t }) => t.projectId === period.projectId && (t.plannedMonth === period.month || (!t.plannedMonth && period.month === current)));
    const snapshot = { columns, tasks: selected.map(({ t, u }) => ({ ...t, ...counts.get(t.id), assignee: { id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' '), photoUrl: u.photoUrl }, overdue: !closed(t) && t.deadline < ctx.now(), actions: [] })) };
    await ctx.db.update(projectMonths).set({ snapshot }).where(and(eq(projectMonths.projectId, period.projectId), eq(projectMonths.month, period.month)));
  }
}

async function sync(ctx: Ctx, companyId: string, timezone: string) {
  const current = monthAt(ctx.now(), timezone);
  const all = await ctx.db.select().from(projects).where(eq(projects.companyId, companyId));
  for (const p of all) {
    const periods = await ctx.db.select().from(projectMonths).where(eq(projectMonths.projectId, p.id)).orderBy(asc(projectMonths.month));
    // Existing installations start a truthful baseline in the current month.
    if (!periods.length) {
      await ctx.db.insert(projectMonths).values({ companyId, projectId: p.id, month: current }).onConflictDoNothing();
      await ctx.db.update(tasks).set({ plannedMonth: current }).where(and(eq(tasks.companyId, companyId), eq(tasks.projectId, p.id), sql`${tasks.plannedMonth} is null`));
      continue;
    }
    let prior = periods.find(x => !x.archived && x.month < current);
    while (prior && prior.month < current) {
      const next = nextMonth(prior.month);
      const carried: Record<string, unknown>[] = prior.snapshot.tasks.filter(t => !closed(t as { status: string })).map(t => ({ ...t, plannedMonth: next }));
      // Compute overdue at the month boundary even if no requests arrived near midnight.
      const boundary = new Date(`${next}-01T00:00:00Z`);
      const { zonedTime } = await import('@retarget/shared');
      const end = zonedTime(boundary.getUTCFullYear(), boundary.getUTCMonth() + 1, 1, 0, 0, timezone);
      const frozen = { ...prior.snapshot, tasks: prior.snapshot.tasks.map(t => ({ ...t, overdue: !closed(t as { status: string }) && new Date(t.deadline as string) < end })) };
      await ctx.db.update(projectMonths).set({ archived: true, snapshot: frozen }).where(and(eq(projectMonths.projectId, p.id), eq(projectMonths.month, prior.month)));
      await ctx.db.insert(projectMonths).values({ companyId, projectId: p.id, month: next, snapshot: { tasks: [], columns: prior.snapshot.columns } }).onConflictDoNothing();
      const [target] = await ctx.db.select().from(projectMonths).where(and(eq(projectMonths.projectId, p.id), eq(projectMonths.month, next)));
      const merged = [...target!.snapshot.tasks, ...carried.filter(t => !target!.snapshot.tasks.some(x => x.id === t.id))];
      const snapshot = { tasks: merged, columns: target!.snapshot.columns.length ? target!.snapshot.columns : prior.snapshot.columns };
      await ctx.db.update(projectMonths).set({ snapshot }).where(and(eq(projectMonths.projectId, p.id), eq(projectMonths.month, next)));
      await ctx.db.update(tasks).set({ plannedMonth: next }).where(and(eq(tasks.companyId, companyId), eq(tasks.projectId, p.id), eq(tasks.plannedMonth, prior.month), sql`${tasks.status} not in ('DONE','CANCELLED')`));
      prior = { ...target!, snapshot };
    }
    await ctx.db.insert(projectMonths).values({ companyId, projectId: p.id, month: current }).onConflictDoNothing();
  }
}

export async function projectAccess(ctx: Ctx, actor: ResolvedActor, id: string, manage = false) {
  const [p] = await ctx.db.select().from(projects).where(and(eq(projects.companyId, actor.companyId), eq(projects.id, id)));
  if (!p) throw notFound('Loyiha');
  // Project visibility follows the existing project list policy.
  const { listProjects } = await import('./projects.js');
  if (!(await listProjects(ctx, actor)).some(x => x.id === id)) throw notFound('Loyiha');
  if (manage && !actor.roles.some(r => r === 'OWNER' || r === 'ADMIN') && p.managerUserId !== actor.userId) throw new DomainError('FORBIDDEN', 'Faqat admin yoki loyiha mas’uli boshqaradi');
  return p;
}

export async function listProjectMonths(ctx: Ctx, actor: ResolvedActor, id: string) {
  await projectAccess(ctx, actor, id);
  await calendarWrite(ctx, actor, async () => undefined);
  return ctx.db.select({ month: projectMonths.month, archived: projectMonths.archived }).from(projectMonths).where(and(eq(projectMonths.companyId, actor.companyId), eq(projectMonths.projectId, id), eq(projectMonths.deleted, false))).orderBy(asc(projectMonths.month));
}

export async function getProjectMonth(ctx: Ctx, actor: ResolvedActor, id: string, input: string) {
  const month = monthInput.parse(input);
  const p = await projectAccess(ctx, actor, id);
  await calendarWrite(ctx, actor, async () => undefined);
  const [period] = await ctx.db.select().from(projectMonths).where(and(eq(projectMonths.companyId, actor.companyId), eq(projectMonths.projectId, id), eq(projectMonths.month, month), eq(projectMonths.deleted, false)));
  if (!period) throw notFound('Oy');
  const visible = period.snapshot.tasks.filter(t => canSeeTask(actor, t as unknown as TaskRow)).map(t => ({ ...t, project: p.name, projectColor: p.color }));
  return { month, archived: period.archived, tasks: visible, columns: period.snapshot.columns };
}

export async function createProjectMonth(ctx: Ctx, actor: ResolvedActor, id: string, input: string) {
  await projectAccess(ctx, actor, id, true);
  const month = monthInput.parse(input);
  const current = monthAt(ctx.now(), actor.company.timezone);
  if (month < current || Number(month.slice(0, 4)) > Number(current.slice(0, 4)) + 2) throw new DomainError('VALIDATION', 'Joriy yoki yaqin kelgusi oyni tanlang');
  return calendarWrite(ctx, actor, async inner => {
    await inner.db.insert(projectMonths).values({ companyId: actor.companyId, projectId: id, month }).onConflictDoNothing();
    return { month };
  });
}

export async function deleteProjectMonth(ctx: Ctx, actor: ResolvedActor, id: string, input: string) {
  await projectAccess(ctx, actor, id);
  if (!actor.roles.some(r => r === 'OWNER' || r === 'ADMIN')) throw new DomainError('FORBIDDEN', 'Arxivni faqat admin o‘chiradi');
  const month = monthInput.parse(input);
  return calendarWrite(ctx, actor, async inner => {
    const rows = await inner.db.update(projectMonths).set({ deleted: true, snapshot: { tasks: [], columns: [] } }).where(and(eq(projectMonths.companyId, actor.companyId), eq(projectMonths.projectId, id), eq(projectMonths.month, month), eq(projectMonths.archived, true))).returning();
    if (!rows.length) throw new DomainError('VALIDATION', 'Faqat arxivlangan oyni o‘chirish mumkin');
    await audit(inner.db, actor, 'project.archive.delete', 'project', id, { month });
    return { ok: true };
  });
}

export async function runProjectMonths(ctx: Ctx) {
  const all = await ctx.db.select().from(companies);
  for (const c of all) await ctx.db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`calendar:${c.id}`}))`);
    const inner = { ...ctx, db: tx as unknown as Ctx['db'] };
    await sync(inner, c.id, c.timezone);
    await refresh(inner, c.id, c.timezone);
  });
}
