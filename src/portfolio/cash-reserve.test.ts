import { describe, it, expect } from 'vitest';
import { resolveCashReserveUsd } from './cash-reserve.js';

describe('resolveCashReserveUsd', () => {
  it('converts a base-currency reserve with the ledger rate', () => {
    const r = resolveCashReserveUsd({ reserveUsd: 1000, reserveBase: 500, baseRatePerUsd: 1.4 });
    expect(r.source).toBe('base');
    expect(r.reserveUsd).toBeCloseTo(357.14, 2);
  });

  it('falls back to the USD reserve when no rate is available', () => {
    // A base reserve without a rate must not become zero — that would deploy
    // the whole balance.
    const r = resolveCashReserveUsd({ reserveUsd: 1000, reserveBase: 500, baseRatePerUsd: null });
    expect(r).toEqual({ reserveUsd: 1000, source: 'usd' });
  });

  it('uses the USD reserve when no base reserve is set', () => {
    expect(resolveCashReserveUsd({ reserveUsd: 250, reserveBase: null, baseRatePerUsd: 1.4 }))
      .toEqual({ reserveUsd: 250, source: 'usd' });
  });

  it('never returns a negative or NaN reserve', () => {
    expect(resolveCashReserveUsd({ reserveUsd: NaN, reserveBase: -5, baseRatePerUsd: 1.4 }).reserveUsd).toBe(1000);
  });
});
