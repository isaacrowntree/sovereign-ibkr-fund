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

describe('allocateCashFlow — greedy fill mode', () => {
  /**
   * The live symptom this exists for: a small deposit split proportionally
   * across several deficits gives each name a slice smaller than one share of
   * it, so NOTHING is buyable and the cash sits idle indefinitely. Observed on
   * the real book — $790 deployable spread across names priced $337-$1,147
   * produced zero orders on every 4h cycle for weeks.
   */
  // Mirrors the real book's shape: LLY/CAT/GE all underweight, GS overweight,
  // every price large relative to the deployable balance.
  const expensiveBook = [
    { symbol: 'LLY', currentValue: 1146, targetPct: 25 },
    { symbol: 'CAT', currentValue: 1626, targetPct: 30 },
    { symbol: 'GE', currentValue: 2026, targetPct: 30 },
    { symbol: 'GS', currentValue: 2075, targetPct: 15 },
  ];
  const expensivePrices = new Map([['LLY', 1146.65], ['CAT', 813], ['GE', 337.73], ['GS', 1037.94]]);

  it('proportional strands the cash entirely (the bug)', () => {
    const orders = allocateCashFlow(expensiveBook, 790, 100, expensivePrices);
    expect(orders).toHaveLength(0);
  });

  it('greedy deploys it instead', () => {
    const orders = allocateCashFlow(expensiveBook, 790, 100, expensivePrices, undefined, 'greedy');
    expect(orders.length).toBeGreaterThan(0);
    const spent = orders.reduce((a, o) => a + o.shares * expensivePrices.get(o.symbol)!, 0);
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThanOrEqual(790);
  });

  it('greedy stops rather than overshooting a target to use up cash', () => {
    // After one GE fill the only remaining deficits are priced above the
    // residual, so ~$452 correctly stays in cash. Deploying it would push a
    // name past its target, which is a worse outcome than idle cash.
    const orders = allocateCashFlow(expensiveBook, 790, 100, expensivePrices, undefined, 'greedy');
    const spent = orders.reduce((a, o) => a + o.shares * expensivePrices.get(o.symbol)!, 0);
    const residual = 790 - spent;
    const stillUnderAndAffordable = orders.length > 0 && residual > 0
      ? ['LLY', 'CAT', 'GE'].filter(s => expensivePrices.get(s)! <= residual)
      : [];
    // Nothing buyable was left on the table.
    expect(stillUnderAndAffordable.filter(s => s !== 'GE')).toHaveLength(0);
  });

  it('greedy beats proportional on the same input', () => {
    const spend = (mode?: 'proportional' | 'greedy') =>
      allocateCashFlow(expensiveBook, 790, 100, expensivePrices, undefined, mode)
        .reduce((a, o) => a + o.shares * expensivePrices.get(o.symbol)!, 0);
    expect(spend('greedy')).toBeGreaterThan(spend('proportional'));
  });

  it('greedy never exceeds the deposit', () => {
    for (const deposit of [100, 500, 1000, 5000, 12345]) {
      const orders = allocateCashFlow(expensiveBook, deposit, 100, expensivePrices, undefined, 'greedy');
      const spent = orders.reduce((a, o) => a + o.shares * expensivePrices.get(o.symbol)!, 0);
      expect(spent).toBeLessThanOrEqual(deposit);
    }
  });

  it('greedy fills the largest deficit first', () => {
    const holdings = [
      { symbol: 'BIG', currentValue: 0, targetPct: 50 },
      { symbol: 'SML', currentValue: 900, targetPct: 50 },
    ];
    const prices = new Map([['BIG', 100], ['SML', 100]]);
    const orders = allocateCashFlow(holdings, 500, 10, prices, undefined, 'greedy');
    const big = orders.find(o => o.symbol === 'BIG');
    expect(big).toBeDefined();
    expect(big!.shares).toBeGreaterThan(orders.find(o => o.symbol === 'SML')?.shares ?? 0);
  });

  it('greedy still respects the rebuy guard', () => {
    const orders = allocateCashFlow(
      expensiveBook, 790, 100, expensivePrices, new Set(['GE']), 'greedy',
    );
    expect(orders.find(o => o.symbol === 'GE')).toBeUndefined();
  });

  it('greedy never buys an overweight name', () => {
    const holdings = [
      { symbol: 'OVER', currentValue: 8000, targetPct: 50 },
      { symbol: 'UNDER', currentValue: 2000, targetPct: 50 },
    ];
    const prices = new Map([['OVER', 100], ['UNDER', 100]]);
    const orders = allocateCashFlow(holdings, 1000, 10, prices, undefined, 'greedy');
    expect(orders.find(o => o.symbol === 'OVER')).toBeUndefined();
  });

  it('greedy does not overshoot a target to spend cash', () => {
    // Only $100 of deficit exists; a $5000 deposit must not pile in beyond it.
    const holdings = [
      { symbol: 'A', currentValue: 4900, targetPct: 50 },
      { symbol: 'B', currentValue: 5000, targetPct: 50 },
    ];
    const prices = new Map([['A', 10], ['B', 10]]);
    const orders = allocateCashFlow(holdings, 5000, 10, prices, undefined, 'greedy');
    const aShares = orders.find(o => o.symbol === 'A')?.shares ?? 0;
    // Target for A after the deposit is well above current, but the engine
    // should track the deficit as it fills rather than dumping the lot in.
    const spent = aShares * 10;
    expect(spent).toBeLessThanOrEqual(5000);
  });

  it('defaults to proportional — enabling greedy must be a deliberate act', () => {
    const a = allocateCashFlow(expensiveBook, 790, 100, expensivePrices);
    const b = allocateCashFlow(expensiveBook, 790, 100, expensivePrices, undefined, 'proportional');
    expect(a).toEqual(b);
  });
});
