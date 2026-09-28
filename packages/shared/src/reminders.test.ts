import { describe, expect, it } from 'vitest';
import { DEFAULT_REMINDER_POLICY, buildReminderPlan, normalizePolicy, resolveDueSteps } from './reminders.js';
import { DEFAULT_SCHEDULE, zonedTime } from './worktime.js';

const tk = (d: number, h: number, mi = 0) => zonedTime(2026, 9, d, h, mi, 'Asia/Tashkent');

describe('reminder & escalation plan', () => {
  // Task created Wed 23 Sep 10:00, deadline Fri 25 Sep 17:00.
  const plan = buildReminderPlan({ createdAt: tk(23, 10), deadline: tk(25, 17) }, DEFAULT_SCHEDULE);
  const byKey = Object.fromEntries(plan.map((s) => [s.key, s]));

  it('nudges 24 h and 2 h before, inside working time', () => {
    expect(byKey['before-24h']?.at.getTime()).toBe(tk(24, 17).getTime());
    expect(byKey['before-2h']?.at.getTime()).toBe(tk(25, 15).getTime());
  });

  it('3 overdue reminders to the assignee, counted in working hours', () => {
    expect(byKey['overdue-1']?.at.getTime()).toBe(tk(25, 17).getTime());
    expect(byKey['overdue-2']?.at.getTime()).toBe(tk(26, 11).getTime()); // Fri 17 + 2 h → Sat 11:00
    expect(byKey['overdue-3']?.at.getTime()).toBe(tk(26, 13).getTime());
    expect(byKey['overdue-3']?.audience).toEqual(['ASSIGNEE', 'GROUP']);
  });

  it('then the project manager (+1 h), then the CEO (+1 h more)', () => {
    expect(byKey['escalate-manager']).toMatchObject({ audience: ['MANAGER'], escalation: 'MANAGER' });
    expect(byKey['escalate-manager']?.at.getTime()).toBe(tk(26, 14).getTime());
    expect(byKey['escalate-ceo']).toMatchObject({ audience: ['CEO'], escalation: 'CEO' });
    expect(byKey['escalate-ceo']?.at.getTime()).toBe(tk(26, 15).getTime());
  });

  it('can skip the manager and go straight to the CEO', () => {
    const p = buildReminderPlan({ createdAt: tk(23, 10), deadline: tk(25, 17) }, DEFAULT_SCHEDULE, { ...DEFAULT_REMINDER_POLICY, skipManager: true });
    expect(p.some((s) => s.key === 'escalate-manager')).toBe(false);
    expect(p.find((s) => s.key === 'escalate-ceo')?.at.getTime()).toBe(tk(26, 14).getTime());
  });

  it('reads old saved policies', () => {
    expect(normalizePolicy({ skipDeptHead: true, escalateAtReminder: 3 }).skipManager).toBe(true);
    expect(normalizePolicy(null)).toEqual(DEFAULT_REMINDER_POLICY);
  });

  it('drops nudges that would land before the task existed', () => {
    const p = buildReminderPlan({ createdAt: tk(25, 12), deadline: tk(25, 17) }, DEFAULT_SCHEDULE);
    expect(p.map((s) => s.key)).not.toContain('before-24h');
    expect(p.map((s) => s.key)).toContain('before-2h');
  });

  it('after downtime sends only the latest reminder, never skips an escalation', () => {
    const r = resolveDueSteps(plan, tk(26, 14, 30), new Set());
    expect(r.send.map((s) => s.key)).toEqual(['escalate-manager']);
    expect(r.skip).toEqual(['before-24h', 'before-2h', 'overdue-1', 'overdue-2', 'overdue-3']);
  });

  it('sends nothing twice', () => {
    const r = resolveDueSteps(plan, tk(25, 16), new Set(['before-24h', 'before-2h']));
    expect(r.send).toEqual([]);
  });
});
