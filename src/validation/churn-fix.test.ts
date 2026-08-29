/**
 * Churn-fix validation (2026-08-29).
 *
 * Diagnosis (honest engine + faithful gate, long window, drift 10, static):
 * 71 of 101 cash-flow fills rebought a name the strategy itself sold within
 * the prior 30 days (median gap 5 days, ~$555k notional round-tripped on a
 * $30k book), driven by one-notch regime flapping (risk_on 1.0 ↔ neutral
 * 0.85 crossed constantly: 512 vs 414 day census). Sell leg:
 * exposure-scaled targets feed computeDrift → decideRebalance fires. Rebuy
 * leg: allocateCashFlow (buy-only) on later within-threshold days. Every
 * round trip realises short-term gains — none earn the CGT discount — and
 * the sequencing is systematically sell-low/rebuy-high (overlay ON cost
 * ~25pp of max drawdown vs OFF).
 *
 * Guards under test (both config-gated, default OFF, in production paths):
 *   A dampExposure dead-band 0.2 — one-notch regime flaps stop trading;
 *     genuine de-risking (risk_off/crisis) passes through.
 *   B allocateCashFlow rebuy guard 30d — cash-flow skips names sold within
 *     30 days; their share of the deposit stays in cash.
 *
 * METRIC, LOCKED BEFORE THE RUNS: after-tax return with terminal-liquidation
 * bookend at 47% marginal (secondary: 32%), and max drawdown. The original
 * claim ("the fix removes churn cost without degrading protection") held for
 * drawdown and OOS return and FAILED for bull-window return — see the
 * VALIDATION OUTCOME comment in the describe block; the honest result is
 * locked either way.
 */
import { describe, it, expect } from 'vitest';
import { BACKTEST_DATA_AVAILABLE, LONG_DATA_AVAILABLE } from './data-available';
import { runBacktest, loadHistoricalData, DEFAULT_CONFIG, type BacktestConfig, type BacktestResult } from './backtest-engine';
import { evaluateAfterTax, toTradeRecords } from './after-tax';
import { computeTaxLots } from '../tax/report';
import type { TradeRecord } from '../state/store';

const RATE = 0.47, RATE_LOW = 0.32, CAPITAL = 30000;

const EXAMPLE_POSITIONS = [
  { symbol: 'AMZN', shares: 5 }, { symbol: 'ARM', shares: 5 },
  { symbol: 'BRK-B', shares: 10 }, { symbol: 'NET', shares: 50 },
  { symbol: 'PLTR', shares: 10 }, { symbol: 'TSLA', shares: 10 },
  { symbol: 'TWLO', shares: 20 },
];

function modelWeights(): { symbols: string[]; weights: number[] } {
  const data = loadHistoricalData();
  const values = EXAMPLE_POSITIONS.map(p => {
    const bar = data[p.symbol][0];
    return { symbol: p.symbol, value: p.shares * (bar.adjClose || bar.close) };
  });
  const total = values.reduce((s, v) => s + v.value, 0);
  return { symbols: values.map(v => v.symbol), weights: values.map(v => v.value / total) };
}

function pricesAt(dataFile: string | undefined, date: string): Map<string, number> {
  const data = loadHistoricalData(dataFile);
  const prices = new Map<string, number>();
  for (const [sym, bars] of Object.entries(data)) {
    let b = bars[0];
    for (const bar of bars) { if (bar.date > date) break; b = bar; }
    prices.set(sym, b.adjClose || b.close);
  }
  return prices;
}

function withTerminalLiquidation(result: BacktestResult, records: TradeRecord[], dataFile?: string): TradeRecord[] {
  const prices = pricesAt(dataFile, result.endDate);
  const extra: TradeRecord[] = result.finalPositions.map((p, i) => ({
    timestamp: new Date(`${result.endDate}T21:00:00Z`).toISOString(),
    symbol: p.symbol, action: 'SELL' as const, qty: p.shares,
    estimatedValue: p.shares * (prices.get(p.symbol) ?? 0),
    fillPrice: prices.get(p.symbol) ?? 0,
    orderId: 100000 + i, status: 'filled',
    reason: 'terminal liquidation (synthetic, tax bookend)', commission: 0,
  }));
  return [...records, ...extra];
}

interface Row {
  label: string; gross: number; liq47: number; liq32: number;
  maxDD: number; trades: number; stDisposals: number; rebuys30: number;
}

export function measure(label: string, overrides: Partial<BacktestConfig>, dataFile: string | undefined, endDate?: string, startDate?: string): Row {
  const model = modelWeights();
  const r = runBacktest({
    ...DEFAULT_CONFIG, name: label, optimizerMethod: 'static',
    symbols: model.symbols, staticWeights: model.weights,
    rebalanceDriftPct: 10,
    ...(dataFile ? { dataFile } : {}), ...overrides,
  }, CAPITAL, undefined, startDate, endDate);

  const records = toTradeRecords(r, [], r.startDate);
  const liqRecords = withTerminalLiquidation(r, records, dataFile);
  const liq47 = evaluateAfterTax(r, liqRecords, RATE);
  const liq32 = evaluateAfterTax(r, liqRecords, RATE_LOW);
  const stDisposals = computeTaxLots(records).filter(l => !l.longTerm).length;

  const lastSell = new Map<string, number>();
  let rebuys30 = 0;
  for (const t of r.trades) {
    const ms = new Date(t.date).getTime();
    if (t.action === 'SELL') lastSell.set(t.symbol, ms);
    else if (t.reason === 'cash_flow_rebalance') {
      const s = lastSell.get(t.symbol);
      if (s !== undefined && ms - s <= 30 * 86400000) rebuys30++;
    }
  }

  return {
    label, gross: r.totalReturn,
    liq47: liq47.afterTaxReturnPct, liq32: liq32.afterTaxReturnPct,
    maxDD: r.maxDrawdownPct, trades: r.trades.length,
    stDisposals, rebuys30,
  };
}

const FIX = { exposureDeadBand: 0.2, cashFlowRebuyGuardDays: 30 };

function printRows(header: string, rows: Row[]) {
  console.log(`\n=== ${header} ===`);
  console.log('  config                         gross   liq@47   liq@32   maxDD  trades  ST-disp  rebuy<30d');
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(28)} ${r.gross.toFixed(1).padStart(7)}% ${r.liq47.toFixed(1).padStart(7)}% ${r.liq32.toFixed(1).padStart(7)}% ${r.maxDD.toFixed(1).padStart(6)}% ${String(r.trades).padStart(6)} ${String(r.stDisposals).padStart(8)} ${String(r.rebuys30).padStart(9)}`,
    );
  }
}

describe.skipIf(!BACKTEST_DATA_AVAILABLE || !LONG_DATA_AVAILABLE)('Churn fix validation', () => {
  const CONFIGS: Array<[string, Partial<BacktestConfig>]> = [
    ['unfixed, overlay ON', {}],
    ['fixed,   overlay ON', FIX],
    ['dead-band only', { exposureDeadBand: 0.2 }],
    ['rebuy-guard only', { cashFlowRebuyGuardDays: 30 }],
    ['unfixed, overlay OFF', { enableRegimeOverlay: false }],
  ];

  // VALIDATION OUTCOME (locks below record what was measured, including the
  // finding that ran against the original claim):
  //  - The rebuy guard ALONE is the fix. It zeroes rebuy churn, restores the
  //    overlay's protective function (long-window maxDD 66% → 35%, now BETTER
  //    than overlay OFF — previously worse), and turns the OOS bear cut from
  //    -33% to -1% liq@47.
  //  - The dead-band is not robust (helps one window, hurts another; the
  //    combined config is dominated by guard-only on the long window). It
  //    stays implemented but is not recommended.
  //  - The churn had been accidentally PROFITABLE in bull windows (rebuying
  //    trims kept the book more invested while prices rose), so removing it
  //    costs full-window return. OOS shows that profit was uncompensated
  //    bear risk: the same mechanism produced the -33%.

  it('long window (2020-10 →)', () => {
    const rows = CONFIGS.map(([l, o]) => measure(l, o, 'historical-long.json'));
    printRows('LONG WINDOW', rows);
    const [unfixed, , , guardOnly, off] = rows;
    expect(guardOnly.rebuys30).toBe(0);                       // churn removed
    expect(guardOnly.stDisposals).toBeLessThan(unfixed.stDisposals);
    expect(guardOnly.maxDD).toBeLessThan(unfixed.maxDD - 20); // 66% → 35%
    expect(guardOnly.maxDD).toBeLessThan(off.maxDD);          // overlay finally protective
    // The honest trade-off, locked so nobody mistakes the guard for free:
    expect(guardOnly.liq47).toBeLessThan(unfixed.liq47);      // bull-profit churn removed
    expect(guardOnly.liq47).toBeGreaterThan(unfixed.liq47 - 10);
  }, 600000);

  it('default window (2023-10 →)', () => {
    const rows = CONFIGS.map(([l, o]) => measure(l, o, undefined));
    printRows('DEFAULT WINDOW', rows);
    const [unfixed, , , guardOnly] = rows;
    expect(guardOnly.rebuys30).toBe(0);
    // Locked trade-off: in the recent bull the churn was worth ~30pp liq@47.
    // This is the cost side of the OOS/drawdown win above.
    expect(guardOnly.liq47).toBeLessThan(unfixed.liq47);
  }, 600000);

  it('OOS cut (2020-10 → 2023-09)', () => {
    const rows = CONFIGS.map(([l, o]) => measure(l, o, 'historical-long.json', '2023-09-29'));
    printRows('OOS < 2023-10', rows);
    const [unfixed, , , guardOnly, off] = rows;
    expect(guardOnly.liq47).toBeGreaterThan(unfixed.liq47 + 20); // -33% → -1%
    expect(guardOnly.liq47).toBeGreaterThan(off.liq47);          // beats overlay-off too
    expect(guardOnly.maxDD).toBeLessThan(unfixed.maxDD - 20);
  }, 600000);
});

describe.skipIf(!LONG_DATA_AVAILABLE)('Re-tune on the fixed system (walk-forward)', () => {
  it('guard window × drift band, locked metric liq@47 Calmar', () => {
    const DATA_FILE = 'historical-long.json';
    const data = loadHistoricalData(DATA_FILE);
    let longest = Object.keys(data)[0];
    for (const s of Object.keys(data)) if (data[s].length > data[longest].length) longest = s;
    const dates = data[longest].map(b => b.date);

    const GRID: Array<{ guard: number; drift: number }> = [];
    for (const guard of [0, 14, 30, 60])
      for (const drift of [5, 10, 15])
        GRID.push({ guard, drift });

    const TRAIN = 300, TEST = 150, WARMUP = 200;
    const score = (r: Row) => r.liq47 / Math.max(r.maxDD, 5);
    const winners: Record<string, number> = {};
    const oosSelected: number[] = [], oosFixed: number[] = [], oosUnfixed: number[] = [];
    const foldLines: string[] = [];

    for (let trainStart = WARMUP; trainStart + TRAIN + TEST <= dates.length; trainStart += TEST) {
      const trainEnd = trainStart + TRAIN;
      const testEnd = trainEnd + TEST;
      let best = GRID[0], bestScore = -Infinity;
      for (const g of GRID) {
        const r = measure('train', { rebalanceDriftPct: g.drift, cashFlowRebuyGuardDays: g.guard }, DATA_FILE, dates[trainEnd - 1], dates[trainStart]);
        const sc = score(r);
        if (sc > bestScore) { bestScore = sc; best = g; }
      }
      winners[`g${best.guard}/d${best.drift}`] = (winners[`g${best.guard}/d${best.drift}`] ?? 0) + 1;
      const sel = measure('oos-sel', { rebalanceDriftPct: best.drift, cashFlowRebuyGuardDays: best.guard }, DATA_FILE, dates[testEnd - 1], dates[trainEnd]);
      const fix = measure('oos-fix', { rebalanceDriftPct: 10, cashFlowRebuyGuardDays: 30 }, DATA_FILE, dates[testEnd - 1], dates[trainEnd]);
      const unf = measure('oos-unf', { rebalanceDriftPct: 10 }, DATA_FILE, dates[testEnd - 1], dates[trainEnd]);
      oosSelected.push(sel.liq47); oosFixed.push(fix.liq47); oosUnfixed.push(unf.liq47);
      foldLines.push(`  ${dates[trainEnd]}→${dates[testEnd - 1]}  picked guard=${best.guard}d drift=${best.drift}%  OOS liq47: selected ${sel.liq47.toFixed(1)}% | guard30/d10 ${fix.liq47.toFixed(1)}% | unfixed ${unf.liq47.toFixed(1)}%`);
    }

    const chain = (v: number[]) => (v.reduce((a, r) => a * (1 + r / 100), 1) - 1) * 100;
    console.log('\n=== RE-TUNE WALK-FORWARD (fixed system, liq@47 Calmar train metric) ===');
    for (const l of foldLines) console.log(l);
    console.log(`  winners: ${JSON.stringify(winners)}`);
    console.log(`  chained OOS liq47: WF-selected ${chain(oosSelected).toFixed(1)}% | fixed guard30/d10 ${chain(oosFixed).toFixed(1)}% | unfixed d10 ${chain(oosUnfixed).toFixed(1)}%`);

    expect(oosSelected.length).toBeGreaterThanOrEqual(5);
  }, 600000);
});
