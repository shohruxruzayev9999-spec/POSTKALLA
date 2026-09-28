import { describe, expect, it } from 'vitest';
import { KPI_WEIGHTS, bonusCoefficient, computeKpi, pointsToNextBand, scoreKpi, validateWeights } from './kpi.js';

describe('KPI (one formula for everyone)', () => {
  it('weights deadline 50, volume 35, attendance 15', () => {
    const r = scoreKpi({ deadline: 80, volume: 90, attendance: 100 });
    expect(r.exact).toBeCloseTo(0.5 * 80 + 0.35 * 90 + 0.15 * 100, 6); // 86.5
    expect(r.score).toBe(87);
  });

  it('computes components from raw system data', () => {
    const r = computeKpi({ doneTasks: 20, doneOnTime: 17, donePoints: 30, planPoints: 32, workDays: 22, onTimeDays: 21 });
    expect(r.components.deadline).toBe(85);
    expect(Math.round(r.components.volume!)).toBe(94);
    expect(Math.round(r.components.attendance!)).toBe(95);
    expect(r.score).toBe(90); // 42.5 + 32.8 + 14.3
  });

  it('spreads the weight of a component without data', () => {
    // No tasks yet: only attendance counts.
    const r = scoreKpi({ deadline: null, volume: null, attendance: 90 });
    expect(r.score).toBe(90);
    expect(r.effectiveWeights.attendance).toBe(100);
  });

  it('caps volume at 100 and returns null with no data', () => {
    expect(computeKpi({ doneTasks: 0, doneOnTime: 0, donePoints: 50, planPoints: 10, workDays: 0, onTimeDays: 0 }).score).toBe(100);
    expect(scoreKpi({ deadline: null, volume: null, attendance: null }).score).toBeNull();
  });

  it('weights sum to 100', () => {
    expect(() => validateWeights(KPI_WEIGHTS)).not.toThrow();
    expect(() => validateWeights({ ...KPI_WEIGHTS, deadline: 60 })).toThrow();
  });

  it('bonus bands', () => {
    expect(bonusCoefficient(86)).toBe(0.8);
    expect(bonusCoefficient(90)).toBe(1);
    expect(bonusCoefficient(59)).toBe(0);
    expect(pointsToNextBand(86)).toBe(4);
    expect(pointsToNextBand(95)).toBeNull();
  });
});
