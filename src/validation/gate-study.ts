/**
 * G6 — pre-registered comparison of the legacy drift gate and the F1 band gate
 * (2026-09-24 review). The decision rule below is fixed BEFORE any result is
 * computed and is printed first by scripts/g6-gate-study.ts; docs/backtesting.md
 * records it, dated, above the results.
 *
 * The book is synthetic but has the live shape: the model's 19 names and 2–8%
 * targets, a growth sleeve left ~40% under target (as after the 2026-08-18
 * rebalance, the "Aug-18 residue"), 1% cash, and two dated opening lots per
 * name so the band gate's CGT guard has real lot ages to respect. No account
 * figure is used: capital is a round synthetic number.
 */
import { loadHistoricalData, loadFxSeries, fxOn, runBacktest, type BacktestConfig, type BacktestResult } from './backtest-engine';
import { computeAudCgt, dividendTaxAud, type StudyTrade } from './aud-tax';
import { buildUnitIndex } from '../risk/unit-nav';
import { maxDrawdown } from '../risk/drawdown';

/** Fixed before any run. Changing it after seeing results defeats the point. */
export const DECISION_RULE = {
  registered: '2026-09-24',
  primaryPair: ['legacy', 'bands'] as const,
  primaryWindow: 'W1',
  bearWindow: 'W2',
  marginalRate: 0.47,
  sensitivityRate: 0.32,
  /** Non-inferiority margins (bands − legacy). */
  afterTaxMarginPp: -1.0,
  bootstrapMarginPerYear: -0.01,
  maxDrawdownMarginPp: 2.0,
  bootstrap: { meanBlock: 20, resamples: 5000, seed: 20260924, alpha: 0.05 },
  text: [
    'Metric M1: after-tax AUD liquidation return at a 47% marginal rate (whole book sold on the last day).',
    'Metric M2: maximum drawdown of the daily AUD unit price.',
    'Uncertainty: stationary block bootstrap (mean block 20 days, 5,000 resamples, fixed seed) of paired daily AUD unit-return differences, bands − legacy; one-sided 95% lower bound of the annualised mean.',
    'Bands is NON-INFERIOR — and the switch-on is supported, subject to the live shadow record — iff ALL hold:',
    '  (1) on W1 (full window): M1(bands) − M1(legacy) ≥ −1.0pp;',
    '  (2) on W1: the bootstrap lower bound ≥ −1.0% a year;',
    '  (3) on W1: M2(bands) ≤ M2(legacy) + 2.0pp;',
    '  (4) on W2 (the 2022 bear): M1 difference ≥ −1.0pp and M2(bands) ≤ M2(legacy) + 2.0pp.',
    'Anything else: do not switch on. Secondary figures (32% rate, turnover, disposals inside 12 months, the deposit and missed-run pairs, the ablations) are reported, not decisive.',
  ],
};

export const WINDOWS = {
  W1: { label: 'Full: 2022-01 → 2026-09 (bear, recovery, bull)', from: '2022-01-03', to: '2026-09-04' },
  W2: { label: 'Bear: 2022', from: '2022-01-03', to: '2022-12-30' },
  W3: { label: 'Recent: 2024-01 → 2026-09', from: '2024-01-02', to: '2026-09-04' },
} as const;

export interface StudyTarget { symbol: string; pct: number; sleeve?: string }

export const STUDY_DATA = 'historical-energy.json';
export const STUDY_FX = 'fx-audusd.json';
export const STUDY_DIVIDENDS = 'dividends.json';

/** Raw close of `symbol` on the last trading day on or before `date` (null if none yet). */
export function closeOn(symbol: string, date: string, dataFile = STUDY_DATA): { date: string; close: number } | null {
  const bars = loadHistoricalData(dataFile)[symbol] ?? [];
  let hit: { date: string; close: number } | null = null;
  for (const b of bars) {
    if (b.date > date) break;
    hit = { date: b.date, close: b.close };
  }
  return hit;
}

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The synthetic start book. Names without a price on the start date (a later
 * IPO) are left out and enter through cash flow once they trade, as a new
 * holding would. Lots per name: 60% bought ~15 months before the start (already
 * discount-eligible), 40% bought 200 days before (reaching its discount date
 * ~166 days into the window — the case the CGT guard exists for).
 */
export function buildStartBook(
  targets: readonly StudyTarget[],
  startDate: string,
  capitalUsd: number,
  opts: { residueSleeve?: string; residueFactor?: number; cashPct?: number } = {},
): { lots: NonNullable<BacktestConfig['initialLots']>; weights: Record<string, number> } {
  const residueFactor = opts.residueFactor ?? 0.6;
  const cashPct = opts.cashPct ?? 1;
  const tradable = targets.filter(t => closeOn(t.symbol, startDate) !== null);
  const growth = tradable.filter(t => (opts.residueSleeve ? t.sleeve === opts.residueSleeve : false));
  const rest = tradable.filter(t => !growth.includes(t));
  const tot = tradable.reduce((s, t) => s + t.pct, 0);
  const growthTarget = growth.reduce((s, t) => s + t.pct, 0) / tot;
  const growthHeld = growthTarget * residueFactor;
  const restScale = rest.length ? (1 - cashPct / 100 - growthHeld) / (1 - growthTarget) : 0;
  const weights: Record<string, number> = {};
  for (const t of growth) weights[t.symbol] = (t.pct / tot) * residueFactor;
  for (const t of rest) weights[t.symbol] = (t.pct / tot) * restScale;

  const lots: NonNullable<BacktestConfig['initialLots']> = [];
  for (const [symbol, w] of Object.entries(weights)) {
    const px = closeOn(symbol, startDate)!.close;
    const shares = Math.floor((capitalUsd * w) / px);
    if (shares <= 0) continue;
    const oldQty = Math.floor(shares * 0.6);
    const youngQty = shares - oldQty;
    const oldBuy = closeOn(symbol, shiftDays(startDate, -455)) ?? closeOn(symbol, startDate)!;
    const youngBuy = closeOn(symbol, shiftDays(startDate, -200)) ?? closeOn(symbol, startDate)!;
    if (oldQty > 0) lots.push({ symbol, shares: oldQty, cost: oldBuy.close, date: oldBuy.date });
    if (youngQty > 0) lots.push({ symbol, shares: youngQty, cost: youngBuy.close, date: youngBuy.date });
  }
  return { lots, weights };
}

export interface StudyMetrics {
  afterTaxReturnPct: number;
  afterTaxReturnPctSensitivity: number;
  preTaxReturnPct: number;
  maxDrawdownPct: number;
  /** Daily AUD unit-price returns, aligned to `dates`. */
  unitReturns: number[];
  dates: string[];
  trades: number;
  sells: number;
  turnoverPct: number;
  commissionsUsd: number;
  nonDiscountDisposals: number;
  discountDisposals: number;
  cgtAud: number;
  dividendTaxAud: number;
}

/** After-tax AUD liquidation evaluation of one run. */
export function evaluateRun(
  r: BacktestResult,
  startLots: NonNullable<BacktestConfig['initialLots']>,
  opts: { marginalRate: number; sensitivityRate: number; slippage: number },
): StudyMetrics {
  const fxs = loadFxSeries(STUDY_FX);
  const fx = (d: string): number => fxOn(fxs, d);
  const end = r.endDate;

  const trades: StudyTrade[] = [
    ...startLots.map(l => ({ date: l.date, symbol: l.symbol, action: 'BUY' as const, qty: l.shares, price: l.cost, commission: 0 })),
    ...r.trades.map(t => ({ date: t.date, symbol: t.symbol, action: t.action, qty: t.shares, price: t.price, commission: t.commission })),
  ];
  // Terminal liquidation at the last close, less slippage and IBKR fixed brokerage.
  let positionsValue = 0;
  let liquidationProceeds = 0;
  for (const p of r.finalPositions) {
    if (p.shares <= 0) continue;
    const mid = closeOn(p.symbol, end, r.config.dataFile)!.close;
    positionsValue += p.shares * mid;
    const px = mid * (1 - opts.slippage);
    const commission = Math.min(Math.max(1, 0.005 * p.shares), 0.01 * p.shares * px);
    liquidationProceeds += p.shares * px - commission;
    trades.push({ date: end, symbol: p.symbol, action: 'SELL', qty: p.shares, price: px, commission });
  }
  const cashEnd = r.finalPortfolioValue - positionsValue;
  const cgt = computeAudCgt(trades, fx);
  const divTax = (rate: number): number => dividendTaxAud(r.dividends, fx, rate);
  const grossEndAud = (cashEnd + liquidationProceeds) * fx(end);
  const contributedAud = r.startingCapital * fx(r.startDate) + r.flows.reduce((s, f) => s + f.amountAud, 0);
  const afterTax = (rate: number): number =>
    ((grossEndAud - cgt.totalNetCapitalGain * rate - divTax(rate)) / contributedAud - 1) * 100;

  const idx = buildUnitIndex(
    r.dailyDates.map((d, i) => ({ date: d, navAud: r.dailyValues[i] * fx(d), navUsd: r.dailyValues[i], audPerUsd: fx(d) })),
    r.flows.map((f, i) => ({ id: `${f.date}#${i}`, date: f.date, amountAud: f.amountAud })),
  );
  const prices = idx.points.map(p => p.unitPriceAud);
  const unitReturns = prices.slice(1).map((p, i) => p / prices[i] - 1);

  const traded = r.trades.reduce((s, t) => s + t.shares * t.price, 0);
  const avgNav = r.dailyValues.reduce((s, v) => s + v, 0) / r.dailyValues.length;
  return {
    afterTaxReturnPct: afterTax(opts.marginalRate),
    afterTaxReturnPctSensitivity: afterTax(opts.sensitivityRate),
    preTaxReturnPct: (grossEndAud / contributedAud - 1) * 100,
    maxDrawdownPct: maxDrawdown(prices),
    unitReturns,
    dates: idx.points.slice(1).map(p => p.date),
    trades: r.trades.length,
    sells: r.trades.filter(t => t.action === 'SELL').length,
    turnoverPct: (traded / 2 / avgNav) * 100,
    commissionsUsd: r.totalCommissions,
    nonDiscountDisposals: cgt.nonDiscountDisposals,
    discountDisposals: cgt.discountDisposals,
    cgtAud: cgt.totalNetCapitalGain * opts.marginalRate,
    dividendTaxAud: divTax(opts.marginalRate),
  };
}

export { runBacktest };
