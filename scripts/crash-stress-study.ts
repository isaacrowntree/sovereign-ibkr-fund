/**
 * Stress the live configuration through real crashes.
 *
 * Every prior comparison ran on windows whose worst event was the 2022 grind.
 * The regime overlay and the drawdown ladder exist for something faster, and
 * neither had ever been observed firing on this book. This runs the actual live
 * configuration through the COVID crash (a ~5-week collapse) and the 2022 bear
 * (a 12-month grind), and reports what the machinery DID, not just the return.
 */
import { runBacktest, DEFAULT_CONFIG, loadHistoricalData, type BacktestConfig, type Position } from '../src/validation/backtest-engine.js';
import { toTradeRecords, evaluateAfterTax } from '../src/validation/after-tax.js';
import { TARGET_PORTFOLIO } from '../src/config.js';

const CAPITAL = 30000;
const RATE = 0.47;
const data = loadHistoricalData();
const dates = [...new Set(Object.values(data).flatMap(b => b.map(x => x.date)))].sort();

// Only holdings that existed before COVID; weights renormalised so the book
// still sums to 100. PLTR and ARM had not listed.
const BOOK = TARGET_PORTFOLIO.filter(t => (data[t.symbol] ?? []).some(b => b.date < '2020-01-02'));
const TOT = BOOK.reduce((s, t) => s + t.pct, 0);
const SYMS = BOOK.map(t => t.symbol);
const STATIC_W = BOOK.map(t => t.pct / TOT);
const priceOn = (s: string, d: string) => { const a = data[s].filter(b => b.date <= d); return (a[a.length - 1] ?? data[s][0]).close; };

const mk = (name: string, o: Partial<BacktestConfig> = {}): BacktestConfig => ({ ...DEFAULT_CONFIG, name, symbols: SYMS, ...o });

const CONFIGS: Array<[string, BacktestConfig]> = [
  ['Hold (no rebalancing)', mk('bh', { optimizerMethod: 'buy_and_hold' })],
  ['LIVE (static, drift 10%, overlay ON)', mk('live', {
    optimizerMethod: 'static', staticWeights: STATIC_W, rebalanceDriftPct: 10,
    rebalanceFreqDays: 45, enableRegimeOverlay: true })],
  ['LIVE but overlay OFF', mk('live-off', {
    optimizerMethod: 'static', staticWeights: STATIC_W, rebalanceDriftPct: 10,
    rebalanceFreqDays: 45, enableRegimeOverlay: false })],
  ['Growth (overlay ON)', mk('growth', {
    optimizerMethod: 'hrp', lookbackDays: 60, rebalanceDriftPct: 15, rebalanceFreqDays: 60,
    targetVol: 0.20, enableRegimeOverlay: true,
    drawdownLimits: { warningPct: 10, deriskPct: 20, hardStopPct: 30 } })],
];

function run(label: string, from: string, to: string) {
  const opening = BOOK.map(t => {
    const px = priceOn(t.symbol, from);
    return { symbol: t.symbol, shares: Math.floor((CAPITAL * (t.pct / TOT)) / px), price: px };
  });
  const positions: Position[] = opening.map(p => ({ symbol: p.symbol, shares: p.shares }));

  console.log(`\n=== ${label}  (${from} -> ${to}) ===`);
  console.log('config                                 gross%  after-tax%  maxDD%  haltDays  trades  regimes');
  for (const [name, cfg] of CONFIGS) {
    const r = runBacktest(cfg, CAPITAL, positions, from, to);
    const t = evaluateAfterTax(r, toTradeRecords(r, opening, `${from}T20:00:00Z`), RATE);
    const regimes = Object.entries(r.regimeCounts).map(([k, v]) => `${k}:${v}`).join(' ') || '(none)';
    console.log(
      `${name.padEnd(38)} ${t.grossReturnPct.toFixed(1).padStart(6)}  ${t.afterTaxReturnPct.toFixed(1).padStart(9)}  ` +
      `${r.maxDrawdownPct.toFixed(1).padStart(6)}  ${String(r.hardStopDays).padStart(8)}  ${String(t.trades).padStart(6)}  ${regimes}`,
    );
  }
}

console.log(`${SYMS.length} holdings with pre-COVID history (of ${TARGET_PORTFOLIO.length})`);
console.log(`excluded: ${TARGET_PORTFOLIO.filter(t => !SYMS.includes(t.symbol)).map(t => t.symbol).join(', ')}`);
run('COVID CRASH — fast collapse and rebound', dates[0], '2020-09-30');
run('2022 BEAR — slow grind', '2021-11-01', '2023-03-31');
run('FULL PERIOD — both crashes', dates[0], dates[dates.length - 1]);
