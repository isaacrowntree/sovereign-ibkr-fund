import { describe, it, expect } from 'vitest';
import { LIVE_STUDY_DATA_AVAILABLE } from './data-available';
import { DECISION_RULE, buildStartBook, evaluateRun, STUDY_DATA, STUDY_DIVIDENDS } from './gate-study';
import { LIVE_CONFIG, runBacktest } from './backtest-engine';

describe('G6 decision rule', () => {
  it('is registered with the margins the doc states', () => {
    expect(DECISION_RULE).toMatchObject({
      registered: '2026-09-24', marginalRate: 0.47, afterTaxMarginPp: -1.0,
      bootstrapMarginPerYear: -0.01, maxDrawdownMarginPp: 2.0,
      bootstrap: { meanBlock: 20, resamples: 5000, alpha: 0.05 },
    });
  });
});

describe.skipIf(!LIVE_STUDY_DATA_AVAILABLE)('G6 study harness', () => {
  const targets = [
    { symbol: 'AMZN', pct: 30, sleeve: 'tech_growth' },
    { symbol: 'KO', pct: 40, sleeve: 'defensive' },
    { symbol: 'TLT', pct: 30, sleeve: 'hedge' },
  ];

  it('the start book leaves the growth sleeve 40% under target, 1% in cash, two dated lots per name', () => {
    const b = buildStartBook(targets, '2024-01-02', 30_000, { residueSleeve: 'tech_growth' });
    expect(b.weights.AMZN).toBeCloseTo(0.3 * 0.6, 12);
    const total = Object.values(b.weights).reduce((s, w) => s + w, 0);
    expect(total).toBeCloseTo(0.99, 12);
    expect(b.lots.filter(l => l.symbol === 'KO')).toHaveLength(2);
    for (const l of b.lots) expect(l.date < '2024-01-02').toBe(true);
  });

  it('a name not yet listed at the start is left out of the book', () => {
    const b = buildStartBook([...targets, { symbol: 'ARM', pct: 5 }], '2022-01-03', 30_000);
    expect(b.weights.ARM).toBeUndefined();
  });

  it('evaluates a run: after-tax below pre-tax on a gain, a unit series, disposals counted', () => {
    const b = buildStartBook(targets, '2024-01-02', 30_000, { residueSleeve: 'tech_growth' });
    const r = runBacktest({
      ...LIVE_CONFIG, dataFile: STUDY_DATA, symbols: targets.map(t => t.symbol), staticWeights: [0.3, 0.4, 0.3],
      lookbackDays: 60, useTotalReturn: false, dividendsFile: STUDY_DIVIDENDS, commissionModel: 'ibkr-fixed',
      gate: 'bands', initialLots: b.lots,
    }, 30_000, undefined, '2024-01-02', '2024-12-31');
    const m = evaluateRun(r, b.lots, { marginalRate: 0.47, sensitivityRate: 0.32, slippage: 0.0005 });
    expect(m.unitReturns.length).toBe(m.dates.length);
    expect(m.unitReturns.length).toBeGreaterThan(200);
    if (m.preTaxReturnPct > 0) expect(m.afterTaxReturnPct).toBeLessThan(m.preTaxReturnPct);
    expect(m.afterTaxReturnPctSensitivity).toBeGreaterThanOrEqual(m.afterTaxReturnPct);
    expect(m.nonDiscountDisposals + m.discountDisposals).toBeGreaterThan(0); // at least the terminal liquidation
  });
});
