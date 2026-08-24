import { runBacktest, DEFAULT_CONFIG, loadHistoricalData, type BacktestConfig, type Position } from '../src/validation/backtest-engine.js';
import { toTradeRecords, evaluateAfterTax } from '../src/validation/after-tax.js';
import { TARGET_PORTFOLIO } from '../src/config.js';

const CAPITAL = 30000;
const RATE = 0.47;
// ARM has no history before its 2023 IPO — excluded so the window can reach a
// bear market. Remaining weights renormalised to 100%.
const BOOK = TARGET_PORTFOLIO.filter(t => t.symbol !== 'ARM');
const TOT = BOOK.reduce((s, t) => s + t.pct, 0);
const SYMS = BOOK.map(t => t.symbol);

const data = loadHistoricalData();
const dates = [...new Set(Object.values(data).flatMap(b => b.map(x => x.date)))].sort();
const priceOn = (s, d) => { const a = data[s].filter(b => b.date <= d); return (a[a.length-1] ?? data[s][0]).close; };

const mk = (name, o: Partial<BacktestConfig> = {}): BacktestConfig => ({ ...DEFAULT_CONFIG, name, symbols: SYMS, ...o });
const STATIC_W = BOOK.map(t => t.pct / TOT);
const GROWTH = { optimizerMethod: 'hrp' as const, lookbackDays: 60, rebalanceDriftPct: 15, rebalanceFreqDays: 60,
  targetVol: 0.20, drawdownLimits: { warningPct: 10, deriskPct: 20, hardStopPct: 30 } };

const CONFIGS: Array<[string, BacktestConfig]> = [
  ['Hold the model book',          mk('bh',      { optimizerMethod: 'buy_and_hold' })],
  // What the fund ACTUALLY runs today: static targets, 5% drift, 45-day cooldown,
  // regime overlay on. Previously inexpressible — approximated as buy-and-hold.
  ['LIVE: static @ drift 5%',      mk('live',    { optimizerMethod: 'static', staticWeights: STATIC_W, rebalanceDriftPct: 5, rebalanceFreqDays: 45, enableRegimeOverlay: true })],
  ['static @ drift 10%',           mk('s10',     { optimizerMethod: 'static', staticWeights: STATIC_W, rebalanceDriftPct: 10, rebalanceFreqDays: 45, enableRegimeOverlay: true })],
  ['static @ drift 15%, freq 60d', mk('s15',     { optimizerMethod: 'static', staticWeights: STATIC_W, rebalanceDriftPct: 15, rebalanceFreqDays: 60, enableRegimeOverlay: true })],
  ['Diversified Growth (overlay OFF)', mk('growth-off', { ...GROWTH, enableRegimeOverlay: false })],
  ['Diversified Growth (overlay ON)',  mk('growth-on',  { ...GROWTH, enableRegimeOverlay: true })],
  ['HRP @ live drift 5%',          mk('hrp5',    { optimizerMethod: 'hrp', rebalanceDriftPct: 5, rebalanceFreqDays: 45 })],
];

function run(label: string, from: string, to: string) {
  const startPrices = BOOK.map(t => ({ symbol: t.symbol, shares: Math.floor((CAPITAL * (t.pct / TOT)) / priceOn(t.symbol, from)), price: priceOn(t.symbol, from) }));
  const openingPositions: Position[] = startPrices.map(p => ({ symbol: p.symbol, shares: p.shares }));
  console.log(`\n=== ${label}  (${from} -> ${to}) ===`);
  console.log('strategy                              trades   gross%   after-tax%   liq%    maxDD%   Sharpe   ST$      LT$');
  for (const [name, cfg] of CONFIGS) {
    const r = runBacktest(cfg, CAPITAL, openingPositions, from, to);
    const recs = toTradeRecords(r, startPrices, `${from}T20:00:00Z`);
    const t = evaluateAfterTax(r, recs, RATE);
    const liq = [...recs];
    r.finalPositions.filter(p => p.shares > 0).forEach((p, i) => liq.push({
      timestamp: new Date(`${to}T20:00:00Z`).toISOString(), symbol: p.symbol, action: 'SELL', qty: p.shares,
      estimatedValue: p.shares * priceOn(p.symbol, to), fillPrice: priceOn(p.symbol, to),
      orderId: 900000 + i, status: 'filled', reason: 'terminal liquidation', commission: 0 }));
    const tl = evaluateAfterTax(r, liq, RATE);
    console.log(
      `${name.padEnd(36)} ${String(t.trades).padStart(5)}   ${t.grossReturnPct.toFixed(1).padStart(6)}   ` +
      `${t.afterTaxReturnPct.toFixed(1).padStart(8)}   ${tl.afterTaxReturnPct.toFixed(1).padStart(6)}  ` +
      `${r.maxDrawdownPct.toFixed(1).padStart(6)}   ${r.sharpeRatio.toFixed(2).padStart(6)}   ` +
      `${t.shortTermGain.toFixed(0).padStart(6)}   ${t.longTermGain.toFixed(0).padStart(7)}`);
  }
}

console.log(`${SYMS.length} holdings (ARM excluded), AU CGT @ ${RATE*100}%`);
run('OUT-OF-SAMPLE — includes the 2022 bear market', dates[0], '2023-09-29');
run('The window Growth was selected on', '2023-10-02', dates[dates.length-1]);
run('Full period', dates[0], dates[dates.length-1]);
