import { describe, expect, it } from 'vitest';
import { computeMotivation, motivationAlertAudience, type MotivationTask } from './motivation.js';
import { DEFAULT_SCHEDULE, zonedTime } from './worktime.js';

const tk = (m: number, d: number, h: number) => zonedTime(2026, m, d, h, 0, 'Asia/Tashkent');
const now = tk(9, 26, 12); // Saturday noon

const done = (deadline: Date, completedAt: Date, priority: MotivationTask['priority'] = 'MEDIUM'): MotivationTask => ({
  originalDeadline: deadline,
  completedAt,
  status: 'DONE',
  priority,
});

describe('motivation (deadline discipline)', () => {
  it('is 100 when every deadline was kept', () => {
    const r = computeMotivation([done(tk(9, 20, 18), tk(9, 20, 15)), done(tk(9, 22, 18), tk(9, 22, 17))], now, DEFAULT_SCHEDULE);
    expect(r).toMatchObject({ score: 100, stage: 'EXCELLENT', onTime: 2, doneLate: 0 });
  });

  it('a task done 24 working hours late scores half', () => {
    // Deadline Mon 21 Sep 18:00; 24 working hours later = Thu 24 Sep 18:00.
    const r = computeMotivation([done(tk(9, 21, 18), tk(9, 24, 18))], now, DEFAULT_SCHEDULE);
    expect(r.score).toBe(50);
    expect(r.averageLateHours).toBe(24);
  });

  it('an open overdue task falls twice as fast', () => {
    // Deadline Fri 25 Sep 14:00, still open Sat 12:00 → 4 + 2 = 6 working hours late → 1 − 6/24.
    const r = computeMotivation([{ originalDeadline: tk(9, 25, 14), completedAt: null, status: 'IN_PROGRESS', priority: 'LOW' }], now, DEFAULT_SCHEDULE);
    expect(r.score).toBe(75);
    expect(r.openOverdue).toBe(1);
  });

  it('weights high-priority tasks more', () => {
    const r = computeMotivation(
      [done(tk(9, 21, 18), tk(9, 21, 17), 'HIGH'), { originalDeadline: tk(9, 22, 10), completedAt: null, status: 'IN_PROGRESS', priority: 'LOW' }],
      now,
      DEFAULT_SCHEDULE,
    );
    // (2·1 + 1·0) / 3 = 67
    expect(r.score).toBe(67);
  });

  it('ignores cancelled tasks, future deadlines and anything older than 30 days', () => {
    const r = computeMotivation(
      [
        { originalDeadline: tk(9, 20, 18), completedAt: null, status: 'CANCELLED', priority: 'HIGH' },
        { originalDeadline: tk(10, 1, 18), completedAt: null, status: 'NEW', priority: 'HIGH' },
        done(tk(8, 1, 18), tk(8, 20, 18)),
      ],
      now,
      DEFAULT_SCHEDULE,
    );
    expect(r.score).toBeNull();
  });

  it('alerts climb with the stage', () => {
    expect(motivationAlertAudience('GOOD')).toEqual([]);
    expect(motivationAlertAudience('RISK')).toEqual(['SELF', 'DEPT_HEAD']);
    expect(motivationAlertAudience('LOW')).toEqual(['SELF', 'DEPT_HEAD', 'CEO']);
  });
});
