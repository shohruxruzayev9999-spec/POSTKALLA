import { and, asc, desc, eq, inArray, max, sql } from 'drizzle-orm';
import { checkAccess, localDateString } from '@retarget/shared';
import { z } from 'zod';
import { auditLog, financeRows, projects, users } from '../db/schema.js';
import { notFound, type Ctx, type ResolvedActor } from './context.js';
import { audit } from './org.js';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Oy YYYY-MM ko‘rinishida');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.coerce.number().int().min(0).max(1e13);

type Row = typeof financeRows.$inferSelect;
export type FinanceStatus = 'PAID' | 'PARTIAL' | 'OVERDUE' | 'UNPAID';

/** Derived, never stored: PAID ≥ amount, OVERDUE when the due date passed with money still owed. */
export function statusOf(r: Pick<Row, 'amount' | 'paid' | 'dueDate'>, today: string): FinanceStatus {
  if (r.amount > 0 && r.paid >= r.amount) return 'PAID';
  if (r.dueDate && r.dueDate < today) return 'OVERDUE';
  return r.paid > 0 ? 'PARTIAL' : 'UNPAID';
}

const view = (actor: ResolvedActor) => checkAccess(actor, 'finance.view', { companyId: actor.companyId });
const manage = (actor: ResolvedActor) => checkAccess(actor, 'finance.manage', { companyId: actor.companyId });

function shape(r: Row & { project?: string | null }, today: string) {
  return { ...r, debt: Math.max(0, r.amount - r.paid), status: statusOf(r, today) };
}

export async function financeMonth(ctx: Ctx, actor: ResolvedActor, q: { month: string }) {
  view(actor);
  const m = month.parse(q.month);
  const today = localDateString(ctx.now(), actor.company.timezone);
  const rows = await ctx.db
    .select({ r: financeRows, project: projects.name })
    .from(financeRows)
    .leftJoin(projects, eq(projects.id, financeRows.projectId))
    .where(and(eq(financeRows.companyId, actor.companyId), eq(financeRows.month, m)))
    .orderBy(asc(financeRows.kind), asc(financeRows.position), asc(financeRows.createdAt));
  const list = rows.map(({ r, project }) => shape({ ...r, project }, today));
  const income = list.filter((r) => r.kind === 'INCOME');
  const expense = list.filter((r) => r.kind === 'EXPENSE');
  const sum = (xs: typeof list, k: 'amount' | 'paid' | 'debt') => xs.reduce((a, r) => a + r[k], 0);
  const summary = {
    expected: sum(income, 'amount'),
    received: sum(income, 'paid'),
    receivable: sum(income, 'debt'),
    overdue: income.filter((r) => r.status === 'OVERDUE').reduce((a, r) => a + r.debt, 0),
    expenses: sum(expense, 'amount'),
    expensesPaid: sum(expense, 'paid'),
    payable: sum(expense, 'debt'),
    /** Cash result of the month: money in minus money out. */
    profit: sum(income, 'paid') - sum(expense, 'paid'),
    /** Planned result if everyone pays and every bill is paid. */
    plannedProfit: sum(income, 'amount') - sum(expense, 'amount'),
    collectedPct: sum(income, 'amount') ? Math.round((sum(income, 'paid') / sum(income, 'amount')) * 100) : null,
    counts: { PAID: 0, PARTIAL: 0, OVERDUE: 0, UNPAID: 0 } as Record<FinanceStatus, number>,
  };
  for (const r of income) summary.counts[r.status]++;
  return { month: m, rows: list, summary, debtors: await debtors(ctx, actor, today) };
}

/** Everyone who still owes money, across all months, largest first. */
async function debtors(ctx: Ctx, actor: ResolvedActor, today: string) {
  const rows = await ctx.db
    .select()
    .from(financeRows)
    .where(and(eq(financeRows.companyId, actor.companyId), eq(financeRows.kind, 'INCOME'), sql`${financeRows.paid} < ${financeRows.amount}`));
  const by = new Map<string, { party: string; debt: number; overdue: number; months: string[]; oldestDue: string | null }>();
  for (const r of rows) {
    const key = r.party.trim().toLowerCase() || '—';
    const d = by.get(key) ?? { party: r.party.trim() || 'Nomsiz', debt: 0, overdue: 0, months: [], oldestDue: null };
    const debt = r.amount - r.paid;
    d.debt += debt;
    if (statusOf(r, today) === 'OVERDUE') d.overdue += debt;
    if (!d.months.includes(r.month)) d.months.push(r.month);
    if (r.dueDate && (!d.oldestDue || r.dueDate < d.oldestDue)) d.oldestDue = r.dueDate;
    by.set(key, d);
  }
  return [...by.values()]
    .map((d) => ({ ...d, months: d.months.sort(), overdueDays: d.oldestDue && d.oldestDue < today ? Math.round((Date.parse(today) - Date.parse(d.oldestDue)) / 86_400_000) : 0 }))
    .sort((a, b) => b.overdue - a.overdue || b.debt - a.debt);
}

export const rowInput = z.object({
  kind: z.enum(['INCOME', 'EXPENSE']).default('INCOME'),
  month,
  projectId: z.string().uuid().nullable().optional(),
  party: z.string().trim().max(120).default(''),
  title: z.string().trim().max(200).default(''),
  amount: money.default(0),
  paid: money.default(0),
  dueDate: day.nullable().optional(),
  paidAt: day.nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

async function assertProject(ctx: Ctx, actor: ResolvedActor, projectId: string | null | undefined) {
  if (!projectId) return;
  const [p] = await ctx.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, actor.companyId)));
  if (!p) throw notFound('Loyiha');
}

export async function createRow(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof rowInput>) {
  manage(actor);
  const data = rowInput.parse(input);
  await assertProject(ctx, actor, data.projectId);
  const [{ n }] = (await ctx.db
    .select({ n: max(financeRows.position) })
    .from(financeRows)
    .where(and(eq(financeRows.companyId, actor.companyId), eq(financeRows.month, data.month), eq(financeRows.kind, data.kind)))) as [{ n: number | null }];
  const now = ctx.now();
  const [r] = await ctx.db
    .insert(financeRows)
    .values({ ...data, projectId: data.projectId ?? null, companyId: actor.companyId, position: (n ?? -1) + 1, createdBy: actor.userId, createdAt: now, updatedAt: now })
    .returning();
  await audit(ctx.db, actor, 'finance.create', 'finance_row', r!.id, { ...data });
  return shape(r!, localDateString(now, actor.company.timezone));
}

// No defaults here: a partial edit must never reset fields it did not mention.
const patchInput = z.object({
  month: month.optional(),
  projectId: z.string().uuid().nullable().optional(),
  party: z.string().trim().max(120).optional(),
  title: z.string().trim().max(200).optional(),
  amount: money.optional(),
  paid: money.optional(),
  dueDate: day.nullable().optional(),
  paidAt: day.nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

export async function updateRow(ctx: Ctx, actor: ResolvedActor, id: string, input: z.input<typeof patchInput>) {
  manage(actor);
  const [before] = await ctx.db.select().from(financeRows).where(and(eq(financeRows.id, id), eq(financeRows.companyId, actor.companyId)));
  if (!before) throw notFound('Qator');
  const data = patchInput.parse(input);
  if ('projectId' in data) await assertProject(ctx, actor, data.projectId);
  const today = localDateString(ctx.now(), actor.company.timezone);
  // Paying in full stamps the payment date unless one was given.
  const paidNow = data.paid != null && data.paid >= (data.amount ?? before.amount) && before.paid < before.amount && data.paidAt === undefined && !before.paidAt;
  const [r] = await ctx.db
    .update(financeRows)
    .set({ ...data, ...(paidNow ? { paidAt: today } : {}), updatedAt: ctx.now() })
    .where(eq(financeRows.id, id))
    .returning();
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(data)) {
    const old = before[k as keyof Row];
    if (old !== v) changes[k] = { from: old, to: v };
  }
  if (Object.keys(changes).length) await audit(ctx.db, actor, 'finance.update', 'finance_row', id, changes);
  return shape(r!, today);
}

export async function deleteRow(ctx: Ctx, actor: ResolvedActor, id: string) {
  manage(actor);
  const [r] = await ctx.db.delete(financeRows).where(and(eq(financeRows.id, id), eq(financeRows.companyId, actor.companyId))).returning();
  if (!r) throw notFound('Qator');
  await audit(ctx.db, actor, 'finance.delete', 'finance_row', id, { party: r.party, title: r.title, amount: r.amount, paid: r.paid, month: r.month });
}

/** Monthly retainers: copy last month's lines (unpaid, due dates moved a month) into this month. */
export async function copyMonth(ctx: Ctx, actor: ResolvedActor, input: { from: string; to: string; kind?: 'INCOME' | 'EXPENSE' }) {
  manage(actor);
  const from = month.parse(input.from);
  const to = month.parse(input.to);
  const conds = [eq(financeRows.companyId, actor.companyId), eq(financeRows.month, from)];
  if (input.kind) conds.push(eq(financeRows.kind, input.kind));
  const src = await ctx.db.select().from(financeRows).where(and(...conds)).orderBy(asc(financeRows.position));
  const existing = await ctx.db
    .select({ party: financeRows.party, title: financeRows.title, kind: financeRows.kind })
    .from(financeRows)
    .where(and(eq(financeRows.companyId, actor.companyId), eq(financeRows.month, to)));
  const has = new Set(existing.map((e) => `${e.kind}|${e.party}|${e.title}`));
  const shiftDue = (d: string | null) => {
    if (!d) return null;
    const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const nm = new Date(Date.UTC(y, m, 1));
    return `${nm.getUTCFullYear()}-${String(nm.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(dd, last)).padStart(2, '0')}`;
  };
  const now = ctx.now();
  const fresh = src.filter((r) => !has.has(`${r.kind}|${r.party}|${r.title}`));
  if (!fresh.length) return { copied: 0 };
  await ctx.db.insert(financeRows).values(
    fresh.map((r, i) => ({
      companyId: actor.companyId,
      kind: r.kind,
      month: to,
      projectId: r.projectId,
      party: r.party,
      title: r.title,
      amount: r.amount,
      paid: 0,
      dueDate: shiftDue(r.dueDate),
      note: null,
      position: existing.length + i,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    })),
  );
  await audit(ctx.db, actor, 'finance.copy', 'finance_row', null, { from, to, copied: fresh.length });
  return { copied: fresh.length };
}

/** Who changed what on a row — money edits must be traceable. */
export async function rowHistory(ctx: Ctx, actor: ResolvedActor, id: string) {
  view(actor);
  return ctx.db
    .select({ id: auditLog.id, action: auditLog.action, data: auditLog.data, createdAt: auditLog.createdAt, name: users.firstName })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(and(eq(auditLog.companyId, actor.companyId), eq(auditLog.entity, 'finance_row'), eq(auditLog.entityId, id)))
    .orderBy(desc(auditLog.createdAt))
    .limit(50);
}

/** Month-by-month totals for the chart (last 12 months). */
export async function financeTrend(ctx: Ctx, actor: ResolvedActor, q: { until: string }) {
  view(actor);
  const until = month.parse(q.until);
  const [y, m] = until.split('-').map(Number) as [number, number];
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 12 + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
  const rows = await ctx.db
    .select({
      month: financeRows.month,
      kind: financeRows.kind,
      amount: sql<number>`sum(${financeRows.amount})::float8`,
      paid: sql<number>`sum(${financeRows.paid})::float8`,
    })
    .from(financeRows)
    .where(and(eq(financeRows.companyId, actor.companyId), inArray(financeRows.month, months)))
    .groupBy(financeRows.month, financeRows.kind);
  return months.map((mo) => {
    const inc = rows.find((r) => r.month === mo && r.kind === 'INCOME');
    const exp = rows.find((r) => r.month === mo && r.kind === 'EXPENSE');
    return { month: mo, expected: inc?.amount ?? 0, received: inc?.paid ?? 0, expenses: exp?.paid ?? 0 };
  });
}
