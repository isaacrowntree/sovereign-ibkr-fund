/**
 * How much insurance do we want, and what does it cost?
 *
 * The regime overlay tries to buy downside protection by PREDICTING when to
 * de-risk. Measured across COVID and 2022 that cost about 100pp of after-tax
 * return for 1.4pp of drawdown, and it was inert in the fast crash — it only
 * applies at rebalance time, and the one COVID rebalance landed on a risk_on day.
 *
 * A structural hedge asks the question differently: hold uncorrelated assets
 * permanently, accept a known continuous drag, and require no forecast. This
 * prices that trade at several sizes.
 *
 * HEDGE = GLD + TLT only. WMT and KO sit in the "defensive" sleeve but they are
 * equities that fall with the market; counting them as insurance would overstate
 * the protection. The GLD:TLT ratio is held at the model's 6:8 while the total
 * varies, and every other holding scales proportionally so the book still sums
 * to 100.
 *
 * The overlay is OFF throughout, deliberately: this isolates the structural
 * effect from the timing effect rather than confounding the two.
 */
import { runBacktest, DEFAULT_CONFIG, loadHistoricalData, type BacktestConfig, type Position } from '../src/validation/backtest-engine.js';
import { toTradeRecords, evaluateAfterTax } from '../src/validation/after-tax.js';
import { TARGET_PORTFOLIO } from '../src/config.js';

const CAPITAL = 30000;
const RATE = 0.47;
const HEDGE = new Set(['GLD', 'TLT']);

const data = loadHistoricalData();
const dates = [...new Set(Object.values(data).flatMap(b => b.map(x => x.date)))].sort();
const BOOK = TARGET_PORTFOLIO.filter(t => (data[t.symbol] ?? []).some(b => b.date < '2020-01-02'));
const SYMS = BOOK.map(t => t.symbol);
const priceOn = (s: string, d: string) => { const a = data[s].filter(b => b.date <= d); return (a[a.length - 1] ?? data[s][0]).close; };

const baseHedge = BOOK.filter(t => HEDGE.has(t.symbol)).reduce((s, t) => s + t.pct, 0);
const baseRisk = BOOK.filter(t => !HEDGE.has(t.symbol)).reduce((s, t) => s + t.pct, 0);

/** Weights (fractions, summing to 1) with the hedge sleeve resized to `hedgePct`. */
function weightsFor(hedgePct: number): number[] {
  return BOOK.map(t => {
    if (HEDGE.has(t.symbol)) return (t.pct / baseHedge) * hedgePct / 100;
    return (t.pct / baseRisk) * (100 - hedgePct) / 100;
  });
}

const SIZES = [0, 14, 20, 25, 30, 40];

function run(label: string, from: string, to: string) {
  const opening = BOOK.map(t => {
    const px = priceOn(t.symbol, from);
    return { symbol: t.symbol, shares: Math.floor((CAPITAL * (t.pct / 100)) / px), price: px };
  });
  const positions: Position[] = opening.map(p => ({ symbol: p.symbol, shares: p.shares }));

  console.log(`\n=== ${label}  (${from} -> ${to}) ===`);
  console.log('hedge%   gross%   after-tax%    liq%   maxDD%   Sharpe   Calmar   trades');
  for (const h of SIZES) {
    const cfg: BacktestConfig = {
      ...DEFAULT_CONFIG, name: `hedge${h}`, symbols: SYMS,
      optimizerMethod: 'static', staticWeights: weightsFor(h),
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
      `${String(h).padStart(5)}   ${t.grossReturnPct.toFixed(1).padStart(6)}   ${t.afterTaxReturnPct.toFixed(1).padStart(9)}  ` +
      `${tl.afterTaxReturnPct.toFixed(1).padStart(6)}   ${r.maxDrawdownPct.toFixed(1).padStart(6)}   ` +
      `${r.sharpeRatio.toFixed(2).padStart(6)}   ${calmar.toFixed(2).padStart(6)}   ${String(t.trades).padStart(6)}`,
    );
  }
}

console.log(`${SYMS.length} holdings; hedge sleeve = GLD + TLT (model: ${baseHedge}%), overlay OFF throughout`);
run('COVID CRASH — fast collapse, V recovery', dates[0], '2020-09-30');
run('2022 BEAR — slow grind', '2021-11-01', '2023-03-31');
run('FULL PERIOD — both crashes', dates[0], dates[dates.length - 1]);
