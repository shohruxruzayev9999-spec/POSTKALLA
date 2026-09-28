const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const MON = ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'];
const DAYS = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];

export const TZ = 'Asia/Tashkent';

function parts(d: Date, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday ?? 'Sun');
  return { y: +p.year!, m: +p.month!, d: +p.day!, hh: p.hour!, mm: p.minute!, wd };
}

export function todayLong(tz = TZ) {
  const p = parts(new Date(), tz);
  return `${DAYS[p.wd]}, ${p.d}-${MONTHS[p.m - 1]}`;
}

export function time(d: string | Date, tz = TZ) {
  const p = parts(new Date(d), tz);
  return `${p.hh}:${p.mm}`;
}

/** "bugun 18:00", "ertaga 10:00", "2-okt 18:00", "kecha 17:00". */
export function when(d: string | Date, tz = TZ) {
  const t = parts(new Date(d), tz);
  const now = parts(new Date(), tz);
  const key = (x: { y: number; m: number; d: number }) => Date.UTC(x.y, x.m - 1, x.d);
  const diff = Math.round((key(t) - key(now)) / 86_400_000);
  const hm = `${t.hh}:${t.mm}`;
  if (diff === 0) return `bugun ${hm}`;
  if (diff === 1) return `ertaga ${hm}`;
  if (diff === -1) return `kecha ${hm}`;
  return `${t.d}-${MON[t.m - 1]} ${hm}`;
}

export function dateShort(d: string | Date, tz = TZ) {
  const p = parts(new Date(d), tz);
  return `${p.d}-${MON[p.m - 1]}`;
}

/** Time left / overdue in human words. */
export function leftText(deadline: string | Date) {
  const ms = new Date(deadline).getTime() - Date.now();
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3_600_000);
  const d = Math.floor(h / 24);
  const txt = d >= 1 ? `${d} kun` : h >= 1 ? `${h} soat` : `${Math.max(1, Math.round(abs / 60_000))} daq`;
  return ms >= 0 ? { overdue: false, text: txt } : { overdue: true, text: `${txt} kechikdi` };
}

export function monthName(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${y}`;
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('');
}

export function money(n: number | null | undefined) {
  if (n == null) return '—';
  return new Intl.NumberFormat('ru-RU').format(n) + " so'm";
}

export const STATUS: Record<string, string> = {
  NEW: 'Yangi',
  IN_PROGRESS: 'Jarayonda',
  REVIEW: 'Tekshiruvda',
  RETURNED: 'Qaytarilgan',
  DONE: 'Bajarildi',
  BLOCKED: 'Bloklangan',
  CANCELLED: 'Bekor',
};

export const PRIORITY: Record<string, string> = { HIGH: 'Yuqori', MEDIUM: "O'rta", LOW: 'Past' };

export const ROLE: Record<string, string> = {
  OWNER: 'Owner (CEO)',
  ADMIN: 'Administrator',
  HR: 'HR',
  FINANCE: 'Moliya',
  MARKETER: 'Marketolog',
  PM: 'Loyiha menejeri',
  DEPT_HEAD: "Bo'lim boshlig'i",
  EMPLOYEE: 'Hodim',
};

export const ACTION: Record<string, { label: string; tone?: 'primary' | 'danger' }> = {
  START: { label: 'Boshlash', tone: 'primary' },
  SUBMIT: { label: 'Tekshiruvga yuborish', tone: 'primary' },
  BLOCK: { label: 'Bloklandi' },
  APPROVE: { label: 'Qabul qilish', tone: 'primary' },
  RETURN: { label: 'Qaytarish', tone: 'danger' },
  REOPEN: { label: 'Qayta ochish' },
  CANCEL: { label: 'Bekor qilish', tone: 'danger' },
};

export const STAGE: Record<string, string> = {
  EXCELLENT: "A'lo",
  GOOD: 'Yaxshi',
  WATCH: "E'tibor",
  RISK: 'Xavf',
  LOW: 'Past',
};

export const KPI_LABEL: Record<string, string> = {
  deadline: 'Deadline',
  volume: 'Hajm (reja)',
  attendance: 'Intizom',
};


export const FORMATS = ['Post', 'Karusel', 'Banner', 'Story', 'Reels', 'Video', 'Logo', 'Prezentatsiya', 'Kontent-reja', 'Target', 'Boshqa'];
export const PLATFORMS = ['Instagram', 'Telegram', 'Facebook', 'TikTok', 'YouTube', 'Sayt', 'Boshqa'];
