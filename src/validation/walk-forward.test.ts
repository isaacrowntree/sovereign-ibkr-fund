/**
 * Walk-forward validation of the rebalance tunables (2026-08-29).
 *
 * The parameter sweep picks winners of its own sample; docs/backtesting.md
 * already warns that judging a config there measures the sweep, not the
 * strategy. This test does the honest version: rolling 300-trading-day train /
 * 150-day test folds over the long dataset (2020-10 →, includes the 2022
 * bear). Per fold, a 27-config grid (drift × cadence × vol target) is ranked
 * on the TRAIN slice by Calmar-like score (return% / max(maxDD%, 5)); the
 * winner runs the TEST slice out-of-sample. OOS results chain
 * multiplicatively and are compared against the fixed production defaults and
 * buy-and-hold on the identical spans.
 *
 * Runs on the audited engine: slippage, total-return prices, production
 * regime gate. Uses the core 7-name universe — see the survivorship note in
 * flaw-proofs/docs: this universe is today's winners, so ABSOLUTE returns
 * are inflated; the train-vs-test comparison inside the same universe is
 * what this test is for.
 */
import { describe, it, expect } from 'vitest';
import { LONG_DATA_AVAILABLE } from './data-available';
import { runBacktest, loadHistoricalData, DEFAULT_CONFIG, type BacktestConfig } from './backtest-engine';

const DATA_FILE = 'historical-long.json';

interface GridPoint { drift: number; freq: number; vol: number }
const GRID: GridPoint[] = [];
for (const drift of [5, 10, 15])
  for (const freq of [30, 45, 60])
    for (const vol of [0.15, 0.20, 0.25])
      GRID.push({ drift, freq, vol });

const asConfig = (g: GridPoint, name: string): BacktestConfig => ({
  ...DEFAULT_CONFIG,
  name,
  dataFile: DATA_FILE,
  rebalanceDriftPct: g.drift,
  rebalanceFreqDays: g.freq,
  targetVol: g.vol,
});

const score = (r: { totalReturn: number; maxDrawdownPct: number }) =>
  r.totalReturn / Math.max(r.maxDrawdownPct, 5);

describe.skipIf(!LONG_DATA_AVAILABLE)('Walk-forward: rebalance tunables', () => {
  it('rolling 300d-train / 150d-test folds, chained OOS', () => {
    const data = loadHistoricalData(DATA_FILE);
    // Timeline of the longest series (same rule the engine uses)
    let longest = Object.keys(data)[0];
    for (const s of Object.keys(data)) if (data[s].length > data[longest].length) longest = s;
    const dates = data[longest].map(b => b.date);

    const TRAIN = 300, TEST = 150;
    const WARMUP = 200; // regime gate needs 200 days before the first train day

    interface Fold { chosen: GridPoint; oosRet: number; oosDD: number; defRet: number; bhRet: number; span: string }
    const folds: Fold[] = [];

    for (let trainStart = WARMUP; trainStart + TRAIN + TEST <= dates.length; trainStart += TEST) {
      const trainEnd = trainStart + TRAIN;
      const testEnd = trainEnd + TEST;
      const dTrainStart = dates[trainStart], dTrainEnd = dates[trainEnd - 1];
      const dTestStart = dates[trainEnd], dTestEnd = dates[testEnd - 1];

      let best: GridPoint = GRID[0];
      let bestScore = -Infinity;
      for (const g of GRID) {
        const r = runBacktest(asConfig(g, 'train'), 30000, undefined, dTrainStart, dTrainEnd);
        const sc = score(r);
        if (sc > bestScore) { bestScore = sc; best = g; }
      }

      const oos = runBacktest(asConfig(best, 'oos'), 30000, undefined, dTestStart, dTestEnd);
      const def = runBacktest({ ...DEFAULT_CONFIG, name: 'def', dataFile: DATA_FILE }, 30000, undefined, dTestStart, dTestEnd);
      const bh = runBacktest({ ...DEFAULT_CONFIG, name: 'bh', dataFile: DATA_FILE, optimizerMethod: 'buy_and_hold' }, 30000, undefined, dTestStart, dTestEnd);

      folds.push({
        chosen: best,
        oosRet: oos.totalReturn, oosDD: oos.maxDrawdownPct,
        defRet: def.totalReturn, bhRet: bh.totalReturn,
        span: `${dTestStart}→${dTestEnd}`,
      });
    }

    console.log('\n=== WALK-FORWARD FOLDS (OOS 150-trading-day windows) ===');
    for (const f of folds) {
      console.log(
        `  ${f.span}  picked drift=${f.chosen.drift}% freq=${f.chosen.freq}d vol=${(f.chosen.vol * 100).toFixed(0)}%  ` +
        `OOS ${f.oosRet.toFixed(1).padStart(6)}% (DD ${f.oosDD.toFixed(1)}%)  ` +
        `defaults ${f.defRet.toFixed(1).padStart(6)}%  B&H ${f.bhRet.toFixed(1).padStart(6)}%`,
      );
    }

    const chain = (vals: number[]) => (vals.reduce((a, r) => a * (1 + r / 100), 1) - 1) * 100;
    const wf = chain(folds.map(f => f.oosRet));
    const def = chain(folds.map(f => f.defRet));
    const bh = chain(folds.map(f => f.bhRet));
    console.log(`\n  Chained OOS ${folds[0].span.slice(0, 10)} → ${folds[folds.length - 1].span.slice(11)}:`);
    console.log(`    walk-forward selected: ${wf.toFixed(1)}%  (worst fold DD ${Math.max(...folds.map(f => f.oosDD)).toFixed(1)}%)`);
    console.log(`    fixed defaults:        ${def.toFixed(1)}%`);
    console.log(`    buy & hold:            ${bh.toFixed(1)}%`);

    const tally = (get: (g: GridPoint) => string | number) => {
      const m: Record<string, number> = {};
      folds.forEach(f => { const k = String(get(f.chosen)); m[k] = (m[k] || 0) + 1; });
      return Object.entries(m).map(([k, v]) => `${k}×${v}`).join(' ');
    };
    console.log(`\n  Param stability across ${folds.length} folds:`);
    console.log(`    drift: ${tally(g => g.drift + '%')}`);
    console.log(`    freq:  ${tally(g => g.freq + 'd')}`);
    console.log(`    vol:   ${tally(g => (g.vol * 100) + '%')}`);

    expect(folds.length).toBeGreaterThanOrEqual(5);
    // The lock: parameters chosen only on unseen-past data must not collapse.
    // (Absolute levels are universe-inflated; the guard is against the
    // strategy only working with hindsight-picked parameters.)
    expect(wf).toBeGreaterThan(-20);
  }, 600000);
});
