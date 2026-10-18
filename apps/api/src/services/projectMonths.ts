import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DomainError, allowedActions, localParts, zonedTime, type TaskStatus } from '@retarget/shared';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { companies, projects, projectMonths, tasks, users } from '../db/schema.js';
import { type Ctx, type ResolvedActor, notFound } from './context.js';
import { ensureColumns, cardCounts } from './boards.js';
import { canSeeTask, relationFor, type TaskRow } from './tasks.js';
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
/** First instant of the month after `month`, in the company's timezone. */
function monthEnd(month: string, timezone: string) {
  const [y, m] = nextMonth(month).split('-').map(Number);
  return zonedTime(y!, m!, 1, 0, 0, timezone);
}
const CLOSED = ['DONE', 'CANCELLED'];
const closed = (t: { status: string }) => CLOSED.includes(t.status);
const lockKey = (companyId: string) => sql`hashtext(${`calendar:${companyId}`})`;

/** companyId → the month this process last rolled the company's calendar to. */
const rolled = new Map<string, string>();

/**
 * Every task/board mutation runs here. Month rollover takes the company lock exclusively, but
 * only when the month actually changed; ordinary writes share it, so they never queue behind
 * each other. Telegram and other side effects run after the commit (`afterCommit`), never while
 * a transaction or lock is held.
 */
export async function calendarWrite<T>(ctx: Ctx, actor: ResolvedActor, work: (ctx: Ctx) => Promise<T>): Promise<T> {
  if (ctx.afterCommit) return work(ctx);
  await rollover(ctx, actor.companyId, actor.company.timezone);
  const effects: Array<(ctx: Ctx) => Promise<unknown>> = [];
  const result = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${lockKey(actor.companyId)})`);
    return work({ ...ctx, db: tx as unknown as Db, afterCommit: (fn) => void effects.push(fn) });
  });
  for (const fn of effects) {
    try {
      await fn(ctx);
    } catch (err) {
      console.error('[afterCommit]', err);
    }
  }
  return result;
}

/** Runs `fn` after the surrounding calendarWrite commits, or right away outside one. */
export async function afterCommit(ctx: Ctx, fn: (ctx: Ctx) => Promise<unknown>): Promise<void> {
  if (ctx.afterCommit) return ctx.afterCommit(fn);
  await fn(ctx);
}

async function rollover(ctx: Ctx, companyId: string, timezone: string) {
  const current = monthAt(ctx.now(), timezone);
  if (rolled.get(companyId) === current) return;
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(companyId)})`);
    await sync(tx as unknown as Db, companyId, timezone, current, ctx.now());
  });
  rolled.set(companyId, current);
}

/** Board cards of one project month, built from the live tasks table. */
async function monthCards(db: Db, projectId: string, month: string, current: string) {
  const rows = await db
    .select({ t: tasks, u: users })
    .from(tasks)
    .innerJoin(users, eq(users.id, tasks.assigneeUserId))
    .where(and(eq(tasks.projectId, projectId), month === current ? sql`(${tasks.plannedMonth} = ${month} or ${tasks.plannedMonth} is null)` : eq(tasks.plannedMonth, month)))
    .orderBy(asc(tasks.deadline));
  const counts = await cardCounts(db, rows.map((r) => r.t.id));
  return rows.map(({ t, u }) => ({ t, card: { ...t, ...counts.get(t.id), assignee: { id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' '), photoUrl: u.photoUrl } } }));
}

/** Freezes `month` as it stands now (once — an archive never changes); overdue is judged at the month's end. */
async function archiveMonth(db: Db, companyId: string, projectId: string, month: string, timezone: string, now: Date) {
  const end = monthEnd(month, timezone);
  const at = now < end ? now : end;
  const cards = (await monthCards(db, projectId, month, '')).map(({ t, card }) => ({ ...card, overdue: !closed(t) && t.deadline < at, actions: [] }));
  const columns = await ensureColumns(db, companyId, 'main');
  await db
    .insert(projectMonths)
    .values({ companyId, projectId, month, archived: true, snapshot: { tasks: cards, columns } })
    .onConflictDoUpdate({ target: [projectMonths.projectId, projectMonths.month], set: { archived: true, snapshot: { tasks: cards, columns } }, where: sql`not ${projectMonths.archived}` });
}

/** Month of a closed task: when it was finished. */
const closedMonth = (t: TaskRow, timezone: string) => monthAt(t.completedAt ?? t.updatedAt, timezone);

async function sync(db: Db, companyId: string, timezone: string, current: string, now: Date) {
  const all = await db.select().from(projects).where(eq(projects.companyId, companyId));
  for (const p of all) {
    const periods = await db.select().from(projectMonths).where(eq(projectMonths.projectId, p.id)).orderBy(asc(projectMonths.month));
    if (!periods.length) {
      // First run for this project: closed work goes to the month it was finished in, open work
      // to the current month. Those past months are archived from the real task rows.
      const loose = await db.select().from(tasks).where(and(eq(tasks.projectId, p.id), sql`${tasks.plannedMonth} is null`));
      const past = new Map<string, string[]>();
      for (const t of loose) {
        const m = closed(t) ? closedMonth(t, timezone) : current;
        if (m < current) past.set(m, [...(past.get(m) ?? []), t.id]);
      }
      for (const [m, ids] of past) await db.update(tasks).set({ plannedMonth: m }).where(inArray(tasks.id, ids));
      await db.update(tasks).set({ plannedMonth: current }).where(and(eq(tasks.projectId, p.id), sql`${tasks.plannedMonth} is null`));
      for (const m of past.keys()) await archiveMonth(db, companyId, p.id, m, timezone, now);
      await db.insert(projectMonths).values({ companyId, projectId: p.id, month: current }).onConflictDoNothing();
      continue;
    }
    await repairBaseline(db, companyId, p.id, periods[0]!, timezone, now);
    // Catch up month by month, even after an outage of several months.
    for (let m = periods.find((x) => !x.archived && x.month < current)?.month; m && m < current; m = nextMonth(m)) {
      await archiveMonth(db, companyId, p.id, m, timezone, now);
      await db
        .update(tasks)
        .set({ plannedMonth: nextMonth(m) })
        .where(and(eq(tasks.projectId, p.id), eq(tasks.plannedMonth, m), sql`${tasks.status} not in ('DONE','CANCELLED')`));
    }
    await db.insert(projectMonths).values({ companyId, projectId: p.id, month: current }).onConflictDoNothing();
  }
}

/**
 * Before this fix the first run put every older closed task into the first month. Such a task
 * can be recognised: it was finished before that month began, which no task planned for it
 * can be. It moves to the month it was finished in.
 */
async function repairBaseline(db: Db, companyId: string, projectId: string, first: typeof projectMonths.$inferSelect, timezone: string, now: Date) {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.plannedMonth, first.month), inArray(tasks.status, CLOSED)));
  const early = rows.filter((t) => closedMonth(t, timezone) < first.month);
  if (!early.length) return;
  const moved = new Map<string, string[]>();
  for (const t of early) moved.set(closedMonth(t, timezone), [...(moved.get(closedMonth(t, timezone)) ?? []), t.id]);
  for (const [m, ids] of moved) await db.update(tasks).set({ plannedMonth: m }).where(inArray(tasks.id, ids));
  for (const m of moved.keys()) await archiveMonth(db, companyId, projectId, m, timezone, now);
  if (first.archived && !first.deleted) {
    const ids = new Set(early.map((t) => t.id));
    const snapshot = { ...first.snapshot, tasks: first.snapshot.tasks.filter((t) => !ids.has(t.id as string)) };
    await db.update(projectMonths).set({ snapshot }).where(and(eq(projectMonths.projectId, projectId), eq(projectMonths.month, first.month)));
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
  await rollover(ctx, actor.companyId, actor.company.timezone);
  // A project created after this month's rollover gets its current month here.
  await ctx.db.insert(projectMonths).values({ companyId: actor.companyId, projectId: id, month: monthAt(ctx.now(), actor.company.timezone) }).onConflictDoNothing();
  return ctx.db.select({ month: projectMonths.month, archived: projectMonths.archived }).from(projectMonths).where(and(eq(projectMonths.companyId, actor.companyId), eq(projectMonths.projectId, id), eq(projectMonths.deleted, false))).orderBy(asc(projectMonths.month));
}

export async function getProjectMonth(ctx: Ctx, actor: ResolvedActor, id: string, input: string) {
  const month = monthInput.parse(input);
  const p = await projectAccess(ctx, actor, id);
  await rollover(ctx, actor.companyId, actor.company.timezone);
  const current = monthAt(ctx.now(), actor.company.timezone);
  const [period] = await ctx.db.select().from(projectMonths).where(and(eq(projectMonths.companyId, actor.companyId), eq(projectMonths.projectId, id), eq(projectMonths.month, month), eq(projectMonths.deleted, false)));
  if (!period && month !== current) throw notFound('Oy');
  const extra = { project: p.name, projectColor: p.color };
  if (period?.archived) {
    const visible = period.snapshot.tasks.filter((t) => canSeeTask(actor, t as unknown as TaskRow)).map((t) => ({ ...t, ...extra }));
    return { month, archived: true, tasks: visible, columns: period.snapshot.columns };
  }
  // Open months are read live; only a finished month is stored.
  const cards = (await monthCards(ctx.db, id, month, current))
    .filter(({ t }) => canSeeTask(actor, t))
    .map(({ t, card }) => ({
      ...card,
      ...extra,
      overdue: !closed(t) && t.deadline < ctx.now(),
      actions: allowedActions({ status: t.status as TaskStatus, revision: t.revision, currentRevisionFileCount: 1, requireFileOnSubmit: false }, relationFor(actor, t)),
    }));
  return { month, archived: false, tasks: cards, columns: await ensureColumns(ctx.db, actor.companyId, 'main') };
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

/** Minute worker: rolls each company over once per month; one company's failure skips only it. */
export async function runProjectMonths(ctx: Ctx) {
  const all = await ctx.db.select().from(companies);
  for (const c of all) {
    try {
      await rollover(ctx, c.id, c.timezone);
    } catch (err) {
      console.error('[project-months]', c.id, err);
    }
  }
}
