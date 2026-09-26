import { addWorkingHours, nextWorkingMoment, type WorkSchedule } from './worktime.js';

/**
 * Reminder and escalation plan for one task. The delivery worker stores which steps were sent
 * and, per chat, the Telegram message id of the last reminder — every new reminder deletes the
 * previous one, so a chat never holds more than one live reminder for a task.
 *
 * Overdue timers count working hours only. The default chain: at the deadline, +2 h, +4 h
 * (department head joins), +6 h (CEO). With `skipDeptHead` the CEO joins at the third reminder.
 */
export type ReminderAudience = 'ASSIGNEE' | 'GROUP' | 'DEPT_HEAD' | 'CEO';

export interface ReminderPolicy {
  /** Calendar hours before the deadline to nudge the assignee (moved into working time). */
  beforeDeadlineHours: number[];
  /** Working hours after the deadline for overdue reminders 1, 2, 3 … */
  overdueWorkingHours: number[];
  /** 1-based index of the overdue reminder at which escalation starts. */
  escalateAtReminder: number;
  /** Working hours after the escalation reminder at which the CEO is told. */
  ceoAfterWorkingHours: number;
  skipDeptHead: boolean;
}

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = {
  beforeDeadlineHours: [24, 2],
  overdueWorkingHours: [0, 2, 4],
  escalateAtReminder: 3,
  ceoAfterWorkingHours: 2,
  skipDeptHead: false,
};

export interface ReminderStep {
  key: string;
  at: Date;
  audience: ReminderAudience[];
  /** How many overdue reminders have been sent once this step goes out (0 = not overdue). */
  overdueCount: number;
  escalation: 'NONE' | 'DEPT_HEAD' | 'CEO';
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

  policy.overdueWorkingHours.forEach((h, i) => {
    const n = i + 1;
    const escalate = n >= policy.escalateAtReminder;
    const audience: ReminderAudience[] = ['ASSIGNEE', 'GROUP'];
    let escalation: ReminderStep['escalation'] = 'NONE';
    if (escalate) {
      escalation = policy.skipDeptHead ? 'CEO' : 'DEPT_HEAD';
      audience.push(escalation);
    }
    steps.push({ key: `overdue-${n}`, at: addWorkingHours(task.deadline, h, schedule), audience, overdueCount: n, escalation });
  });

  if (!policy.skipDeptHead) {
    const lastOverdue = policy.overdueWorkingHours[policy.overdueWorkingHours.length - 1] ?? 0;
    steps.push({
      key: 'escalate-ceo',
      at: addWorkingHours(task.deadline, lastOverdue + policy.ceoAfterWorkingHours, schedule),
      audience: ['CEO'],
      overdueCount: policy.overdueWorkingHours.length,
      escalation: 'CEO',
    });
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
