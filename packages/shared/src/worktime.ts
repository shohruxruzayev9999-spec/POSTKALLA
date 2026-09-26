/**
 * Working-time arithmetic in a company's own time zone. Every deadline, escalation timer and
 * lateness measure in the product counts **working hours** — a task that goes overdue at 17:30
 * must not escalate to the CEO overnight.
 *
 * No date library: time zones are resolved with the platform's Intl data, which also handles
 * zones that observe daylight saving.
 */

export interface WorkSchedule {
  /** IANA zone, e.g. "Asia/Tashkent". */
  timezone: string;
  /** ISO weekdays that are working days: 1 = Monday … 7 = Sunday. */
  workDays: number[];
  /** Local start / end of the working day, "HH:MM". */
  start: string;
  end: string;
  /** Local non-working dates, "YYYY-MM-DD" (public holidays, company days off). */
  holidays: string[];
}

export const DEFAULT_SCHEDULE: WorkSchedule = {
  timezone: 'Asia/Tashkent',
  workDays: [1, 2, 3, 4, 5, 6],
  start: '10:00',
  end: '18:00',
  holidays: [],
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 1 = Monday … 7 = Sunday */
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(date: Date, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? 'Mon'] ?? 1,
  };
}

function offsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` reads the given local date and time. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess - offsetMs(new Date(guess), tz);
  const corrected = guess - offsetMs(new Date(result), tz);
  if (corrected !== result) result = corrected;
  return new Date(result);
}

function parseHm(value: string): [number, number] {
  const [h, m] = value.split(':').map(Number);
  return [h ?? 0, m ?? 0];
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

interface LocalDay {
  y: number;
  m: number;
  d: number;
  weekday: number;
}

function dayOf(date: Date, tz: string): LocalDay {
  const p = localParts(date, tz);
  return { y: p.year, m: p.month, d: p.day, weekday: p.weekday };
}

function nextDay(day: LocalDay): LocalDay {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + 1));
  const weekday = ((day.weekday % 7) + 1) as number;
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), weekday };
}

export function isWorkingDay(day: LocalDay, schedule: WorkSchedule): boolean {
  return schedule.workDays.includes(day.weekday) && !schedule.holidays.includes(isoDate(day.y, day.m, day.d));
}

/** [start, end) of the working window on a local day, or null on a day off. */
function workWindow(day: LocalDay, schedule: WorkSchedule): [number, number] | null {
  if (!isWorkingDay(day, schedule)) return null;
  const [sh, sm] = parseHm(schedule.start);
  const [eh, em] = parseHm(schedule.end);
  return [
    zonedTime(day.y, day.m, day.d, sh, sm, schedule.timezone).getTime(),
    zonedTime(day.y, day.m, day.d, eh, em, schedule.timezone).getTime(),
  ];
}

const MAX_DAYS = 800; // hard stop for pathological schedules (e.g. no working days at all)

export function isWorkingTime(date: Date, schedule: WorkSchedule): boolean {
  const w = workWindow(dayOf(date, schedule.timezone), schedule);
  return !!w && date.getTime() >= w[0] && date.getTime() < w[1];
}

/** `date` itself if it falls in working time, otherwise the start of the next working window. */
export function nextWorkingMoment(date: Date, schedule: WorkSchedule): Date {
  let day = dayOf(date, schedule.timezone);
  const t = date.getTime();
  for (let i = 0; i < MAX_DAYS; i++) {
    const w = workWindow(day, schedule);
    if (w) {
      if (t < w[0]) return new Date(w[0]);
      if (t < w[1]) return date;
    }
    day = nextDay(day);
    const w2 = workWindow(day, schedule);
    if (w2 && w2[0] > t) return new Date(w2[0]);
  }
  throw new Error('Ish jadvalida ish kunlari topilmadi');
}

/** Working milliseconds in the interval [from, to). Zero when `to` is not after `from`. */
export function workingMsBetween(from: Date, to: Date, schedule: WorkSchedule): number {
  const a = from.getTime();
  const b = to.getTime();
  if (b <= a) return 0;
  let total = 0;
  let day = dayOf(from, schedule.timezone);
  const lastDayGuard = Math.ceil((b - a) / DAY) + 2;
  for (let i = 0; i <= Math.min(lastDayGuard, MAX_DAYS); i++) {
    const w = workWindow(day, schedule);
    if (w) {
      const s = Math.max(w[0], a);
      const e = Math.min(w[1], b);
      if (e > s) total += e - s;
      if (w[0] >= b) break;
    }
    day = nextDay(day);
  }
  return total;
}

export function workingHoursBetween(from: Date, to: Date, schedule: WorkSchedule): number {
  return workingMsBetween(from, to, schedule) / HOUR;
}

/** The moment reached after spending `hours` of working time starting at `start`. */
export function addWorkingHours(start: Date, hours: number, schedule: WorkSchedule): Date {
  let remaining = hours * HOUR;
  let cursor = nextWorkingMoment(start, schedule).getTime();
  if (remaining <= 0) return new Date(cursor);
  let day = dayOf(new Date(cursor), schedule.timezone);
  for (let i = 0; i < MAX_DAYS; i++) {
    const w = workWindow(day, schedule);
    if (w && cursor < w[1]) {
      const from = Math.max(cursor, w[0]);
      const available = w[1] - from;
      if (remaining <= available) return new Date(from + remaining);
      remaining -= available;
    }
    day = nextDay(day);
    const nw = workWindow(day, schedule);
    if (nw) cursor = nw[0];
  }
  throw new Error('Ish jadvalida ish kunlari topilmadi');
}
