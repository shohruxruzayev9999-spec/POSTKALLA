/**
 * Repeating tasks (weekly report, monthly content plan). A repeating task is an ordinary task;
 * when its deadline passes or it is closed, the next one is created with the deadline moved by
 * one period, at the same local time.
 */
import { isWorkingDay, localParts, zonedTime, type WorkSchedule } from './worktime.js';

export const RECURRENCES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export const RECURRENCE_LABEL: Record<Recurrence, string> = {
  DAILY: 'Har kuni',
  WEEKLY: 'Har hafta',
  MONTHLY: 'Har oy',
};

function weekdayOf(y: number, m: number, d: number): number {
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

function step(y: number, m: number, d: number, rule: Recurrence, anchorDay: number, n: number) {
  if (rule === 'MONTHLY') {
    const first = new Date(Date.UTC(y, m - 1 + n, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return { y: first.getUTCFullYear(), m: first.getUTCMonth() + 1, d: Math.min(anchorDay, last) };
  }
  const t = new Date(Date.UTC(y, m - 1, d + (rule === 'WEEKLY' ? 7 : 1) * n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * The deadline of the next task in the series: one period after `previous`, the same local time,
 * moved forward to a working day, and strictly after `after` (a series that was off for weeks
 * resumes from now instead of creating every missed copy).
 */
export function nextOccurrence(previous: Date, rule: Recurrence, schedule: WorkSchedule, after: Date): Date {
  const tz = schedule.timezone;
  const p = localParts(previous, tz);
  for (let n = 1; n < 1000; n++) {
    let day = step(p.year, p.month, p.day, rule, p.day, n);
    // A day off moves forward to the next working day (a holiday never swallows a period).
    for (let i = 0; i < 14 && !isWorkingDay({ y: day.y, m: day.m, d: day.d, weekday: weekdayOf(day.y, day.m, day.d) }, schedule); i++) {
      const t = new Date(Date.UTC(day.y, day.m - 1, day.d + 1));
      day = { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
    }
    const at = zonedTime(day.y, day.m, day.d, p.hour, p.minute, tz);
    if (at > after && at > previous) return at;
  }
  throw new Error('nextOccurrence: no date found');
}
