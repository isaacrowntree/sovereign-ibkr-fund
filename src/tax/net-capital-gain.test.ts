import { describe, it, expect } from 'vitest';
import { computeNetCapitalGain } from './net-capital-gain';

describe('computeNetCapitalGain — s102-5 ordering', () => {
  it('no losses: discount halves discount gains only', () => {
    const r = computeNetCapitalGain({ discountGains: 1000, nonDiscountGains: 400, capitalLosses: 0 });
    expect(r.netCapitalGain).toBe(900);
    expect(r.discount).toBe(500);
  });

  it('current-year losses hit non-discount gains before discount gains', () => {
    const r = computeNetCapitalGain({ discountGains: 1000, nonDiscountGains: 400, capitalLosses: 600 });
    expect(r.currentLossesApplied).toEqual({ nonDiscount: 400, discount: 200 });
    expect(r.netCapitalGain).toBe(400); // (1000-200)/2
  });

  it('then carried-forward losses, same order, before the discount', () => {
    const r = computeNetCapitalGain({ discountGains: 1000, nonDiscountGains: 400, capitalLosses: 100 }, 500);
    expect(r.currentLossesApplied).toEqual({ nonDiscount: 100, discount: 0 });
    expect(r.carriedForwardApplied).toEqual({ nonDiscount: 300, discount: 200 });
    expect(r.netCapitalGain).toBe(400);
  });

  it('discount applies last — a loss is never set against a halved gain', () => {
    // Wrong order (discount first) would give 500 - 400 = 100.
    const r = computeNetCapitalGain({ discountGains: 1000, nonDiscountGains: 0, capitalLosses: 400 });
    expect(r.netCapitalGain).toBe(300);
  });

  it('unused losses carry forward — this year\'s plus the old ones', () => {
    const r = computeNetCapitalGain({ discountGains: 0, nonDiscountGains: 100, capitalLosses: 300 }, 50);
    expect(r.netCapitalGain).toBe(0);
    expect(r.netCapitalLossToCarryForward).toBe(250);
  });

  it('rejects negative or non-finite inputs', () => {
    expect(() => computeNetCapitalGain({ discountGains: -1, nonDiscountGains: 0, capitalLosses: 0 })).toThrow();
    expect(() => computeNetCapitalGain({ discountGains: 0, nonDiscountGains: 0, capitalLosses: 0 }, NaN)).toThrow();
  });
});
