import { describe, expect, it } from 'vitest';
import { zonedTime } from '@retarget/shared';
import { agency } from '../test/fixtures.js';
import { dashboard, memberScores } from './analytics.js';
import { attendanceMonth, checkIn, checkOut, editAttendance } from './attendance.js';
import { updateCompany } from './org.js';
import { actOnTask, createTask } from './tasks.js';

const tk = (d: number, h: number, mi = 0) => zonedTime(2026, 9, d, h, mi, 'Asia/Tashkent');

describe('attendance', () => {
  it('Keldim / Ketdim with lateness', async () => {
    const a = await agency(tk(21, 10, 12));
    const aziz = await a.actor(a.users.aziz.id);
    const row = await checkIn(a.ctx, aziz, {});
    expect(row).toMatchObject({ day: '2026-09-21', lateMinutes: 12 });
    await expect(checkIn(a.ctx, aziz, {})).rejects.toThrow(/allaqachon/);
    a.clock.set(tk(21, 18, 5));
    expect((await checkOut(a.ctx, aziz, {})).checkOut).toEqual(tk(21, 18, 5));
  });

  it('shows a month as a calendar', async () => {
    const a = await agency(tk(21, 10, 12));
    const aziz = await a.actor(a.users.aziz.id);
    await checkIn(a.ctx, aziz, {});
    a.clock.set(tk(23, 9, 55));
    await checkIn(a.ctx, aziz, {});
    a.clock.set(tk(24, 12));
    const m = await attendanceMonth(a.ctx, aziz, { month: '2026-09' });
    const st = (d: number) => m.days[d - 1]!.status;
    expect(st(21)).toBe('LATE');
    expect(st(22)).toBe('ABSENT');
    expect(st(23)).toBe('ON_TIME');
    expect(st(27)).toBe('OFF'); // Sunday
    expect(st(28)).toBe('FUTURE');
    expect(m.summary).toMatchObject({ onTime: 1, late: 1, absent: 1 });
  });

  it('requires being at the office when the office location is set', async () => {
    const a = await agency(tk(21, 9, 55));
    const owner = await a.actor(a.users.ceo.id);
    await updateCompany(a.ctx, owner, { officeLat: 41.3111, officeLng: 69.2797, officeRadiusM: 200 });
    const aziz = await a.actor(a.users.aziz.id);
    await expect(checkIn(a.ctx, aziz, {})).rejects.toThrow(/Joylashuv/);
    await expect(checkIn(a.ctx, aziz, { lat: 41.35, lng: 69.28 })).rejects.toThrow(/uzoqdasiz/);
    const ok = await checkIn(a.ctx, aziz, { lat: 41.3112, lng: 69.2798 });
    expect(ok.lateMinutes).toBe(0);
  });

  it('HR corrects others, never themself', async () => {
    const a = await agency(tk(22, 12));
    const hr = await a.actor(a.users.hr.id);
    await editAttendance(a.ctx, hr, { userId: a.users.aziz.id, day: '2026-09-21', checkIn: tk(21, 10), checkOut: tk(21, 18), note: 'Telefon ishlamadi' });
    await expect(
      editAttendance(a.ctx, hr, { userId: a.users.hr.id, day: '2026-09-21', checkIn: tk(21, 10), checkOut: tk(21, 18), note: "O'zim" }),
    ).rejects.toThrow(/O'z/);
  });
});

describe('KPI & motivation from real data', () => {
  it('scores a designer and shows them to the right people', async () => {
    const a = await agency(tk(1, 9));
    const head = await a.actor(a.users.head.id);
    const aziz = await a.actor(a.users.aziz.id);

    // Two tasks: one on time, one late by 8 working hours.
    const t1 = await createTask(a.ctx, head, { title: 'Post #1', assigneeUserId: a.users.aziz.id, deadline: tk(3, 18), priority: 'MEDIUM' });
    const t2 = await createTask(a.ctx, head, { title: 'Post #2', assigneeUserId: a.users.aziz.id, deadline: tk(4, 18), priority: 'MEDIUM' });
    for (const [t, doneAt] of [
      [t1, tk(3, 16)],
      [t2, tk(7, 10) /* Fri 18:00 → Sat 18:00 = 8 h → Mon 10:00 */],
    ] as const) {
      await actOnTask(a.ctx, aziz, t.id, 'START');
      await actOnTask(a.ctx, aziz, t.id, 'SUBMIT');
      a.clock.set(doneAt);
      await actOnTask(a.ctx, head, t.id, 'APPROVE');
    }

    a.clock.set(tk(8, 12));
    const s = await memberScores(a.ctx, aziz, a.users.aziz.id);
    // Motivation: (1 + (1 − 8/48)) / 2 = 0.9167 → 92
    expect(s.motivation.score).toBe(92);
    expect(s.kpi.components.deadline).toBe(50);
    expect(Object.keys(s.kpi.components).sort()).toEqual(['attendance', 'deadline', 'volume']);
    expect(s.kpi.score).not.toBeNull();

    // Visibility: KPI is open to the whole team (only money is hidden).
    const bekzod = await a.actor(a.users.bekzod.id);
    expect((await memberScores(a.ctx, bekzod, a.users.aziz.id)).kpi.score).toBe(s.kpi.score);
    const ceoDash = await dashboard(a.ctx, await a.actor(a.users.ceo.id));
    const headDash = await dashboard(a.ctx, head);
    const bekDash = await dashboard(a.ctx, bekzod);
    expect(ceoDash.team.length).toBe(8);
    expect(headDash.team.length).toBe(8);
    expect(bekDash.team.length).toBe(8);
  });
});
