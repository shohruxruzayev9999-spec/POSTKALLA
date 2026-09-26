import { describe, expect, it } from 'vitest';
import { KPI_TEMPLATES, bonusCoefficient, computeKpi, pointsToNextBand, scoreKpi, validateWeights } from './kpi.js';

describe('KPI', () => {
  it('reproduces the design mock-up: Aziz K., designer → 86', () => {
    const r = scoreKpi(
      { deadline: 84, quality: 78, volume: 95, attendance: 94, manager: 85, result: null },
      KPI_TEMPLATES.DESIGN,
    );
    expect(r.exact).toBeCloseTo(85.55, 2);
    expect(r.score).toBe(86);
  });

  it('computes components from raw system data', () => {
    const r = computeKpi(
      {
        doneTasks: 35,
        doneOnTime: 30,
        approvedTasks: 32,
        approvedFirstPass: 25,
        donePoints: 57,
        planPoints: 60,
        workDays: 23,
        onTimeDays: 22,
        managerRating: 4.25,
      },
      KPI_TEMPLATES.DESIGN,
    );
    expect(Math.round(r.components.deadline!)).toBe(86);
    expect(Math.round(r.components.quality!)).toBe(78);
    expect(r.components.manager).toBe(85);
    expect(r.score).toBeGreaterThan(80);
  });

  it('spreads the weight of a component without data', () => {
    // No manager rating yet: the remaining 85% is scaled to 100%.
    const r = scoreKpi({ deadline: 100, quality: 100, volume: 100, attendance: 100, manager: null, result: null }, KPI_TEMPLATES.DESIGN);
    expect(r.score).toBe(100);
    expect(r.effectiveWeights.manager).toBe(0);
  });

  it('every template sums to 100', () => {
    for (const w of Object.values(KPI_TEMPLATES)) expect(() => validateWeights(w)).not.toThrow();
    expect(() => validateWeights({ ...KPI_TEMPLATES.DESIGN, manager: 20 })).toThrow();
  });

  it('bonus bands', () => {
    expect(bonusCoefficient(86)).toBe(0.8);
    expect(bonusCoefficient(90)).toBe(1);
    expect(bonusCoefficient(59)).toBe(0);
    expect(pointsToNextBand(86)).toBe(4);
    expect(pointsToNextBand(95)).toBeNull();
  });
});
