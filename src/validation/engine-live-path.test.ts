import { describe, it, expect } from 'vitest';
import { LIVE_STUDY_DATA_AVAILABLE } from './data-available';
import { runBacktest, DEFAULT_CONFIG, LIVE_CONFIG, type BacktestConfig } from './backtest-engine';

const DATA = 'historical-energy.json';

describe('engine live-path options refuse inconsistent setups', () => {
  it('cash dividends on total-return prices would count dividends twice', () => {
    expect(() => runBacktest({ ...DEFAULT_CONFIG, dividendsFile: 'dividends.json' }, 30000)).toThrow(/one price basis/);
  });
  it('AUD deposits need an FX series', () => {
    expect(() => runBacktest({ ...DEFAULT_CONFIG, deposits: [{ date: '2024-01-02', amountAud: 1000 }] }, 30000))
      .toThrow(/fxDataFile/);
  });
});

describe.skipIf(!LIVE_STUDY_DATA_AVAILABLE)('engine live-path options (G3/G4/G7, F1)', () => {
  const base: BacktestConfig = {
    ...DEFAULT_CONFIG, dataFile: DATA, symbols: ['KO', 'WMT', 'TLT'], optimizerMethod: 'buy_and_hold',
    useTotalReturn: false, lookbackDays: 60,
  };

  it('G4: pays dividends as cash net of 15% withholding, on raw closes', () => {
    const r = runBacktest({ ...base, dividendsFile: 'dividends.json' }, 30000, undefined, '2024-01-02', '2024-12-31');
    const ko = r.dividends.filter(d => d.symbol === 'KO');
    expect(ko.length).toBe(4); // quarterly
    for (const d of r.dividends) expect(d.withheldUsd).toBeCloseTo(d.grossUsd * 0.15, 9);
    const without = runBacktest(base, 30000, undefined, '2024-01-02', '2024-12-31');
    const net = r.dividends.reduce((s, d) => s + d.grossUsd - d.withheldUsd, 0);
    expect(r.finalPortfolioValue - without.finalPortfolioValue).toBeCloseTo(net, 0);
  });

  it('G3: AUD deposits land at that day\'s rate and are not counted as return', () => {
    const deposits = [{ date: '2024-06-03', amountAud: 15_000 }];
    const r = runBacktest({ ...base, fxDataFile: 'fx-audusd.json', deposits }, 30000, undefined, '2024-01-02', '2024-12-31');
    expect(r.flows).toHaveLength(1);
    expect(r.flows[0].amountUsd).toBeGreaterThan(9_000);
    expect(r.flows[0].amountUsd).toBeLessThan(11_000);
    // No day's return is the deposit (a 30%+ jump on a staples/bond book).
    expect(Math.max(...r.dailyReturns)).toBeLessThan(0.05);
    expect(r.dailyDates.length).toBe(r.dailyValues.length);
  });

  it('G3: missed runs are deterministic for a seed and near the configured rate', () => {
    const cfg: BacktestConfig = { ...LIVE_CONFIG, dataFile: DATA, symbols: ['KO', 'WMT', 'TLT'], staticWeights: [1, 1, 1], lookbackDays: 60, missedRunRate: 0.2, missedRunSeed: 7 };
    const a = runBacktest(cfg, 30000, undefined, '2024-01-02', '2024-12-31');
    const b = runBacktest(cfg, 30000, undefined, '2024-01-02', '2024-12-31');
    expect(a.missedRunDays).toBe(b.missedRunDays);
    expect(a.missedRunDays / a.dailyDates.length).toBeGreaterThan(0.12);
    expect(a.missedRunDays / a.dailyDates.length).toBeLessThan(0.28);
  });

  it('G7: IBKR fixed commissions — $0.005/share, $1 minimum, 1% cap', () => {
    const r = runBacktest({ ...base, commissionModel: 'ibkr-fixed' }, 30000, undefined, '2024-01-02', '2024-03-28');
    for (const t of r.trades) {
      expect(t.commission).toBeCloseTo(Math.min(Math.max(1, 0.005 * t.shares), 0.01 * t.shares * t.price), 9);
    }
  });

  it('G7: dated opening lots seed the positions and are consumed FIFO', () => {
    const cfg: BacktestConfig = {
      ...LIVE_CONFIG, dataFile: DATA, symbols: ['KO', 'WMT', 'TLT'], staticWeights: [1, 1, 1], lookbackDays: 60,
      gate: 'bands', commissionModel: 'ibkr-fixed',
      initialLots: [
        { symbol: 'KO', shares: 200, cost: 50, date: '2021-03-01' },
        { symbol: 'KO', shares: 100, cost: 60, date: '2023-11-15' },
        { symbol: 'WMT', shares: 10, cost: 50, date: '2022-05-02' },
      ],
    };
    const r = runBacktest(cfg, 30000, undefined, '2024-01-02', '2024-12-31');
    // KO starts far overweight (~60%), so the band gate trims it, oldest lot first.
    const koSells = r.trades.filter(t => t.symbol === 'KO' && t.action === 'SELL');
    expect(koSells.length).toBeGreaterThan(0);
    const sold = koSells.reduce((s, t) => s + t.shares, 0);
    const koLots = r.finalLots.KO ?? [];
    if (sold < 200) expect(koLots[0].date).toBe('2021-03-01');
    else expect(koLots.every(l => l.date !== '2021-03-01')).toBe(true);
  });

  it('F1: the band gate runs in the engine and only a sell restarts its cooldown', () => {
    const cfg: BacktestConfig = {
      ...LIVE_CONFIG, dataFile: DATA, lookbackDays: 60, gate: 'bands',
      symbols: ['KO', 'WMT', 'TLT', 'GLD', 'LLY'], staticWeights: [2, 2, 2, 2, 2],
    };
    const r = runBacktest(cfg, 30000, undefined, '2022-01-03', '2024-12-31');
    expect(r.trades.length).toBeGreaterThan(5);
    expect(Object.keys(r.decisionCounts).every(k => ['urgent', 'regular', 'too-soon', 'within-threshold'].includes(k))).toBe(true);
    // Consecutive band SELL days are either ≥ the cooldown apart or urgent.
    const sellDays = [...new Set(r.trades.filter(t => t.action === 'SELL' && !t.reason.includes('URGENT')).map(t => t.date))];
    for (let i = 1; i < sellDays.length; i++) {
      const gap = (Date.parse(sellDays[i]) - Date.parse(sellDays[i - 1])) / 86_400_000;
      expect(gap).toBeGreaterThanOrEqual(45);
    }
  });
});
