import { addWorkingHours, nextWorkingMoment, type WorkSchedule } from './worktime.js';

/**
 * Reminder and escalation plan for one task (the "AI assistant" chain, CEO decision 29 Sep 2026).
 * The delivery worker stores which steps were handled and, per chat, the Telegram message id of
 * the last reminder — every new reminder deletes the previous one, so a chat never holds more
 * than one live reminder for a task.
 *
 * Timers count working hours only. Default chain:
 *   before the deadline — 24 h and 2 h nudges to the assignee;
 *   overdue — 3 reminders to the assignee (at the deadline, +2 h, +4 h);
 *   still open 1 working hour after the 3rd → the project manager is told;
 *   status still unchanged 1 working hour after that → the CEO is told.
 */
export type ReminderAudience = 'ASSIGNEE' | 'GROUP' | 'MANAGER' | 'CEO';

export interface ReminderPolicy {
  /** Calendar hours before the deadline to nudge the assignee (moved into working time). */
  beforeDeadlineHours: number[];
  /** Working hours after the deadline for overdue reminders 1, 2, 3 … */
  overdueWorkingHours: number[];
  /** Working hours after the last overdue reminder at which the project manager is told. */
  managerAfterWorkingHours: number;
  /** Working hours after the manager step at which the CEO is told (if the status did not change). */
  ceoAfterWorkingHours: number;
  /** Go straight from the reminders to the CEO. */
  skipManager: boolean;
}

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = {
  beforeDeadlineHours: [24, 2],
  overdueWorkingHours: [0, 2, 4],
  managerAfterWorkingHours: 1,
  ceoAfterWorkingHours: 1,
  skipManager: false,
};

/** Older saved policies used department-head naming; map them onto the current shape. */
export function normalizePolicy(raw: Record<string, unknown> | null | undefined): ReminderPolicy {
  const p = { ...DEFAULT_REMINDER_POLICY };
  if (!raw) return p;
  if (Array.isArray(raw.beforeDeadlineHours)) p.beforeDeadlineHours = raw.beforeDeadlineHours.filter((n): n is number => typeof n === 'number');
  if (Array.isArray(raw.overdueWorkingHours) && raw.overdueWorkingHours.length) p.overdueWorkingHours = raw.overdueWorkingHours.filter((n): n is number => typeof n === 'number');
  if (typeof raw.managerAfterWorkingHours === 'number') p.managerAfterWorkingHours = raw.managerAfterWorkingHours;
  if (typeof raw.ceoAfterWorkingHours === 'number') p.ceoAfterWorkingHours = raw.ceoAfterWorkingHours;
  if (typeof raw.skipManager === 'boolean') p.skipManager = raw.skipManager;
  else if (typeof raw.skipDeptHead === 'boolean') p.skipManager = raw.skipDeptHead;
  return p;
}

export interface ReminderStep {
  key: string;
  at: Date;
  audience: ReminderAudience[];
  /** How many overdue reminders have been sent once this step goes out (0 = not overdue). */
  overdueCount: number;
  escalation: 'NONE' | 'MANAGER' | 'CEO';
}

export function buildReminderPlan(
  task: { deadline: Date; createdAt: Date },
  schedule: WorkSchedule,
  policy: ReminderPolicy = DEFAULT_REMINDER_POLICY,
): ReminderStep[] {
  const steps: ReminderStep[] = [];
  const deadline = task.deadline.getTime();

  for (const h of [...policy.beforeDeadlineHours].sort((a, b) => b - a)) {
    const raw = new Date(deadline - h * 3_600_000);
    if (raw.getTime() <= task.createdAt.getTime()) continue;
    const at = nextWorkingMoment(raw, schedule);
    if (at.getTime() >= deadline) continue;
    // Two nudges shifted into the same working moment would be noise — keep the later one.
    const last = steps[steps.length - 1];
    if (last && last.at.getTime() === at.getTime()) steps.pop();
    steps.push({ key: `before-${h}h`, at, audience: ['ASSIGNEE'], overdueCount: 0, escalation: 'NONE' });
  }

  const overdue = [...policy.overdueWorkingHours].sort((a, b) => a - b);
  overdue.forEach((h, i) => {
    steps.push({ key: `overdue-${i + 1}`, at: addWorkingHours(task.deadline, h, schedule), audience: ['ASSIGNEE', 'GROUP'], overdueCount: i + 1, escalation: 'NONE' });
  });

  const last = overdue[overdue.length - 1] ?? 0;
  const n = overdue.length;
  if (policy.skipManager) {
    steps.push({ key: 'escalate-ceo', at: addWorkingHours(task.deadline, last + policy.managerAfterWorkingHours, schedule), audience: ['CEO'], overdueCount: n, escalation: 'CEO' });
  } else {
    const managerAt = last + policy.managerAfterWorkingHours;
    steps.push({ key: 'escalate-manager', at: addWorkingHours(task.deadline, managerAt, schedule), audience: ['MANAGER'], overdueCount: n, escalation: 'MANAGER' });
    steps.push({ key: 'escalate-ceo', at: addWorkingHours(task.deadline, managerAt + policy.ceoAfterWorkingHours, schedule), audience: ['CEO'], overdueCount: n, escalation: 'CEO' });
  }
  return steps;
}

/**
 * Which steps to send now. After downtime several steps can be due at once; sending them all
 * would spam the chat, so only the latest assignee-facing reminder goes out (the rest are marked
 * skipped). Escalation steps are never skipped — a manager must still hear about it.
 */
export function resolveDueSteps(
  plan: readonly ReminderStep[],
  now: Date,
  alreadyHandled: ReadonlySet<string>,
): { send: ReminderStep[]; skip: string[] } {
  const due = plan.filter((s) => s.at.getTime() <= now.getTime() && !alreadyHandled.has(s.key));
  const escalations = due.filter((s) => s.escalation !== 'NONE');
  const plain = due.filter((s) => s.escalation === 'NONE');
  const latestPlain = plain[plain.length - 1];
  const send = [...(latestPlain && !escalations.length ? [latestPlain] : []), ...escalations];
  const sendKeys = new Set(send.map((s) => s.key));
  return { send, skip: due.filter((s) => !sendKeys.has(s.key)).map((s) => s.key) };
}
