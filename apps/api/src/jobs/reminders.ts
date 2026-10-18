import { and, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { buildReminderPlan, resolveDueSteps, type ReminderStep } from '@retarget/shared';
import { companies, departments, memberships, projects, reminderLog, reminderMessages, taskEvents, tasks, users } from '../db/schema.js';
import { reminderPolicyOf, scheduleOf, type Ctx } from '../services/context.js';
import { monthAt } from '../services/projectMonths.js';
import { taskCard } from '../services/tasks.js';

/** Statuses in which the assignee owes work. REVIEW waits on the reviewer, BLOCKED on someone else. */
const NAGGABLE = ['NEW', 'IN_PROGRESS', 'RETURNED'];

/**
 * One tick of the reminder worker (runs every minute). Idempotent: every handled step is written
 * to reminder_log before delivery, so a crash or restart never double-sends; after downtime only
 * the latest reminder plus any escalations go out.
 */
export async function runReminders(ctx: Ctx): Promise<{ sent: number; skipped: number }> {
  const now = ctx.now();
  const horizon = new Date(now.getTime() + 25 * 3_600_000);
  const rows = await ctx.db
    .select({ t: tasks, c: companies, chat: projects.telegramChatId, pmUserId: projects.managerUserId, headUserId: departments.headUserId })
    .from(tasks)
    .innerJoin(companies, eq(companies.id, tasks.companyId))
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(departments, eq(departments.id, tasks.departmentId))
    .where(and(inArray(tasks.status, NAGGABLE), lt(tasks.deadline, horizon)));

  let sent = 0;
  let skipped = 0;
  for (const { t, c, chat, pmUserId, headUserId } of rows) {
    // Planned for a later project month: not due for nagging yet.
    if (t.plannedMonth && t.plannedMonth > monthAt(now, c.timezone)) continue;
    try {
      const r = await remindTask(ctx, now, t, c, chat, pmUserId, headUserId);
      sent += r.sent;
      skipped += r.skipped;
    } catch (err) {
      // One broken task or company never stops everyone else's reminders.
      console.error('[reminders] task failed', t.id, err);
    }
  }
  return { sent, skipped };
}

async function remindTask(
  ctx: Ctx,
  now: Date,
  t: typeof tasks.$inferSelect,
  c: typeof companies.$inferSelect,
  chat: number | null,
  pmUserId: string | null,
  headUserId: string | null,
) {
  let sent = 0;
  let skipped = 0;
  // The manager who hears about it: the project manager, else the reviewer, else the department
  // head. A private 1:1 task is only ever shown to the people in it: its giver or reviewer.
  const candidates = t.isPrivate ? [t.createdBy, t.reviewerUserId] : [pmUserId, t.reviewerUserId, headUserId];
  const managerUserId = candidates.find((id) => id && id !== t.assigneeUserId) ?? null;
  const plan = buildReminderPlan({ deadline: t.deadline, createdAt: t.createdAt }, scheduleOf(c), reminderPolicyOf(c));
  const handled = await ctx.db
    .select({ key: reminderLog.stepKey, at: reminderLog.handledAt, sent: reminderLog.sent })
    .from(reminderLog)
    .where(and(eq(reminderLog.taskId, t.id), eq(reminderLog.deadline, t.deadline)));
  const { send, skip } = resolveDueSteps(plan, now, new Set(handled.map((h) => h.key)));
  if (!send.length && !skip.length) return { sent, skipped };

  const claim = async (key: string, wasSent: boolean) => {
    const r = await ctx.db
      .insert(reminderLog)
      .values({ taskId: t.id, stepKey: key, deadline: t.deadline, sent: wasSent, handledAt: now })
      .onConflictDoNothing()
      .returning({ key: reminderLog.stepKey });
    return r.length > 0;
  };
  for (const key of skip) if (await claim(key, false)) skipped++;

  for (const step of send) {
    // CEO only if nothing moved since the manager was told ("1 soat ichida status o'zgarmasa").
    const managerStep = handled.find((h) => h.key === 'escalate-manager' && h.sent);
    if (step.key === 'escalate-ceo' && managerStep) {
      const [moved] = await ctx.db
        .select({ id: taskEvents.id })
        .from(taskEvents)
        .where(and(eq(taskEvents.taskId, t.id), isNotNull(taskEvents.toStatus), gt(taskEvents.createdAt, managerStep.at)))
        .limit(1);
      if (moved) {
        if (await claim(step.key, false)) skipped++;
        continue;
      }
    }
    if (!(await claim(step.key, true))) continue; // another worker got it
    await deliver(ctx, t.id, c.id, step, chat, managerUserId, t.assigneeUserId, t.isPrivate);
    sent++;
  }
  return { sent, skipped };
}

async function deliver(
  ctx: Ctx,
  taskId: string,
  companyId: string,
  step: ReminderStep,
  groupChatId: number | null,
  managerUserId: string | null,
  assigneeUserId: string,
  isPrivate: boolean,
) {
  const recipients = new Set<string>();
  if (step.audience.includes('ASSIGNEE')) recipients.add(assigneeUserId);
  if (step.audience.includes('MANAGER') && managerUserId && managerUserId !== assigneeUserId) recipients.add(managerUserId);
  if (step.audience.includes('CEO')) {
    const owners = await ctx.db
      .select({ id: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.companyId, companyId), eq(memberships.status, 'ACTIVE'), sql`'OWNER' = any(${memberships.roles})`));
    for (const o of owners) if (o.id !== assigneeUserId) recipients.add(o.id);
  }
  const people = recipients.size
    ? await ctx.db.select({ telegramId: users.telegramId, canDm: users.canDm }).from(users).where(inArray(users.id, [...recipients]))
    : [];
  const previous = await ctx.db.select().from(reminderMessages).where(eq(reminderMessages.taskId, taskId));
  const card = await taskCard(ctx.db, taskId);

  try {
    const messages = await ctx.notifier.sendReminder({
      card,
      step,
      privateChatIds: people.filter((p) => p.canDm).map((p) => p.telegramId),
      includeGroup: step.audience.includes('GROUP') && !!groupChatId && !isPrivate,
      previous: previous.map((p) => ({ chatId: p.chatId, messageId: p.messageId })),
    });
    // Only one live reminder per chat: the notifier deleted the old ones, we keep the new ones.
    await ctx.db.delete(reminderMessages).where(eq(reminderMessages.taskId, taskId));
    if (messages.length) {
      await ctx.db.insert(reminderMessages).values(messages.map((m) => ({ taskId, chatId: m.chatId, messageId: m.messageId })));
    }
  } catch (err) {
    console.error('[reminders] delivery failed', taskId, step.key, err);
  }
}

/** When a task closes, its live reminders are removed from the chats. */
export async function clearReminders(ctx: Ctx, taskId: string, remove: (chatId: number, messageId: number) => Promise<void>) {
  const live = await ctx.db.select().from(reminderMessages).where(eq(reminderMessages.taskId, taskId));
  for (const m of live) await remove(m.chatId, m.messageId).catch(() => undefined);
  await ctx.db.delete(reminderMessages).where(eq(reminderMessages.taskId, taskId));
}
