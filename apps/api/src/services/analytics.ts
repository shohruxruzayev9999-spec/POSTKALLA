import { and, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import {
  KPI_TEMPLATES,
  assertNotSelf,
  bonusCoefficient,
  canAccess,
  checkAccess,
  computeKpi,
  computeMotivation,
  localDateString,
  pointsToNextBand,
  workingDatesOfMonth,
  zonedTime,
  type KpiTemplate,
  type MotivationTask,
  type TaskPriority,
  type TaskStatus,
} from '@retarget/shared';
import { z } from 'zod';
import { attendance, departments, kpiRatings, memberships, tasks, users } from '../db/schema.js';
import { notFound, scheduleOf, type Company, type Ctx, type ResolvedActor } from './context.js';
import { audit } from './org.js';

const DAY = 86_400_000;

function monthRange(month: string, tz: string): { from: Date; to: Date; year: number; mon: number } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const from = zonedTime(y, m, 1, 0, 0, tz);
  const to = m === 12 ? zonedTime(y + 1, 1, 1, 0, 0, tz) : zonedTime(y, m + 1, 1, 0, 0, tz);
  return { from, to, year: y, mon: m };
}

export function currentMonth(now: Date, tz: string): string {
  return localDateString(now, tz).slice(0, 7);
}

/** Motivation + KPI for many users in one pass (dashboard, team lists). */
export async function scoresFor(ctx: Ctx, company: Company, userIds: string[], month?: string) {
  if (!userIds.length) return new Map<string, Scores>();
  const schedule = scheduleOf(company);
  const now = ctx.now();
  const m = month ?? currentMonth(now, company.timezone);
  const { from, to, year, mon } = monthRange(m, company.timezone);
  const windowStart = new Date(Math.min(now.getTime() - 31 * DAY, from.getTime()));

  const taskRows = await ctx.db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.companyId, company.id),
        inArray(tasks.assigneeUserId, userIds),
        or(gte(tasks.originalDeadline, windowStart), gte(tasks.completedAt, windowStart)),
      ),
    );
  const att = await ctx.db
    .select()
    .from(attendance)
    .where(and(eq(attendance.companyId, company.id), inArray(attendance.userId, userIds), gte(attendance.day, `${m}-01`), lt(attendance.day, localDateString(to, company.timezone))));
  const ratings = await ctx.db.select().from(kpiRatings).where(and(eq(kpiRatings.companyId, company.id), eq(kpiRatings.month, m), inArray(kpiRatings.userId, userIds)));
  const members = await ctx.db
    .select({ userId: memberships.userId, template: departments.kpiTemplate, joinedAt: memberships.joinedAt })
    .from(memberships)
    .leftJoin(departments, eq(departments.id, memberships.departmentId))
    .where(and(eq(memberships.companyId, company.id), inArray(memberships.userId, userIds)));

  const today = localDateString(now, company.timezone);
  const workDates = workingDatesOfMonth(year, mon, schedule, today);
  const out = new Map<string, Scores>();

  for (const userId of userIds) {
    const mine = taskRows.filter((t) => t.assigneeUserId === userId);
    const motivation = computeMotivation(
      mine.map<MotivationTask>((t) => ({
        originalDeadline: t.originalDeadline,
        completedAt: t.completedAt,
        status: t.status as TaskStatus,
        priority: t.priority as TaskPriority,
      })),
      now,
      schedule,
    );

    const inMonth = (d: Date | null) => !!d && d >= from && d < to;
    const done = mine.filter((t) => t.status === 'DONE' && inMonth(t.completedAt));
    // The plan so far: work that was due by now (or already delivered) — tasks due later this
    // month must not drag the score down on the 5th.
    const planned = mine.filter((t) => t.status !== 'CANCELLED' && inMonth(t.originalDeadline) && (t.originalDeadline <= now || t.status === 'DONE'));
    // Days before someone joined are not absences.
    const member = members.find((x) => x.userId === userId);
    const joined = member ? localDateString(member.joinedAt, company.timezone) : '0000-00-00';
    const myWorkDates = workDates.filter((d) => d >= joined);
    const myAtt = att.filter((a) => a.userId === userId && myWorkDates.includes(a.day));
    const rating = ratings.find((r) => r.userId === userId);
    const templateKey = (member?.template ?? 'DEFAULT') as KpiTemplate;
    const weights = KPI_TEMPLATES[templateKey] ?? KPI_TEMPLATES.DEFAULT;

    const kpi = computeKpi(
      {
        doneTasks: done.length,
        doneOnTime: done.filter((t) => t.completedAt! <= t.originalDeadline).length,
        approvedTasks: done.length,
        approvedFirstPass: done.filter((t) => t.revision === 1).length,
        donePoints: done.reduce((s, t) => s + t.points, 0),
        planPoints: planned.reduce((s, t) => s + t.points, 0),
        workDays: myWorkDates.length,
        onTimeDays: myAtt.filter((a) => a.checkIn && a.lateMinutes <= 0).length,
        managerRating: rating?.rating ?? null,
      },
      weights,
    );
    out.set(userId, {
      motivation,
      kpi: {
        month: m,
        template: templateKey,
        score: kpi.score,
        components: kpi.components,
        weights: kpi.effectiveWeights,
        bonus: kpi.score == null ? 0 : bonusCoefficient(kpi.score),
        toNextBand: kpi.score == null ? null : pointsToNextBand(kpi.score),
      },
      counts: {
        open: mine.filter((t) => !['DONE', 'CANCELLED'].includes(t.status)).length,
        overdue: mine.filter((t) => !['DONE', 'CANCELLED'].includes(t.status) && t.deadline < now).length,
        doneThisMonth: done.length,
        lateDays: myAtt.filter((a) => a.lateMinutes > 0).length,
        presentDays: myAtt.filter((a) => a.checkIn).length,
        workDays: myWorkDates.length,
      },
    });
  }
  return out;
}

export type Scores = {
  motivation: ReturnType<typeof computeMotivation>;
  kpi: {
    month: string;
    template: string;
    score: number | null;
    components: Record<string, number | null>;
    weights: Record<string, number>;
    bonus: number;
    toNextBand: number | null;
  };
  counts: { open: number; overdue: number; doneThisMonth: number; lateDays: number; presentDays: number; workDays: number };
};

/** One dashboard for everyone — what it contains depends on the actor's scope. */
export async function dashboard(ctx: Ctx, actor: ResolvedActor) {
  const rows = await ctx.db
    .select({ userId: memberships.userId, departmentId: memberships.departmentId, position: memberships.position, first: users.firstName, last: users.lastName, photo: users.photoUrl })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, actor.companyId), eq(memberships.status, 'ACTIVE')));
  const visible = rows.filter((r) => canAccess(actor, 'kpi.view', { companyId: actor.companyId, departmentId: r.departmentId, ownerUserIds: [r.userId] }));
  // A PM sees KPI of the people on their projects.
  const scores = await scoresFor(ctx, actor.company, visible.map((r) => r.userId));
  const team = visible.map((r) => ({
    userId: r.userId,
    name: [r.first, r.last].filter(Boolean).join(' '),
    photoUrl: r.photo,
    position: r.position,
    departmentId: r.departmentId,
    ...scores.get(r.userId)!,
  }));

  const now = ctx.now();
  const today = localDateString(now, actor.company.timezone);
  const presentToday = await ctx.db
    .select({ userId: attendance.userId, lateMinutes: attendance.lateMinutes })
    .from(attendance)
    .where(and(eq(attendance.companyId, actor.companyId), eq(attendance.day, today), sql`${attendance.checkIn} is not null`));
  const visibleIds = new Set(visible.map((v) => v.userId));

  const mine = scores.get(actor.userId) ?? (await scoresFor(ctx, actor.company, [actor.userId])).get(actor.userId)!;
  const scored = team.filter((t) => t.motivation.score != null);
  return {
    me: mine,
    team: team.sort((a, b) => (a.motivation.score ?? 101) - (b.motivation.score ?? 101)),
    totals: {
      people: team.length,
      open: team.reduce((s, t) => s + t.counts.open, 0),
      overdue: team.reduce((s, t) => s + t.counts.overdue, 0),
      doneThisMonth: team.reduce((s, t) => s + t.counts.doneThisMonth, 0),
      presentToday: presentToday.filter((p) => visibleIds.has(p.userId)).length,
      lateToday: presentToday.filter((p) => visibleIds.has(p.userId) && p.lateMinutes > 0).length,
      avgMotivation: scored.length ? Math.round(scored.reduce((s, t) => s + t.motivation.score!, 0) / scored.length) : null,
      atRisk: team.filter((t) => t.motivation.stage === 'RISK' || t.motivation.stage === 'LOW').length,
    },
  };
}

export async function memberScores(ctx: Ctx, actor: ResolvedActor, userId: string, month?: string) {
  const [m] = await ctx.db.select().from(memberships).where(and(eq(memberships.companyId, actor.companyId), eq(memberships.userId, userId)));
  if (!m) throw notFound('Hodim');
  checkAccess(actor, 'kpi.view', { companyId: actor.companyId, departmentId: m.departmentId, ownerUserIds: [userId] });
  return (await scoresFor(ctx, actor.company, [userId], month)).get(userId)!;
}

export const rateInput = z.object({
  userId: z.string().uuid(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  rating: z.number().min(1).max(5),
  comment: z.string().trim().max(500).optional(),
});

export async function rateMember(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof rateInput>) {
  const data = rateInput.parse(input);
  const [m] = await ctx.db.select().from(memberships).where(and(eq(memberships.companyId, actor.companyId), eq(memberships.userId, data.userId)));
  if (!m) throw notFound('Hodim');
  checkAccess(actor, 'kpi.rate', { companyId: actor.companyId, departmentId: m.departmentId });
  assertNotSelf(actor, 'kpi.rate', data.userId);
  const values = { rating: data.rating, comment: data.comment ?? null, ratedBy: actor.userId };
  await ctx.db
    .insert(kpiRatings)
    .values({ companyId: actor.companyId, userId: data.userId, month: data.month, ...values })
    .onConflictDoUpdate({ target: [kpiRatings.companyId, kpiRatings.userId, kpiRatings.month], set: values });
  await audit(ctx.db, actor, 'kpi.rate', 'membership', m.id, { month: data.month, rating: data.rating });
}
