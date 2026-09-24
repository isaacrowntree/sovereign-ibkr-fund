import { describe, it, expect } from 'vitest';
import { computeAudCgt, dividendTaxAud, financialYear, type StudyTrade } from './aud-tax';

const fx = (r: number) => () => r;
const T = (date: string, action: 'BUY' | 'SELL', qty: number, price: number, commission = 0, symbol = 'A'): StudyTrade =>
  ({ date, symbol, action, qty, price, commission });

describe('financialYear', () => {
  it('runs July to June, by trade date', () => {
    expect(financialYear('2026-06-30')).toBe('FY2026');
    expect(financialYear('2026-07-01')).toBe('FY2027');
  });
});

describe('computeAudCgt', () => {
  it('discount iff sold on or after buy + 1 year + 1 day', () => {
    const early = computeAudCgt([T('2024-03-10', 'BUY', 10, 10), T('2025-03-10', 'SELL', 10, 20)], fx(1));
    expect(early.years[0]).toMatchObject({ nonDiscountGains: 100, discountGains: 0, netCapitalGain: 100 });
    const onTime = computeAudCgt([T('2024-03-10', 'BUY', 10, 10), T('2025-03-11', 'SELL', 10, 20)], fx(1));
    expect(onTime.years[0]).toMatchObject({ discountGains: 100, netCapitalGain: 50 });
  });

  it('brokerage: buy side in the cost base, sell side off the proceeds, both at their own rates', () => {
    const r = computeAudCgt(
      [T('2024-01-02', 'BUY', 10, 10, 1), T('2024-06-03', 'SELL', 10, 12, 1)],
      d => (d < '2024-03-01' ? 1.5 : 1.6),
    );
    // cost (100 + 1) × 1.5 = 151.5; proceeds (120 − 1) × 1.6 = 190.4
    expect(r.years[0].nonDiscountGains).toBeCloseTo(38.9, 9);
  });

  it('losses offset non-discount gains first, then discount gains, then the 50% discount', () => {
    const r = computeAudCgt([
      T('2020-01-02', 'BUY', 10, 10, 0, 'OLD'), T('2024-01-02', 'SELL', 10, 30, 0, 'OLD'), // +200 discount
      T('2023-06-01', 'BUY', 10, 10, 0, 'NEW'), T('2024-01-03', 'SELL', 10, 20, 0, 'NEW'), // +100 non-discount
      T('2023-06-01', 'BUY', 10, 30, 0, 'LOSS'), T('2024-01-04', 'SELL', 10, 15, 0, 'LOSS'), // −150
    ], fx(1));
    // 150 loss wipes the 100 non-discount gain, 50 comes off the 200 discount gain → 150 × 50%.
    expect(r.years[0].netCapitalGain).toBeCloseTo(75, 9);
  });

  it('carries a net loss forward to later years', () => {
    const r = computeAudCgt([
      T('2023-01-02', 'BUY', 10, 30), T('2023-03-01', 'SELL', 10, 20), // FY2023: −100
      T('2023-08-01', 'BUY', 10, 10), T('2023-09-01', 'SELL', 10, 25), // FY2024: +150
    ], fx(1));
    expect(r.years.map(y => [y.fy, y.netCapitalGain, y.lossesCarriedForward])).toEqual([
      ['FY2023', 0, 100], ['FY2024', 50, 0],
    ]);
  });

  it('matches FIFO parcels and counts discount / non-discount disposals', () => {
    const r = computeAudCgt([
      T('2020-01-02', 'BUY', 5, 10), T('2023-06-01', 'BUY', 5, 10), T('2024-01-02', 'SELL', 7, 10),
    ], fx(1));
    expect(r.discountDisposals).toBe(1);
    expect(r.nonDiscountDisposals).toBe(1);
    expect(r.unmatchedQty).toBe(0);
  });
});

describe('dividendTaxAud', () => {
  it('taxes gross AUD at the marginal rate less the 15% US withholding offset', () => {
    expect(dividendTaxAud([{ date: '2024-01-02', grossUsd: 100, withheldUsd: 15 }], fx(1.5), 0.47))
      .toBeCloseTo(100 * 1.5 * 0.47 - 15 * 1.5, 9);
    // The offset never exceeds the Australian tax on that income.
    expect(dividendTaxAud([{ date: '2024-01-02', grossUsd: 100, withheldUsd: 15 }], fx(1), 0.1)).toBe(0);
  });
});
