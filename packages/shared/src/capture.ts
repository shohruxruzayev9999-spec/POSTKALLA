/**
 * Turning a line of Telegram text into a task draft: `/task ertaga 17:00 @ali Hisobot`.
 *
 * Pure and deterministic (no I/O): the bot resolves @mentions to members and shows the result
 * as a draft the author confirms, so a wrong guess never becomes a task on its own.
 */
import { isWorkingDay, localParts, zonedTime, type WorkSchedule } from './worktime.js';

export interface ParsedTask {
  /** What is left of the text once the date, time and mentions are taken out. */
  title: string;
  deadline: Date;
  /** False when the text named no day and no time (the default deadline was used). */
  deadlineSet: boolean;
  /** Telegram usernames without "@", in the order written. */
  mentions: string[];
}

const DAY = 86_400_000;

/** Relative day words (uz latin, uz cyrillic, ru, en) → days from today. */
const RELATIVE: Array<[RegExp, number]> = [
  [/(?<![\p{L}'ʻ‘])(indinga|послезавтра|индинга)(?![\p{L}'ʻ‘])/iu, 2],
  [/(?<![\p{L}'ʻ‘])(ertaga|tomorrow|завтра|эртага)(?![\p{L}'ʻ‘])/iu, 1],
  [/(?<![\p{L}'ʻ‘])(bugun|today|сегодня|бугун)(?![\p{L}'ʻ‘])/iu, 0],
];

/** Weekday words → ISO weekday. Longer words first ("yakshanba" before "shanba"). */
const WEEKDAY_WORDS: Array<[string, number]> = [
  ['yakshanba', 7], ['chorshanba', 3], ['payshanba', 4], ['dushanba', 1], ['seshanba', 2], ['shanba', 6], ['juma', 5],
  ['воскресенье', 7], ['понедельник', 1], ['вторник', 2], ['среда', 3], ['среду', 3], ['четверг', 4], ['пятница', 5], ['пятницу', 5], ['суббота', 6], ['субботу', 6],
  ['sunday', 7], ['monday', 1], ['tuesday', 2], ['wednesday', 3], ['thursday', 4], ['friday', 5], ['saturday', 6],
];
const WEEKDAY_RE = new RegExp(`(?<![\\p{L}'ʻ‘])(${WEEKDAY_WORDS.map(([w]) => w).join('|')})(?:(?:ga|gacha|kuni)(?![\\p{L}]))?(?![\\p{L}'ʻ‘])`, 'iu');

const MENTION_RE = /(?<![\w@])@([A-Za-z][A-Za-z0-9_]{3,31})\b/g;
/** 17:00, 9:30, "soat 17:00". A dot is kept for dates (17.10), so times need a colon. */
const TIME_RE = /(?<![\d:])(?:soat\s*)?([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/i;
/** "soat 17" / "в 17" without minutes. */
const HOUR_RE = /(?<![\p{L}\d])(?:soat|в)\s+([01]?\d|2[0-3])(?![\d:.])(?:\s*(?:da|ga|gacha))?/iu;
/** 25.10, 25.10.2026, 25/10. */
const DATE_RE = /(?<![\d.\/])([0-3]?\d)[./]([01]?\d)(?:[./](\d{4}|\d{2}))?(?![\d.\/])/;

function hm(value: string): [number, number] {
  const [h, m] = value.split(':').map(Number);
  return [h ?? 0, m ?? 0];
}

/** The local calendar day `days` after the local day of `from`. */
function shiftDay(from: Date, days: number, tz: string) {
  const p = localParts(from, tz);
  const t = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayOf(day: { y: number; m: number; d: number }): number {
  const w = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
  return w === 0 ? 7 : w;
}

function validDay(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Default when the text names no day: the end of today's working day if at least an hour is
 * left, otherwise the end of the next working day.
 */
export function defaultDeadline(now: Date, schedule: WorkSchedule): Date {
  const [eh, em] = hm(schedule.end);
  for (let i = 0; i < 31; i++) {
    const day = shiftDay(now, i, schedule.timezone);
    if (!isWorkingDay({ ...day, weekday: weekdayOf(day) }, schedule)) continue;
    const at = zonedTime(day.y, day.m, day.d, eh, em, schedule.timezone);
    if (at.getTime() - now.getTime() >= 3_600_000) return at;
  }
  return new Date(now.getTime() + DAY);
}

export function parseTaskText(text: string, now: Date, schedule: WorkSchedule): ParsedTask {
  const tz = schedule.timezone;
  let rest = ` ${text.replace(/\s+/g, ' ')} `;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
    return m;
  };

  const mentions: string[] = [];
  rest = rest.replace(MENTION_RE, (_all, u: string) => {
    if (!mentions.some((x) => x.toLowerCase() === u.toLowerCase())) mentions.push(u);
    return ' ';
  });

  let hour: number | null = null;
  let minute = 0;
  const time = take(TIME_RE);
  if (time) {
    hour = Number(time[1]);
    minute = Number(time[2]);
  } else {
    const h = take(HOUR_RE);
    if (h) hour = Number(h[1]);
  }

  let day: { y: number; m: number; d: number } | null = null;
  let weekly = false;
  const date = DATE_RE.exec(rest);
  if (date) {
    const today = localParts(now, tz);
    const d = Number(date[1]);
    const m = Number(date[2]);
    let y = date[3] ? Number(date[3].length === 2 ? `20${date[3]}` : date[3]) : today.year;
    if (validDay(y, m, d)) {
      // "25.01" written in December means next January.
      if (!date[3] && Date.UTC(y, m - 1, d) < Date.UTC(today.year, today.month - 1, today.day)) y += 1;
      if (validDay(y, m, d)) day = { y, m, d };
    }
    // Only a real date is taken out of the text; "31.02" stays in the title.
    if (day) rest = `${rest.slice(0, date.index)} ${rest.slice(date.index + date[0].length)}`;
  }
  if (!day) {
    for (const [re, offset] of RELATIVE) {
      if (take(re)) {
        day = shiftDay(now, offset, tz);
        break;
      }
    }
  }
  if (!day) {
    const w = take(WEEKDAY_RE);
    if (w) {
      const target = WEEKDAY_WORDS.find(([word]) => word === w[1]!.toLowerCase())![1];
      const today = localParts(now, tz).weekday;
      day = shiftDay(now, (target - today + 7) % 7, tz);
      weekly = true;
    }
  }

  const [eh, em] = hm(schedule.end);
  let deadline: Date;
  if (day) {
    deadline = zonedTime(day.y, day.m, day.d, hour ?? eh, hour === null ? em : minute, tz);
    // "juma" said on a Friday evening means next Friday.
    if (weekly && deadline <= now) {
      const next = shiftDay(deadline, 7, tz);
      deadline = zonedTime(next.y, next.m, next.d, hour ?? eh, hour === null ? em : minute, tz);
    }
  } else if (hour !== null) {
    const today = shiftDay(now, 0, tz);
    deadline = zonedTime(today.y, today.m, today.d, hour, minute, tz);
    if (deadline <= now) {
      const tomorrow = shiftDay(now, 1, tz);
      deadline = zonedTime(tomorrow.y, tomorrow.m, tomorrow.d, hour, minute, tz);
    }
  } else {
    deadline = defaultDeadline(now, schedule);
  }

  const title = rest
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:—–-]+|[\s,;:—–-]+$/g, '')
    .trim();
  return { title, deadline, deadlineSet: !!day || hour !== null, mentions };
}

/** The quick deadline buttons, shared by the app form and the bot draft. */
export const QUICK_DEADLINES = ['TODAY_END', 'TOMORROW_START', 'TOMORROW_END', 'NEXT_WEEK'] as const;
export type QuickDeadline = (typeof QUICK_DEADLINES)[number];

export function quickDeadlineLabel(key: QuickDeadline, schedule: WorkSchedule): string {
  switch (key) {
    case 'TODAY_END':
      return `Bugun ${schedule.end}`;
    case 'TOMORROW_START':
      return `Ertaga ${schedule.start}`;
    case 'TOMORROW_END':
      return `Ertaga ${schedule.end}`;
    case 'NEXT_WEEK':
      return `Keyingi hafta ${schedule.start}`;
  }
}

/**
 * The instant behind a quick button. "Ertaga" means the next working day (Saturday's "ertaga"
 * is Monday when Sunday is off); "Keyingi hafta" is the first working day of next week.
 */
export function quickDeadline(key: QuickDeadline, now: Date, schedule: WorkSchedule): Date {
  const tz = schedule.timezone;
  const [sh, sm] = hm(schedule.start);
  const [eh, em] = hm(schedule.end);
  const working = (offset: number) => {
    const day = shiftDay(now, offset, tz);
    return isWorkingDay({ ...day, weekday: weekdayOf(day) }, schedule) ? day : null;
  };
  const nextWorking = (from: number) => {
    for (let i = from; i < from + 31; i++) {
      const d = working(i);
      if (d) return d;
    }
    return shiftDay(now, from, tz);
  };
  if (key === 'TODAY_END') {
    const d = shiftDay(now, 0, tz);
    return zonedTime(d.y, d.m, d.d, eh, em, tz);
  }
  if (key === 'NEXT_WEEK') {
    const today = localParts(now, tz).weekday;
    const d = nextWorking(8 - today);
    return zonedTime(d.y, d.m, d.d, sh, sm, tz);
  }
  const d = nextWorking(1);
  return key === 'TOMORROW_START' ? zonedTime(d.y, d.m, d.d, sh, sm, tz) : zonedTime(d.y, d.m, d.d, eh, em, tz);
}
