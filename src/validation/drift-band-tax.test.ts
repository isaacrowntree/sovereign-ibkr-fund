/**
 * Drift band × Australian CGT (2026-08-29).
 *
 * The walk-forward picked a 5% drift band in 5 of 6 folds; production runs
 * 10%. docs/backtesting.md warns the mechanism that decides this is not trade
 * count but WHEN gains are realised: a tighter band forces more disposals
 * inside the 12-month line, where they miss the 50% CGT discount entirely.
 * This study settles whether 5% survives the after-tax lens.
 *
 * Method: honest engine (slippage, total-return prices, production regime
 * gate), synthetic $30k from cash, drift ∈ {5, 10, 15}, on both the default
 * window and the long dataset. After-tax via the SAME code path as the live
 * CGT report (evaluateAfterTax → generateTaxSummary), marginal rate 0.47
 * (sensitivity at 0.32). Per the methodology doc, two figures per config:
 * deferral-only (tax on realised gains) and terminal-liquidation (the whole
 * book sold on the final day, so deferred liabilities count too). Disposal
 * lots are split at the 12-month line to expose the mechanism directly.
 *
 * Plus: the walk-forward re-scored with an after-tax train metric, to see
 * whether 5% still wins folds when tax is part of the objective.
 */
import { describe, it, expect } from 'vitest';
import { BACKTEST_DATA_AVAILABLE, LONG_DATA_AVAILABLE } from './data-available';
import { runBacktest, loadHistoricalData, DEFAULT_CONFIG, type BacktestConfig, type BacktestResult } from './backtest-engine';
import { evaluateAfterTax, toTradeRecords } from './after-tax';
import { computeTaxLots } from '../tax/report';
import type { TradeRecord } from '../state/store';

const RATE = 0.47;      // top AU marginal rate incl. Medicare — after-tax.test.ts convention
const RATE_LOW = 0.32;  // middle-bracket sensitivity
const CAPITAL = 30000;

function lastPrices(dataFile: string | undefined, useTotalReturn: boolean): Map<string, number> {
  const data = loadHistoricalData(dataFile);
  const prices = new Map<string, number>();
  for (const [sym, bars] of Object.entries(data)) {
    const b = bars[bars.length - 1];
    prices.set(sym, useTotalReturn ? (b.adjClose || b.close) : b.close);
  }
  return prices;
}

/** Records incl. a synthetic final-day liquidation of everything still held. */
function withTerminalLiquidation(result: BacktestResult, records: TradeRecord[], dataFile?: string): TradeRecord[] {
  const prices = lastPrices(dataFile, true);
  const extra: TradeRecord[] = result.finalPositions.map((p, i) => ({
    timestamp: new Date(`${result.endDate}T21:00:00Z`).toISOString(), // after the last real fill
    symbol: p.symbol,
    action: 'SELL' as const,
    qty: p.shares,
    estimatedValue: p.shares * (prices.get(p.symbol) ?? 0),
    fillPrice: prices.get(p.symbol) ?? 0,
    orderId: 100000 + i,
    status: 'filled',
    reason: 'terminal liquidation (synthetic, tax bookend)',
    commission: 0,
  }));
  return [...records, ...extra];
}

interface Row {
  label: string;
  gross: number; afterTax: number; afterTaxLiq: number; afterTaxLow: number;
  maxDD: number; trades: number;
  disposals: number; shortTermDisposals: number;
}

function study(drift: number, dataFile: string | undefined, window: string): Row {
  const config: BacktestConfig = {
    ...DEFAULT_CONFIG,
    name: `drift ${drift}%`,
    rebalanceDriftPct: drift,
    ...(dataFile ? { dataFile } : {}),
  };
  const r = runBacktest(config, CAPITAL);
  const records = toTradeRecords(r, [], r.startDate);
  const deferral = evaluateAfterTax(r, records, RATE);
  const deferralLow = evaluateAfterTax(r, records, RATE_LOW);

  const liqRecords = withTerminalLiquidation(r, records, dataFile);
  // Liquidation converts the whole book to cash at final prices, so gross
  // stays finalPortfolioValue; only the tax differs.
  const liq = evaluateAfterTax(r, liqRecords, RATE);

  const lots = computeTaxLots(records); // realised disposals only (no bookend)
  const st = lots.filter(l => !l.longTerm).length;

  return {
    label: `${window} drift ${String(drift).padStart(2)}%`,
    gross: r.totalReturn,
    afterTax: deferral.afterTaxReturnPct,
    afterTaxLiq: liq.afterTaxReturnPct,
    afterTaxLow: deferralLow.afterTaxReturnPct,
    maxDD: r.maxDrawdownPct,
    trades: r.trades.length,
    disposals: lots.length,
    shortTermDisposals: st,
  };
}

describe.skipIf(!BACKTEST_DATA_AVAILABLE)('Drift band under AU CGT', () => {
  it('drift 5/10/15 pre-tax and after-tax, default + long windows', () => {
    const rows: Row[] = [];
    for (const drift of [5, 10, 15]) rows.push(study(drift, undefined, 'default'));
    if (LONG_DATA_AVAILABLE) {
      for (const drift of [5, 10, 15]) rows.push(study(drift, 'historical-long.json', 'long   '));
    }

    console.log('\n=== DRIFT BAND × AU CGT (synthetic $30k, marginal 47%) ===');
    console.log('  window/drift        gross    after-tax  liq-bookend  @32%     maxDD   trades  disposals(<12m)');
    for (const r of rows) {
      console.log(
        `  ${r.label}   ${r.gross.toFixed(1).padStart(7)}%  ${r.afterTax.toFixed(1).padStart(7)}%  ${r.afterTaxLiq.toFixed(1).padStart(9)}%  ${r.afterTaxLow.toFixed(1).padStart(6)}%  ${r.maxDD.toFixed(1).padStart(5)}%  ${String(r.trades).padStart(5)}  ${String(r.disposals).padStart(5)} (${r.shortTermDisposals})`,
      );
    }

    for (const r of rows) {
      expect(Number.isFinite(r.afterTax)).toBe(true);
      // After-tax can never exceed gross when tax was paid
      expect(r.afterTax).toBeLessThanOrEqual(r.gross + 1e-9);
      // The liquidation bookend realises everything, so its tax is >= deferral tax
      expect(r.afterTaxLiq).toBeLessThanOrEqual(r.afterTax + 1e-9);
    }
  }, 600000);
});

describe.skipIf(!LONG_DATA_AVAILABLE)('Walk-forward re-scored after tax', () => {
  it('does drift 5% still win folds when the train metric is after-tax?', () => {
    const DATA_FILE = 'historical-long.json';
    const data = loadHistoricalData(DATA_FILE);
    let longest = Object.keys(data)[0];
    for (const s of Object.keys(data)) if (data[s].length > data[longest].length) longest = s;
    const dates = data[longest].map(b => b.date);

    const GRID: Array<{ drift: number; freq: number; vol: number }> = [];
    for (const drift of [5, 10, 15])
      for (const freq of [30, 45, 60])
        for (const vol of [0.15, 0.20, 0.25])
          GRID.push({ drift, freq, vol });

    const TRAIN = 300, TEST = 150, WARMUP = 200;
    const driftWins: Record<string, number> = {};
    const folds: string[] = [];

    for (let trainStart = WARMUP; trainStart + TRAIN + TEST <= dates.length; trainStart += TEST) {
      const trainEnd = trainStart + TRAIN;
      const dTrainStart = dates[trainStart], dTrainEnd = dates[trainEnd - 1];

      let best = GRID[0];
      let bestScore = -Infinity;
      for (const g of GRID) {
        const r = runBacktest({
          ...DEFAULT_CONFIG, name: 'train', dataFile: DATA_FILE,
          rebalanceDriftPct: g.drift, rebalanceFreqDays: g.freq, targetVol: g.vol,
        }, CAPITAL, undefined, dTrainStart, dTrainEnd);
        const at = evaluateAfterTax(r, toTradeRecords(r, [], r.startDate), RATE);
        const score = at.afterTaxReturnPct / Math.max(r.maxDrawdownPct, 5);
        if (score > bestScore) { bestScore = score; best = g; }
      }
      driftWins[`${best.drift}%`] = (driftWins[`${best.drift}%`] ?? 0) + 1;
      folds.push(`${dates[trainEnd]}→: drift=${best.drift}% freq=${best.freq}d vol=${(best.vol * 100).toFixed(0)}%`);
    }

    console.log('\n=== WALK-FORWARD, AFTER-TAX TRAIN METRIC (47%) ===');
    for (const f of folds) console.log(`  ${f}`);
    console.log(`  drift winners: ${JSON.stringify(driftWins)}`);

    expect(folds.length).toBeGreaterThanOrEqual(5);
  }, 600000);
});
