import type { TaskPriority, TaskStatus } from './tasks.js';
import { workingHoursBetween, type WorkSchedule } from './worktime.js';

/**
 * Motivation score (0–100): how well deadlines were kept over the last 30 days.
 *
 *   M = 100 · Σ wᵢ·sᵢ / Σ wᵢ
 *
 * sᵢ = 1 for a task done by its deadline, 1 − h/48 for a task done h working hours late,
 * 1 − h/24 for a task still open h working hours past its deadline (never below 0).
 * wᵢ comes from priority. The ORIGINAL deadline is used, so moving a deadline never
 * improves the score.
 */
export interface MotivationTask {
  originalDeadline: Date;
  completedAt: Date | null;
  status: TaskStatus;
  priority: TaskPriority;
}

export type MotivationStage = 'EXCELLENT' | 'GOOD' | 'WATCH' | 'RISK' | 'LOW';

export interface MotivationResult {
  /** null when no deadline fell inside the window — nothing to judge yet. */
  score: number | null;
  stage: MotivationStage | null;
  onTime: number;
  doneLate: number;
  openOverdue: number;
  averageLateHours: number;
}

export const PRIORITY_WEIGHT: Record<TaskPriority, number> = { HIGH: 2, MEDIUM: 1.5, LOW: 1 };
export const LATE_DONE_ZERO_AT_HOURS = 48;
export const OPEN_OVERDUE_ZERO_AT_HOURS = 24;

export function motivationStage(score: number): MotivationStage {
  if (score >= 85) return 'EXCELLENT';
  if (score >= 70) return 'GOOD';
  if (score >= 50) return 'WATCH';
  if (score >= 30) return 'RISK';
  return 'LOW';
}

/** Who gets told when a person's score lands in a stage. */
export function motivationAlertAudience(stage: MotivationStage): Array<'SELF' | 'DEPT_HEAD' | 'CEO'> {
  switch (stage) {
    case 'WATCH':
      return ['SELF'];
    case 'RISK':
      return ['SELF', 'DEPT_HEAD'];
    case 'LOW':
      return ['SELF', 'DEPT_HEAD', 'CEO'];
    default:
      return [];
  }
}

export function computeMotivation(
  tasks: readonly MotivationTask[],
  now: Date,
  schedule: WorkSchedule,
  windowDays = 30,
): MotivationResult {
  const windowStart = now.getTime() - windowDays * 24 * 3_600_000;
  let weighted = 0;
  let weights = 0;
  let onTime = 0;
  let doneLate = 0;
  let openOverdue = 0;
  let lateHoursSum = 0;
  let lateCount = 0;

  for (const t of tasks) {
    if (t.status === 'CANCELLED') continue;
    const deadline = t.originalDeadline.getTime();
    if (deadline <= windowStart || deadline > now.getTime()) continue;

    const w = PRIORITY_WEIGHT[t.priority];
    let s: number;
    if (t.status === 'DONE' && t.completedAt) {
      const late = workingHoursBetween(t.originalDeadline, t.completedAt, schedule);
      if (late <= 0) {
        s = 1;
        onTime++;
      } else {
        s = Math.max(0, 1 - late / LATE_DONE_ZERO_AT_HOURS);
        doneLate++;
        lateHoursSum += late;
        lateCount++;
      }
    } else {
      const late = workingHoursBetween(t.originalDeadline, now, schedule);
      s = Math.max(0, 1 - late / OPEN_OVERDUE_ZERO_AT_HOURS);
      if (late > 0) {
        openOverdue++;
        lateHoursSum += late;
        lateCount++;
      } else {
        // Deadline passed outside working hours and no working time has elapsed yet.
        onTime++;
        s = 1;
      }
    }
    weighted += w * s;
    weights += w;
  }

  if (weights === 0) {
    return { score: null, stage: null, onTime, doneLate, openOverdue, averageLateHours: 0 };
  }
  const score = Math.round((100 * weighted) / weights);
  return {
    score,
    stage: motivationStage(score),
    onTime,
    doneLate,
    openOverdue,
    averageLateHours: lateCount ? Math.round((lateHoursSum / lateCount) * 10) / 10 : 0,
  };
}
