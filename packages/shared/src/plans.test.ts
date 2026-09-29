import { describe, expect, it } from 'vitest';
import { extendUntil, planStatus, priceFor } from './plans.js';

describe('plans', () => {
  it('discounts longer prepayment', () => {
    expect(priceFor('START', 1)).toMatchObject({ total: 199_000, discountPct: 0, saved: 0 });
    expect(priceFor('BUSINESS', 3)).toMatchObject({ full: 1_047_000, discountPct: 10, total: 942_000 });
    expect(priceFor('PREMIUM', 12)).toMatchObject({ full: 7_188_000, discountPct: 30, total: 5_032_000, perMonth: 419_000 });
  });

  it('knows trial, active, expired and unlimited', () => {
    expect(planStatus('TRIAL', '2026-10-05', '2026-09-29')).toEqual({ status: 'TRIAL', daysLeft: 6 });
    expect(planStatus('BUSINESS', '2026-09-28', '2026-09-29')).toEqual({ status: 'EXPIRED', daysLeft: 0 });
    expect(planStatus('PREMIUM', null, '2026-09-29')).toEqual({ status: 'UNLIMITED', daysLeft: null });
  });

  it('adds months to the remaining time, clamping month ends', () => {
    expect(extendUntil('2026-10-15', '2026-09-29', 3)).toBe('2027-01-15');
    expect(extendUntil('2026-09-01', '2026-09-29', 1)).toBe('2026-10-29'); // expired: from today
    expect(extendUntil(null, '2027-01-31', 1)).toBe('2027-02-28');
  });
});
