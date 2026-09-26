import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULE,
  addWorkingHours,
  isWorkingTime,
  nextWorkingMoment,
  workingHoursBetween,
  zonedTime,
  type WorkSchedule,
} from './worktime.js';

// Retarget: 10:00–18:00, Monday–Saturday, Asia/Tashkent (UTC+5, no DST).
const S = DEFAULT_SCHEDULE;
const tk = (y: number, m: number, d: number, h: number, mi = 0) => zonedTime(y, m, d, h, mi, 'Asia/Tashkent');

describe('worktime (Asia/Tashkent, 10–18, Mon–Sat)', () => {
  it('converts local wall time to the right instant', () => {
    expect(tk(2026, 9, 26, 10).toISOString()).toBe('2026-09-26T05:00:00.000Z');
  });

  it('knows working time', () => {
    expect(isWorkingTime(tk(2026, 9, 26, 10), S)).toBe(true); // Saturday 10:00
    expect(isWorkingTime(tk(2026, 9, 26, 18), S)).toBe(false); // end is exclusive
    expect(isWorkingTime(tk(2026, 9, 27, 12), S)).toBe(false); // Sunday
  });

  it('counts only working hours across a Sunday', () => {
    // Sat 17:00 → Mon 11:00 = 1 h Saturday + 1 h Monday
    expect(workingHoursBetween(tk(2026, 9, 26, 17), tk(2026, 9, 28, 11), S)).toBe(2);
  });

  it('a task overdue at 17:30 reaches +2 working hours next morning, not at night', () => {
    const at = addWorkingHours(tk(2026, 9, 25, 17, 30), 2, S); // Friday 17:30
    expect(at.getTime()).toBe(tk(2026, 9, 26, 11, 30).getTime()); // Saturday 11:30
  });

  it('skips Sunday when adding hours', () => {
    const at = addWorkingHours(tk(2026, 9, 26, 17), 3, S); // Sat 17:00 + 3 h
    expect(at.getTime()).toBe(tk(2026, 9, 28, 12).getTime()); // Mon 12:00
  });

  it('moves a night moment to the next working start', () => {
    expect(nextWorkingMoment(tk(2026, 9, 25, 22), S).getTime()).toBe(tk(2026, 9, 26, 10).getTime());
    expect(nextWorkingMoment(tk(2026, 9, 26, 12), S).getTime()).toBe(tk(2026, 9, 26, 12).getTime());
  });

  it('respects holidays', () => {
    const withHoliday: WorkSchedule = { ...S, holidays: ['2026-09-28'] }; // Monday off
    expect(nextWorkingMoment(tk(2026, 9, 26, 19), withHoliday).getTime()).toBe(tk(2026, 9, 29, 10).getTime());
    expect(workingHoursBetween(tk(2026, 9, 26, 17), tk(2026, 9, 29, 11), withHoliday)).toBe(2);
  });

  it('returns zero for reversed intervals', () => {
    expect(workingHoursBetween(tk(2026, 9, 26, 12), tk(2026, 9, 26, 11), S)).toBe(0);
  });

  it('works in a daylight-saving zone', () => {
    const berlin: WorkSchedule = { timezone: 'Europe/Berlin', workDays: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', holidays: [] };
    // Friday 16:00 → Monday 10:00 across the October DST switch (25 Oct 2026)
    const from = zonedTime(2026, 10, 23, 16, 0, 'Europe/Berlin');
    const to = zonedTime(2026, 10, 26, 10, 0, 'Europe/Berlin');
    expect(workingHoursBetween(from, to, berlin)).toBe(2);
  });
});
