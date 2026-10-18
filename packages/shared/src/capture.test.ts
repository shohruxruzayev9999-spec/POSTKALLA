import { describe, expect, it } from 'vitest';
import { defaultDeadline, parseTaskText } from './capture.js';
import { nextOccurrence } from './recurrence.js';
import { DEFAULT_SCHEDULE, localParts } from './worktime.js';

const S = DEFAULT_SCHEDULE; // Asia/Tashkent, Mon–Sat 10:00–18:00
// Wednesday 21 Oct 2026, 11:00 Tashkent (06:00 UTC).
const NOW = new Date('2026-10-21T06:00:00Z');
const local = (d: Date) => {
  const p = localParts(d, S.timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

describe('parseTaskText', () => {
  it('reads day, time, mention and leaves the title', () => {
    const r = parseTaskText('ertaga 17:00 @ali_dizayn Oktabr hisobotini yuborish', NOW, S);
    expect(r.title).toBe('Oktabr hisobotini yuborish');
    expect(r.mentions).toEqual(['ali_dizayn']);
    expect(local(r.deadline)).toBe('2026-10-22 17:00');
    expect(r.deadlineSet).toBe(true);
  });

  it('a day without a time means the end of that working day', () => {
    expect(local(parseTaskText('bugun banner', NOW, S).deadline)).toBe('2026-10-21 18:00');
    expect(local(parseTaskText('indinga post', NOW, S).deadline)).toBe('2026-10-23 18:00');
  });

  it('a time alone is today, or tomorrow once it has passed', () => {
    expect(local(parseTaskText('15:30 qo‘ng‘iroq', NOW, S).deadline)).toBe('2026-10-21 15:30');
    expect(local(parseTaskText('09:00 qo‘ng‘iroq', NOW, S).deadline)).toBe('2026-10-22 09:00');
    expect(local(parseTaskText('soat 16 da uchrashuv', NOW, S).deadline)).toBe('2026-10-21 16:00');
  });

  it('weekday names point to the coming day; today’s name after it passed means next week', () => {
    expect(local(parseTaskText('jumagacha reels', NOW, S).deadline)).toBe('2026-10-23 18:00');
    expect(local(parseTaskText('dushanba 10:00 reja', NOW, S).deadline)).toBe('2026-10-26 10:00');
    const evening = new Date('2026-10-21T14:00:00Z'); // Wed 19:00
    expect(local(parseTaskText('chorshanba hisobot', evening, S).deadline)).toBe('2026-10-28 18:00');
    // "shanba" is not mistaken inside "yakshanba".
    expect(local(parseTaskText('yakshanba syomka', NOW, S).deadline)).toBe('2026-10-25 18:00');
  });

  it('dates, with and without a year; a past date rolls to next year', () => {
    expect(local(parseTaskText('25.10 17:00 kontent reja', NOW, S).deadline)).toBe('2026-10-25 17:00');
    expect(local(parseTaskText('05.01.2027 yillik hisobot', NOW, S).deadline)).toBe('2027-01-05 18:00');
    expect(local(parseTaskText('10.03 bayram posti', NOW, S).deadline)).toBe('2027-03-10 18:00');
    // An impossible date is left in the title instead of guessing.
    expect(parseTaskText('31.02 nimadir', NOW, S).title).toContain('31.02');
  });

  it('russian and english words work too', () => {
    expect(local(parseTaskText('завтра 12:00 созвон', NOW, S).deadline)).toBe('2026-10-22 12:00');
    expect(local(parseTaskText('friday brief', NOW, S).deadline)).toBe('2026-10-23 18:00');
  });

  it('no date at all: today’s end if an hour is left, else the next working day', () => {
    const r = parseTaskText('@Kamola Logotip variantlari', NOW, S);
    expect(r.deadlineSet).toBe(false);
    expect(local(r.deadline)).toBe('2026-10-21 18:00');
    expect(r.mentions).toEqual(['Kamola']);
    // Saturday 17:30 → Monday 18:00 (Sunday is off).
    expect(local(defaultDeadline(new Date('2026-10-24T12:30:00Z'), S))).toBe('2026-10-26 18:00');
  });

  it('e-mails are not mentions and duplicate mentions collapse', () => {
    const r = parseTaskText('info@retarget.uz ga xat @aliyev @Aliyev', NOW, S);
    expect(r.mentions).toEqual(['aliyev']);
    expect(r.title).toContain('info@retarget.uz');
  });
});

describe('nextOccurrence', () => {
  const fri = new Date('2026-10-23T12:00:00Z'); // Fri 17:00
  it('weekly keeps the weekday and time', () => {
    expect(local(nextOccurrence(fri, 'WEEKLY', S, fri))).toBe('2026-10-30 17:00');
  });
  it('daily skips days off', () => {
    const sat = new Date('2026-10-24T12:00:00Z');
    expect(local(nextOccurrence(sat, 'DAILY', S, sat))).toBe('2026-10-26 17:00');
  });
  it('monthly clamps to the month end and moves off a day off', () => {
    const jan31 = new Date('2026-01-31T12:00:00Z'); // Sat
    expect(local(nextOccurrence(jan31, 'MONTHLY', S, jan31))).toBe('2026-02-28 17:00');
    const mar31 = new Date('2026-05-31T12:00:00Z'); // Sun 31 May → June 30 is Tue
    expect(local(nextOccurrence(mar31, 'MONTHLY', S, mar31))).toBe('2026-06-30 17:00');
  });
  it('after a long pause the series resumes from now, not with every missed copy', () => {
    const later = new Date('2026-11-20T06:00:00Z'); // Fri 11:00
    expect(local(nextOccurrence(fri, 'WEEKLY', S, later))).toBe('2026-11-20 17:00');
  });
});

describe('quickDeadline', () => {
  it('maps the buttons onto working days', async () => {
    const { quickDeadline } = await import('./capture.js');
    expect(local(quickDeadline('TODAY_END', NOW, S))).toBe('2026-10-21 18:00');
    expect(local(quickDeadline('TOMORROW_START', NOW, S))).toBe('2026-10-22 10:00');
    expect(local(quickDeadline('NEXT_WEEK', NOW, S))).toBe('2026-10-26 10:00');
    const sat = new Date('2026-10-24T06:00:00Z');
    expect(local(quickDeadline('TOMORROW_END', sat, S))).toBe('2026-10-26 18:00');
  });
});
