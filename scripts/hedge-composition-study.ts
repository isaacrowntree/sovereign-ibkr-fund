/**
 * What should the 14% hedge sleeve be MADE of?
 *
 * Sizing is settled: 14% has the best Sharpe and Calmar of every size tested,
 * and more does not buy protection. The open question is composition, because
 * the two crashes in the data punished opposite things:
 *
 *   window          book%    GLD    TLT    XLE
 *   COVID crash     -26.9   -3.6  +14.2  -56.1     (growth shock, rates cut)
 *   2022 bear       -24.8   -7.3  -29.3  +44.5     (rate shock, inflation)
 *
 * TLT hedges deflationary shocks and FAILS in inflationary ones — worse than the
 * equity book it was meant to protect. XLE is the mirror image. GLD is the only
 * asset that was merely mildly negative in both, and the only one with near-zero
 * correlation to the book (0.114 vs TLT -0.081, XLE 0.481).
 *
 * So the current 6:8 GLD:TLT is a bet that crises are deflationary. That bet paid
 * for forty years and failed in 2022. This prices the alternatives.
 */
import { runBacktest, DEFAULT_CONFIG, loadHistoricalData, type BacktestConfig, type Position } from '../src/validation/backtest-engine.js';
import { toTradeRecords, evaluateAfterTax } from '../src/validation/after-tax.js';
import { TARGET_PORTFOLIO } from '../src/config.js';

const CAPITAL = 30000, RATE = 0.47, HEDGE_PCT = 14;
const data = loadHistoricalData();
const dates = [...new Set(Object.values(data).flatMap(b => b.map(x => x.date)))].sort();
const RISK = TARGET_PORTFOLIO.filter(t => !['GLD', 'TLT'].includes(t.symbol))
  .filter(t => (data[t.symbol] ?? []).some(b => b.date < '2020-01-02'));
const riskTotal = RISK.reduce((s, t) => s + t.pct, 0);
const priceOn = (s: string, d: string) => { const a = data[s].filter(b => b.date <= d); return (a[a.length - 1] ?? data[s][0]).close; };

/** hedge: symbol -> share of the 14% sleeve (must sum to 1). */
const MIXES: Array<[string, Record<string, number>]> = [
  ['GLD 6 / TLT 8  (current)', { GLD: 6 / 14, TLT: 8 / 14 }],
  ['GLD 7 / TLT 7', { GLD: 0.5, TLT: 0.5 }],
  ['GLD 10 / TLT 4', { GLD: 10 / 14, TLT: 4 / 14 }],
  ['GLD 14 (gold only)', { GLD: 1 }],
  ['TLT 14 (bonds only)', { TLT: 1 }],
  ['GLD 6 / TLT 4 / XLE 4', { GLD: 6 / 14, TLT: 4 / 14, XLE: 4 / 14 }],
  ['GLD 7 / XLE 7', { GLD: 0.5, XLE: 0.5 }],
];

function run(label: string, from: string, to: string) {
  console.log(`\n=== ${label}  (${from} -> ${to}) ===`);
  console.log('hedge mix                    gross%  after-tax%   liq%   maxDD%  Sharpe  Calmar');
  for (const [name, mix] of MIXES) {
    const syms = [...RISK.map(t => t.symbol), ...Object.keys(mix)];
    const weights = [
      ...RISK.map(t => (t.pct / riskTotal) * (100 - HEDGE_PCT) / 100),
      ...Object.values(mix).map(share => (share * HEDGE_PCT) / 100),
    ];
    const opening = syms.map((s, i) => {
      const px = priceOn(s, from);
      return { symbol: s, shares: Math.floor((CAPITAL * weights[i]) / px), price: px };
    });
    const positions: Position[] = opening.map(p => ({ symbol: p.symbol, shares: p.shares }));
    const cfg: BacktestConfig = {
      ...DEFAULT_CONFIG, name, symbols: syms, optimizerMethod: 'static', staticWeights: weights,
      rebalanceDriftPct: 10, rebalanceFreqDays: 45, enableRegimeOverlay: false,
    };
    const r = runBacktest(cfg, CAPITAL, positions, from, to);
    const recs = toTradeRecords(r, opening, `${from}T20:00:00Z`);
    const t = evaluateAfterTax(r, recs, RATE);
    const liq = [...recs];
    r.finalPositions.filter(p => p.shares > 0).forEach((p, i) => liq.push({
      timestamp: new Date(`${to}T20:00:00Z`).toISOString(), symbol: p.symbol, action: 'SELL', qty: p.shares,
      estimatedValue: p.shares * priceOn(p.symbol, to), fillPrice: priceOn(p.symbol, to),
      orderId: 900000 + i, status: 'filled', reason: 'terminal liquidation', commission: 0 }));
    const tl = evaluateAfterTax(r, liq, RATE);
    const calmar = r.maxDrawdownPct > 0 ? r.annualizedReturn / r.maxDrawdownPct : 0;
    console.log(
      `${name.padEnd(28)} ${t.grossReturnPct.toFixed(1).padStart(6)}  ${t.afterTaxReturnPct.toFixed(1).padStart(9)}  ` +
      `${tl.afterTaxReturnPct.toFixed(1).padStart(6)}  ${r.maxDrawdownPct.toFixed(1).padStart(6)}  ` +
      `${r.sharpeRatio.toFixed(2).padStart(6)}  ${calmar.toFixed(2).padStart(6)}`);
  }
}

console.log(`hedge sleeve fixed at ${HEDGE_PCT}%; ${RISK.length} risk holdings; overlay OFF`);
run('COVID — growth shock', dates[0], '2020-09-30');
run('2022 — rate shock', '2021-11-01', '2023-03-31');
run('FULL PERIOD — both', dates[0], dates[dates.length - 1]);
