import { DomainError } from './errors.js';

/**
 * One KPI for everyone in the agency, measured fully automatically (no manual ratings):
 *   deadline   — share of tasks delivered by their ORIGINAL deadline
 *   volume     — done points / planned points (points are set by whoever assigns the task)
 *   attendance — share of working days the person arrived on time
 * KPI = Σ wᵢ · Sᵢ. When a component has no data this month, its weight is spread over the
 * components that do, so the score stays on 0–100.
 */
export const KPI_COMPONENTS = ['deadline', 'volume', 'attendance'] as const;
export type KpiComponent = (typeof KPI_COMPONENTS)[number];
export type KpiWeights = Record<KpiComponent, number>;

export const KPI_WEIGHTS: KpiWeights = { deadline: 50, volume: 35, attendance: 15 };

export function validateWeights(w: KpiWeights): void {
  const sum = KPI_COMPONENTS.reduce((s, k) => s + w[k], 0);
  if (KPI_COMPONENTS.some((k) => w[k] < 0) || Math.abs(sum - 100) > 1e-9) {
    throw new DomainError('VALIDATION', `KPI vaznlari yig'indisi 100 bo'lishi kerak (hozir ${sum})`);
  }
}

export interface KpiInputs {
  doneTasks: number;
  doneOnTime: number;
  donePoints: number;
  planPoints: number;
  workDays: number;
  onTimeDays: number;
}

const pct = (num: number, den: number): number | null => (den > 0 ? Math.min(100, (100 * num) / den) : null);

export function kpiComponents(i: KpiInputs): Record<KpiComponent, number | null> {
  return {
    deadline: pct(i.doneOnTime, i.doneTasks),
    volume: pct(i.donePoints, i.planPoints),
    attendance: pct(i.onTimeDays, i.workDays),
  };
}

export interface KpiResult {
  /** Rounded 0–100; null when no component has data. */
  score: number | null;
  exact: number | null;
  components: Record<KpiComponent, number | null>;
  effectiveWeights: KpiWeights;
}

export function scoreKpi(components: Record<KpiComponent, number | null>, weights: KpiWeights = KPI_WEIGHTS): KpiResult {
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

export function computeKpi(inputs: KpiInputs, weights: KpiWeights = KPI_WEIGHTS): KpiResult {
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
