import { describe, it, expect } from 'vitest';
import { allocateCashFlow } from './cashflow-rebalance';

describe('allocateCashFlow', () => {
  it('equal underweight → split by target ratios', () => {
    const holdings = [
      { symbol: 'AAPL', currentValue: 4000, targetPct: 50 },
      { symbol: 'GOOG', currentValue: 4000, targetPct: 50 },
    ];
    const prices = new Map([['AAPL', 100], ['GOOG', 200]]);
    const orders = allocateCashFlow(holdings, 2000, 10, prices);

    // Total portfolio = 10000. Each target = 5000. Each deficit = 1000.
    // Each gets $1000 allocation.
    expect(orders).toHaveLength(2);
    const aapl = orders.find(o => o.symbol === 'AAPL')!;
    const goog = orders.find(o => o.symbol === 'GOOG')!;
    expect(aapl.amountUsd).toBeCloseTo(1000, 0);
    expect(aapl.shares).toBe(10);
    expect(goog.amountUsd).toBeCloseTo(1000, 0);
    expect(goog.shares).toBe(5);
  });

  it('overweight asset gets $0', () => {
    const holdings = [
      { symbol: 'AAPL', currentValue: 8000, targetPct: 50 },
      { symbol: 'GOOG', currentValue: 2000, targetPct: 50 },
    ];
    const prices = new Map([['AAPL', 100], ['GOOG', 200]]);
    const orders = allocateCashFlow(holdings, 2000, 10, prices);

    // Total = 12000. AAPL target = 6000, current = 8000 → overweight.
    // GOOG target = 6000, current = 2000 → deficit = 4000. Gets all $2000.
    expect(orders).toHaveLength(1);
    expect(orders[0].symbol).toBe('GOOG');
    expect(orders[0].amountUsd).toBeCloseTo(2000, 0);
  });

  it('deposit too small → empty', () => {
    const holdings = [
      { symbol: 'AAPL', currentValue: 4000, targetPct: 50 },
      { symbol: 'GOOG', currentValue: 4000, targetPct: 50 },
    ];
    const prices = new Map([['AAPL', 100], ['GOOG', 200]]);
    const orders = allocateCashFlow(holdings, 5, 100, prices);
    expect(orders).toHaveLength(0);
  });

  it('new account (zero holdings) → allocate by targets', () => {
    const holdings = [
      { symbol: 'AAPL', currentValue: 0, targetPct: 60 },
      { symbol: 'GOOG', currentValue: 0, targetPct: 40 },
    ];
    const prices = new Map([['AAPL', 50], ['GOOG', 100]]);
    const orders = allocateCashFlow(holdings, 10000, 10, prices);

    expect(orders).toHaveLength(2);
    const aapl = orders.find(o => o.symbol === 'AAPL')!;
    const goog = orders.find(o => o.symbol === 'GOOG')!;
    // Total = 10000. AAPL target = 6000, GOOG target = 4000.
    expect(aapl.amountUsd).toBeCloseTo(6000, 0);
    expect(aapl.shares).toBe(120);
    expect(goog.amountUsd).toBeCloseTo(4000, 0);
    expect(goog.shares).toBe(40);
  });

  it('negative deposit → throw', () => {
    const holdings = [{ symbol: 'AAPL', currentValue: 1000, targetPct: 100 }];
    const prices = new Map([['AAPL', 100]]);
    expect(() => allocateCashFlow(holdings, -500, 10, prices)).toThrow('non-negative');
  });
});
