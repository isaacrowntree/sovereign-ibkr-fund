import { describe, it, expect } from 'vitest';
import { allocateCashFlow, recentlySoldSymbols } from './cashflow-rebalance';

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

describe('allocateCashFlow rebuy guard', () => {
  const holdings = [
    { symbol: 'AAA', currentValue: 4000, targetPct: 50 },
    { symbol: 'BBB', currentValue: 4000, targetPct: 50 },
  ];
  const prices = new Map([['AAA', 100], ['BBB', 100]]);

  it('skips excluded names and leaves their share in cash', () => {
    // $2,000 deposit; both names have a $1,000 deficit. AAA excluded → only
    // BBB's $1,000 deficit is fillable, and only $1,000 deploys — AAA's
    // share stays in cash rather than over-filling BBB past target.
    const orders = allocateCashFlow(holdings, 2000, 100, prices, new Set(['AAA']));
    expect(orders.map(o => o.symbol)).toEqual(['BBB']);
    expect(orders[0].amountUsd).toBeCloseTo(1000, 0);
  });

  it('returns nothing when every deficit name is excluded', () => {
    const orders = allocateCashFlow(holdings, 2000, 100, prices, new Set(['AAA', 'BBB']));
    expect(orders).toEqual([]);
  });

  it('unchanged without exclusions (guard off)', () => {
    const orders = allocateCashFlow(holdings, 2000, 100, prices);
    expect(orders.map(o => o.symbol).sort()).toEqual(['AAA', 'BBB']);
    expect(orders.reduce((s, o) => s + o.amountUsd, 0)).toBeCloseTo(2000, 0);
  });
});

describe('recentlySoldSymbols', () => {
  const now = Date.parse('2026-08-29T00:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const t = (sym: string, action: 'BUY' | 'SELL', daysAgo: number) => ({
    symbol: sym, action, timestamp: new Date(now - daysAgo * day).toISOString(),
  });

  it('collects only SELLs inside the window', () => {
    const trades = [t('NET', 'SELL', 5), t('AMZN', 'SELL', 29), t('TSLA', 'SELL', 31), t('PLTR', 'BUY', 2)];
    const out = recentlySoldSymbols(trades, 30, now);
    expect([...out].sort()).toEqual(['AMZN', 'NET']);
  });

  it('guardDays 0 disables the guard entirely', () => {
    expect(recentlySoldSymbols([t('NET', 'SELL', 1)], 0, now).size).toBe(0);
  });

  it('boundary: a sell exactly guardDays old is still excluded', () => {
    expect(recentlySoldSymbols([t('NET', 'SELL', 30)], 30, now).has('NET')).toBe(true);
  });

  it('ignores unparseable and future timestamps', () => {
    const trades = [
      { symbol: 'GE', action: 'SELL' as const, timestamp: 'not-a-date' },
      t('KO', 'SELL', -1), // future
    ];
    expect(recentlySoldSymbols(trades, 30, now).size).toBe(0);
  });
});
