import { DomainError } from './errors.js';

/**
 * KPI = Σ wᵢ · Sᵢ over six components, each 0–100. Five come from system data; only the
 * manager rating is entered by a person. Weights are configured per department (templates
 * below). When a component has no data this month (e.g. no tasks with a plan), its weight is
 * spread proportionally over the components that do have data, so the score stays on 0–100.
 */
export const KPI_COMPONENTS = ['deadline', 'quality', 'volume', 'attendance', 'manager', 'result'] as const;
export type KpiComponent = (typeof KPI_COMPONENTS)[number];
export type KpiWeights = Record<KpiComponent, number>;

export const KPI_TEMPLATES = {
  DESIGN: { deadline: 25, quality: 30, volume: 20, attendance: 10, manager: 15, result: 0 },
  VIDEO: { deadline: 25, quality: 30, volume: 20, attendance: 10, manager: 15, result: 0 },
  SMM: { deadline: 30, quality: 20, volume: 25, attendance: 10, manager: 15, result: 0 },
  TARGET: { deadline: 20, quality: 0, volume: 0, attendance: 10, manager: 20, result: 50 },
  SALES: { deadline: 15, quality: 0, volume: 0, attendance: 10, manager: 15, result: 60 },
  PM: { deadline: 30, quality: 0, volume: 0, attendance: 10, manager: 20, result: 40 },
  DEFAULT: { deadline: 30, quality: 25, volume: 20, attendance: 10, manager: 15, result: 0 },
} as const satisfies Record<string, KpiWeights>;
export type KpiTemplate = keyof typeof KPI_TEMPLATES;

export function validateWeights(w: KpiWeights): void {
  const sum = KPI_COMPONENTS.reduce((s, k) => s + w[k], 0);
  if (KPI_COMPONENTS.some((k) => w[k] < 0) || Math.abs(sum - 100) > 1e-9) {
    throw new DomainError('VALIDATION', `KPI vaznlari yig'indisi 100 bo'lishi kerak (hozir ${sum})`);
  }
}

export interface KpiInputs {
  doneTasks: number;
  doneOnTime: number;
  approvedTasks: number;
  approvedFirstPass: number;
  donePoints: number;
  planPoints: number;
  workDays: number;
  onTimeDays: number;
  /** 1–5, null until the manager rates the month. */
  managerRating: number | null;
  resultActual?: number | null;
  resultTarget?: number | null;
}

const pct = (num: number, den: number): number | null => (den > 0 ? Math.min(100, (100 * num) / den) : null);

export function kpiComponents(i: KpiInputs): Record<KpiComponent, number | null> {
  return {
    deadline: pct(i.doneOnTime, i.doneTasks),
    quality: pct(i.approvedFirstPass, i.approvedTasks),
    volume: pct(i.donePoints, i.planPoints),
    attendance: pct(i.onTimeDays, i.workDays),
    manager: i.managerRating == null ? null : Math.max(0, Math.min(5, i.managerRating)) * 20,
    result: i.resultActual == null || i.resultTarget == null ? null : pct(i.resultActual, i.resultTarget),
  };
}

export interface KpiResult {
  /** Rounded 0–100; null when no component has data. */
  score: number | null;
  exact: number | null;
  components: Record<KpiComponent, number | null>;
  effectiveWeights: KpiWeights;
}

export function scoreKpi(components: Record<KpiComponent, number | null>, weights: KpiWeights): KpiResult {
  validateWeights(weights);
  const available = KPI_COMPONENTS.filter((k) => weights[k] > 0 && components[k] != null);
  const availableWeight = available.reduce((s, k) => s + weights[k], 0);
  const effectiveWeights = Object.fromEntries(
    KPI_COMPONENTS.map((k) => [k, available.includes(k) ? (weights[k] * 100) / availableWeight : 0]),
  ) as KpiWeights;
  if (availableWeight === 0) return { score: null, exact: null, components, effectiveWeights };
  const exact = available.reduce((s, k) => s + (effectiveWeights[k] / 100) * (components[k] as number), 0);
  return { score: Math.round(exact), exact, components, effectiveWeights };
}

export function computeKpi(inputs: KpiInputs, weights: KpiWeights): KpiResult {
  return scoreKpi(kpiComponents(inputs), weights);
}

/** Bonus multiplier bands: salary = fixed + bonus × coefficient. Configurable per company. */
export interface BonusBand {
  minScore: number;
  coefficient: number;
}
export const DEFAULT_BONUS_BANDS: BonusBand[] = [
  { minScore: 90, coefficient: 1.0 },
  { minScore: 75, coefficient: 0.8 },
  { minScore: 60, coefficient: 0.5 },
  { minScore: 0, coefficient: 0 },
];

export function bonusCoefficient(score: number, bands: BonusBand[] = DEFAULT_BONUS_BANDS): number {
  const sorted = [...bands].sort((a, b) => b.minScore - a.minScore);
  return sorted.find((b) => score >= b.minScore)?.coefficient ?? 0;
}

/** Points still needed to reach the next bonus band — shown to the employee as a nudge. */
export function pointsToNextBand(score: number, bands: BonusBand[] = DEFAULT_BONUS_BANDS): number | null {
  const next = [...bands].sort((a, b) => a.minScore - b.minScore).find((b) => b.minScore > score);
  return next ? next.minScore - score : null;
}
