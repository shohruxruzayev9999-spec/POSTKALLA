/**
 * SaaS plans and prices (so‘m per month). Longer prepayment gets a discount.
 * Limits are shown in the app; they never block an agency's existing work.
 */
export const PLAN_IDS = ['START', 'BUSINESS', 'PREMIUM'] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export type PlanStatus = 'TRIAL' | 'ACTIVE' | 'EXPIRED' | 'UNLIMITED';

export interface Plan {
  id: PlanId;
  name: string;
  monthly: number;
  maxMembers: number | null;
  maxProjects: number | null;
  tagline: string;
  features: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  START: {
    id: 'START',
    name: 'Start',
    monthly: 199_000,
    maxMembers: 10,
    maxProjects: 5,
    tagline: 'Kichik jamoa uchun',
    features: ['10 tagacha hodim', '5 ta loyiha', 'Vazifalar, kanban, kalendar', 'Davomat va KPI', 'Telegram bot eslatmalari'],
  },
  BUSINESS: {
    id: 'BUSINESS',
    name: 'Biznes',
    monthly: 349_000,
    maxMembers: 30,
    maxProjects: null,
    tagline: 'O‘sayotgan agentlik uchun',
    features: ['30 tagacha hodim', 'Cheksiz loyihalar', 'Dizayn, Media, Syomka bo‘limlari', 'PDF hisobotlar va Telegram guruh tahlili', 'Moliya va Onboarding'],
  },
  PREMIUM: {
    id: 'PREMIUM',
    name: 'Premium',
    monthly: 599_000,
    maxMembers: null,
    maxProjects: null,
    tagline: 'To‘liq avtomatlashtirish',
    features: ['Cheksiz hodim va loyihalar', 'AI kunlik tahlil va tavsiyalar', 'AI xulosali hisobotlar', 'Ustuvor yordam', 'Shaxsiy sozlash va maʼlumot ko‘chirish'],
  },
};

export const DURATIONS = [1, 3, 6, 12] as const;
export type Duration = (typeof DURATIONS)[number];
export const DISCOUNT: Record<Duration, number> = { 1: 0, 3: 10, 6: 20, 12: 30 };
export const TRIAL_DAYS = 14;

/** Price of a plan for a prepaid period, rounded to 1 000 so‘m. */
export function priceFor(plan: PlanId, months: Duration) {
  const monthly = PLANS[plan].monthly;
  const full = monthly * months;
  const discountPct = DISCOUNT[months];
  const total = Math.round((full * (100 - discountPct)) / 100 / 1000) * 1000;
  return { monthly, months, full, discountPct, total, perMonth: Math.round(total / months / 1000) * 1000, saved: full - total };
}

/** Where a subscription stands on a local date ("YYYY-MM-DD"). */
export function planStatus(plan: string, until: string | null, today: string): { status: PlanStatus; daysLeft: number | null } {
  if (!until) return { status: plan === 'TRIAL' ? 'EXPIRED' : 'UNLIMITED', daysLeft: null };
  const days = Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days < 0) return { status: 'EXPIRED', daysLeft: 0 };
  return { status: plan === 'TRIAL' ? 'TRIAL' : 'ACTIVE', daysLeft: days };
}

/** A new end date: prepaid months are added to the remaining time (or to today when expired). */
export function extendUntil(until: string | null, today: string, months: number): string {
  const base = until && until >= today ? until : today;
  const [y, m, d] = base.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const out = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay)));
  return out.toISOString().slice(0, 10);
}
