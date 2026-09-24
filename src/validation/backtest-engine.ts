/**
 * Backtest Engine for ibkr-fund
 *
 * Simulates the full portfolio management pipeline against real historical data.
 * Uses the SAME rebalancing logic as the live agents (portfolio/rebalance.ts).
 *
 * Supports arbitrary symbol universes for diversification backtesting.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { maxDrawdown } from '../risk/drawdown';
import { historicalVaR, conditionalVaR } from '../risk/var';
import {
  computeTargetWeights,
  computeExposure,
  computeDrift,
  dampExposure,
  decideRebalance,
  generateRebalanceOrders,
  dailyReturns,
  type RebalanceParams,
  type PortfolioSnapshot,
} from '../portfolio/rebalance';
import { allocateCashFlow } from '../portfolio/cashflow-rebalance';
import {
  assessBands, decideBands, generateBandOrders, PLAN_BANDS, type BandParams, type OpenLot,
} from '../portfolio/drift-bands';

// ---------- Types ----------

export interface DailyBar {
  date: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose: number;
}

export interface Position {
  symbol: string;
  shares: number;
  avgCost: number;
}

export interface BacktestConfig {
  name: string;
  symbols?: string[];
  optimizerMethod: 'hrp' | 'risk_parity' | 'black_litterman' | 'equal_weight' | 'static' | 'buy_and_hold';
  rebalanceDriftPct: number;
  rebalanceFreqDays: number;
  drawdownLimits: { warningPct: number; deriskPct: number; hardStopPct: number };
  targetVol: number;
  maxLeverage: number;
  enableRegimeOverlay: boolean;
  /** Daily samples required before the regime is known (mirrors quant-analyst's 200). */
  regimeMinHistory?: number;
  /** Exposure multiplier while the regime is unknown. */
  unknownRegimeExposure?: number;
  /** Model portfolio weights in `symbols` order; used by optimizerMethod 'static'. */
  staticWeights?: number[];
  enableVolTargeting: boolean;
  lookbackDays: number;
  commissionPerTrade: number;
  /**
   * Per-side slippage as a fraction of price (2026-08-29 audit). Production
   * measures real implementation shortfall per fill (execution/shortfall.ts);
   * the backtest used to fill at the exact close for free. 5 bps/side is a
   * conservative half-spread + impact figure for liquid US large caps at
   * retail size. 0 restores the legacy frictionless fills.
   */
  slippagePctPerSide: number;
  /**
   * Days of history handed to the REGIME overlay, independent of the
   * optimizer's `lookbackDays` (2026-08-29 audit). Production computes the
   * regime on >= 200 daily samples while the optimizer covariance uses a
   * shorter window; the engine used to feed both from `lookbackDays`, so at
   * the default 180 the regime's "200-day" MA silently shrank to 181 days.
   */
  regimeLookbackDays: number;
  /**
   * Use dividend-adjusted closes (total return) for all prices
   * (2026-08-29 audit). Raw closes discard distributions entirely — TLT's
   * return over the bundled window is -6.1% price-only vs +5.9% total —
   * which poisoned every hedge-composition conclusion. false restores the
   * legacy price-only behaviour.
   */
  useTotalReturn: boolean;
  /** Alternate dataset in data/ (e.g. 'historical-long.json'). */
  dataFile?: string;
  /**
   * Per-name drift that bypasses the frequencyDays cooldown, mirroring
   * production's `decideRebalance` urgent path (2026-08-29 gate-fidelity
   * fix). The engine previously modeled NO urgent path and applied the
   * cooldown as TRADING days (45 ≈ 63 calendar days) where production
   * counts CALENDAR days — and it skipped the drift computation entirely
   * during cooldown, so it could not distinguish 'too-soon' from
   * 'within-threshold' and never modeled the cash-flow deployment that
   * production runs in the within-threshold state.
   */
  urgentDriftPct: number;
  /**
   * Model the production cash-flow path: in 'within-threshold', idle cash
   * above $1,000 is deployed buy-only into underweights (allocateCashFlow),
   * WITHOUT resetting the rebalance cooldown.
   */
  modelCashFlowPath: boolean;
  /**
   * Churn guard A (2026-08-29 study): exposure dead-band width passed to
   * dampExposure. 0 = off (current production behaviour).
   */
  exposureDeadBand: number;
  /**
   * Churn guard B: cash-flow deployment skips names the strategy sold within
   * this many calendar days. 0 = off (current production behaviour).
   */
  cashFlowRebuyGuardDays: number;
  /**
   * Live-path knobs (2026-09-24, G1/G3). All optional; absent means the
   * engine's historical behaviour, so every existing study reproduces.
   *   minTradeUsd        — rebalance order floor (engine legacy: 50)
   *   cashBufferPct      — % of NAV held back from rebalance targets (legacy: 0)
   *   fillMode           — rebalance buy allocation when cash-short (legacy: proportional)
   *   cashFlowFillMode   — allocateCashFlow mode (legacy: proportional)
   *   cashFlowReserveUsd — cash the cash-flow path never deploys (legacy: 1000)
   *   cashFlowReserveBase — the same reserve stated in AUD, converted at the
   *                        day's rate; wins over cashFlowReserveUsd when an FX
   *                        series is loaded (as live: CASH_FLOW_RESERVE_BASE)
   */
  minTradeUsd?: number;
  cashBufferPct?: number;
  fillMode?: 'greedy' | 'proportional';
  cashFlowFillMode?: 'greedy' | 'proportional';
  cashFlowReserveUsd?: number;
  cashFlowReserveBase?: number;
  /** FX series in data/ ({ date: AUD per USD }); required by cashFlowReserveBase and deposits. */
  fxDataFile?: string;
  /**
   * G4 — one price basis: pay cash dividends (data/<file>, ex-date, USD/share)
   * net of `dividendWithholding` (default 15% US WHT) into cash, on RAW closes.
   * Requires useTotalReturn: false; mixing both would count dividends twice.
   */
  dividendsFile?: string;
  dividendWithholding?: number;
  /** G3 — AUD deposits (+) / withdrawals (−), converted to USD at that day's rate. Needs fxDataFile. */
  deposits?: Array<{ date: string; amountAud: number }>;
  /** G3 — fraction of trading days the strategist misses (seeded, deterministic). Default 0. */
  missedRunRate?: number;
  missedRunSeed?: number;
  /** G7 — 'ibkr-fixed': USD 0.005/share, min 1.00, capped at 1% of value. Default flat commissionPerTrade. */
  commissionModel?: 'flat' | 'ibkr-fixed';
  /** G7 — dated opening lots (cost in USD/share). Replaces initialPositions when given. */
  initialLots?: Array<{ symbol: string; shares: number; cost: number; date: string }>;
  /** F1 — rebalance gate. Default 'legacy' (decideRebalance). */
  gate?: 'legacy' | 'bands';
  /** F1 — band parameters when gate is 'bands'. Default PLAN_BANDS. */
  bandParams?: BandParams;
}

export interface TradeRecord {
  day: number;
  date: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  shares: number;
  price: number;
  commission: number;
  reason: string;
}

export interface BacktestResult {
  config: BacktestConfig;
  startDate: string;
  endDate: string;
  startingCapital: number;
  finalPortfolioValue: number;
  totalReturn: number;
  annualizedReturn: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  trades: TradeRecord[];
  totalCommissions: number;
  regimeCounts: Record<string, number>;
  rebalanceCount: number;
  /** Days spent halted at the drawdown hard stop (no orders generated). */
  hardStopDays: number;
  dailyValues: number[];
  dailyReturns: number[];
  finalPositions: Position[];
  var95: number;
  cvar95: number;
  /** Trading date of each dailyValues entry (the last one repeats the final date, post-trade). */
  dailyDates: string[];
  /** Cash dividends received (G4). */
  dividends: Array<{ date: string; symbol: string; grossUsd: number; withheldUsd: number }>;
  /** Capital flows applied (G3). */
  flows: Array<{ date: string; amountAud: number; amountUsd: number }>;
  /** Days the strategist was modelled as not running (G3). */
  missedRunDays: number;
  /** Gate outcomes per day (both gates use the same four labels). */
  decisionCounts: Record<string, number>;
  /** Open FIFO lots at the end, per symbol. */
  finalLots: Record<string, OpenLot[]>;
}

// ---------- Data Loading ----------

const _cachedData = new Map<string, Record<string, DailyBar[]>>();

export function loadHistoricalData(dataFile?: string): Record<string, DailyBar[]> {
  // BACKTEST_DATA_FILE lets a study point at a longer or differently-scoped
  // dataset (e.g. one reaching back through a bear market) without disturbing
  // the default file the test suites assert against; `dataFile` does the same
  // per-call (scenario tests use it to reach the 2022 bear).
  const file = dataFile || process.env.BACKTEST_DATA_FILE || 'historical-daily.json';
  const cached = _cachedData.get(file);
  if (cached) return cached;
  const dataPath = resolve(__dirname, 'data', file);
  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as Record<string, DailyBar[]>;
  _cachedData.set(file, data);
  return data;
}

const _cachedFx = new Map<string, { dates: string[]; rates: number[] }>();

/** AUD-per-USD series from data/, sorted by date. */
export function loadFxSeries(file: string): { dates: string[]; rates: number[] } {
  const cached = _cachedFx.get(file);
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(resolve(__dirname, 'data', file), 'utf8')) as Record<string, number>;
  const dates = Object.keys(raw).sort();
  const out = { dates, rates: dates.map(d => raw[d]) };
  _cachedFx.set(file, out);
  return out;
}

const _cachedDivs = new Map<string, Map<string, Map<string, number>>>();

/** Cash dividends from data/: symbol → ex-date → USD per share. */
export function loadDividends(file: string): Map<string, Map<string, number>> {
  const cached = _cachedDivs.get(file);
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(resolve(__dirname, 'data', file), 'utf8')) as Record<string, Array<{ date: string; amount: number }>>;
  const out = new Map<string, Map<string, number>>();
  for (const [sym, list] of Object.entries(raw)) {
    const m = new Map<string, number>();
    for (const d of list) m.set(d.date, (m.get(d.date) ?? 0) + d.amount);
    out.set(sym, m);
  }
  _cachedDivs.set(file, out);
  return out;
}

/** Deterministic PRNG (mulberry32) for the missed-run model. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The last rate on or before `date` (FX trades on days the NYSE doesn't, and vice versa). */
export function fxOn(series: { dates: string[]; rates: number[] }, date: string): number {
  let lo = 0;
  let hi = series.dates.length - 1;
  if (hi < 0) throw new Error('empty FX series');
  if (date < series.dates[0]) return series.rates[0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series.dates[mid] <= date) lo = mid; else hi = mid - 1;
  }
  return series.rates[lo];
}

export const SYMBOLS = ['PLTR', 'AMZN', 'TWLO', 'ARM', 'TSLA', 'BRK-B', 'NET'];

// ---------- Helpers ----------

function portfolioValue(positions: Position[], prices: Map<string, number>, cash: number): number {
  let total = cash;
  for (const pos of positions) total += pos.shares * (prices.get(pos.symbol) ?? 0);
  return total;
}

// ---------- Date-aligned timeline ----------

interface DateIndex {
  dates: string[];
  symbolDateMap: Map<string, Map<string, number>>;
}

function buildDateIndex(allData: Record<string, DailyBar[]>, symbols: string[]): DateIndex {
  let longestSym = symbols[0];
  for (const s of symbols) {
    if ((allData[s]?.length ?? 0) > (allData[longestSym]?.length ?? 0)) longestSym = s;
  }
  const dates = allData[longestSym].map((b: DailyBar) => b.date);
  const symbolDateMap = new Map<string, Map<string, number>>();
  for (const s of symbols) {
    const map = new Map<string, number>();
    const bars = allData[s] ?? [];
    for (let i = 0; i < bars.length; i++) map.set(bars[i].date, i);
    symbolDateMap.set(s, map);
  }
  return { dates, symbolDateMap };
}

function getPrice(allData: Record<string, DailyBar[]>, sym: string, dateMap: Map<string, number>, date: string, useTotalReturn: boolean): number {
  const idx = dateMap.get(date);
  if (idx === undefined) return 0;
  const bar = allData[sym][idx];
  if (!bar) return 0;
  return useTotalReturn ? (bar.adjClose || bar.close) : bar.close;
}

function getActiveSymbols(symbols: string[], symbolDateMap: Map<string, Map<string, number>>, date: string): string[] {
  return symbols.filter(s => symbolDateMap.get(s)!.has(date));
}

// ---------- Default + live configs ----------
//
// Studies never read ambient env (2026-09-24 review, G1). DEFAULT_CONFIG used to
// be assembled from `config.ts`, i.e. from whatever `.env` happened to be loaded:
// the same study gave different answers on the workstation (live .env) and in CI
// (code defaults), and changing a production default silently changed every
// backtest assertion. It is now a literal — the code defaults as they stood when
// the coupling was removed — and LIVE_CONFIG layers a sanitised snapshot of the
// production knobs on top of it.

export const DEFAULT_CONFIG: BacktestConfig = {
  name: 'Default HRP + Regime + Vol Target',
  optimizerMethod: 'hrp',
  rebalanceDriftPct: 10,
  rebalanceFreqDays: 45,
  drawdownLimits: { warningPct: 7, deriskPct: 15, hardStopPct: 25 },
  targetVol: 0.20,
  maxLeverage: 1.0,
  enableRegimeOverlay: true,
  // OFF for production parity (2026-08-29 gate audit): risk-manager computes
  // volTargetLeverage and writes it to state, but portfolio-strategist never
  // reads it — no live order path applies a vol multiplier. Simulating one
  // means backtesting a strategy that is not running, and because it
  // recomputes from the trailing 60d daily it swings targets (and therefore
  // drift, urgent triggers, and cash-flow churn) that production never sees.
  enableVolTargeting: false,
  lookbackDays: 180,
  commissionPerTrade: 1.0,
  slippagePctPerSide: 0.0005, // 5 bps/side; see BacktestConfig
  regimeLookbackDays: 200,    // production quant-analyst's history requirement
  // Production parity (2026-08-29 audit): quant-analyst publishes null below
  // 200 samples and portfolio-strategist then applies NO regime multiplier —
  // unknown fails open at 1.0, it does not extrapolate from a short window.
  regimeMinHistory: 200,
  unknownRegimeExposure: 1.0,
  useTotalReturn: true,
  urgentDriftPct: 25,
  modelCashFlowPath: true,
  exposureDeadBand: 0,       // churn guards default OFF — matches live today
  cashFlowRebuyGuardDays: 0,
};

/**
 * The production knobs as of 2026-09-24, sanitised: switches and thresholds
 * only, no account figures. Update it when the live `.env` changes — it is the
 * one place a study learns what "live" means.
 */
export const LIVE_KNOBS = {
  asOf: '2026-09-24',
  OPTIMIZER: 'static',
  ENABLE_REGIME: false,
  REBALANCE_DRIFT_THRESHOLD: 10,
  REBALANCE_URGENT_DRIFT_THRESHOLD: 25,
  REBALANCE_FREQ_DAYS: 45,
  REBALANCE_MIN_TRADE_USD: 200,
  REBALANCE_CASH_BUFFER_PCT: 1,
  REBALANCE_FILL_MODE: 'greedy',
  REBALANCE_CASHFLOW_FILL_MODE: 'greedy',
  CASH_FLOW_RESERVE_BASE: 500,
  CASH_FLOW_REBUY_GUARD_DAYS: 30,
  DD_WARNING: 7,
  DD_DERISK: 15,
  DD_HARD_STOP: 25,
} as const;

/** DEFAULT_CONFIG with the live knobs applied. Callers still supply `staticWeights`. */
export const LIVE_CONFIG: BacktestConfig = {
  ...DEFAULT_CONFIG,
  name: `Live (${LIVE_KNOBS.asOf})`,
  optimizerMethod: LIVE_KNOBS.OPTIMIZER,
  enableRegimeOverlay: LIVE_KNOBS.ENABLE_REGIME,
  rebalanceDriftPct: LIVE_KNOBS.REBALANCE_DRIFT_THRESHOLD,
  urgentDriftPct: LIVE_KNOBS.REBALANCE_URGENT_DRIFT_THRESHOLD,
  rebalanceFreqDays: LIVE_KNOBS.REBALANCE_FREQ_DAYS,
  drawdownLimits: {
    warningPct: LIVE_KNOBS.DD_WARNING,
    deriskPct: LIVE_KNOBS.DD_DERISK,
    hardStopPct: LIVE_KNOBS.DD_HARD_STOP,
  },
  minTradeUsd: LIVE_KNOBS.REBALANCE_MIN_TRADE_USD,
  cashBufferPct: LIVE_KNOBS.REBALANCE_CASH_BUFFER_PCT,
  fillMode: LIVE_KNOBS.REBALANCE_FILL_MODE,
  cashFlowFillMode: LIVE_KNOBS.REBALANCE_CASHFLOW_FILL_MODE,
  cashFlowReserveBase: LIVE_KNOBS.CASH_FLOW_RESERVE_BASE,
  cashFlowRebuyGuardDays: LIVE_KNOBS.CASH_FLOW_REBUY_GUARD_DAYS,
  fxDataFile: 'fx-audusd.json',
};

/**
 * The earliest `startDate` runBacktest accepts for `config` — the end of its
 * optimizer warm-up on the dataset it would load. For studies that used to pass
 * the dataset's first day and rely on the (now removed) silent shift.
 */
export function firstUsableStart(config: BacktestConfig): string {
  const allData = loadHistoricalData(config.dataFile);
  const { dates } = buildDateIndex(allData, config.symbols ?? SYMBOLS);
  if (dates.length <= config.lookbackDays) {
    throw new Error(`dataset has ${dates.length} days, fewer than the ${config.lookbackDays}-day warm-up`);
  }
  return dates[config.lookbackDays];
}

/** `from`, or the first usable start if `from` falls inside the warm-up. */
export function clampToWarmup(config: BacktestConfig, from: string): string {
  const first = firstUsableStart(config);
  return from < first ? first : from;
}

// ---------- Core Backtest ----------

export function runBacktest(
  config: BacktestConfig,
  startingCapital: number,
  initialPositions?: Position[],
  startDate?: string,
  endDate?: string,
): BacktestResult {
  if (config.cashFlowReserveBase !== undefined && !config.fxDataFile) {
    throw new Error('cashFlowReserveBase is stated in AUD and needs fxDataFile to convert it — refusing to guess a rate');
  }
  if (config.dividendsFile && config.useTotalReturn) {
    throw new Error('dividendsFile pays dividends as cash on raw closes; set useTotalReturn: false (one price basis)');
  }
  if (config.deposits?.length && !config.fxDataFile) {
    throw new Error('deposits are stated in AUD and need fxDataFile to convert them');
  }
  const allData = loadHistoricalData(config.dataFile);
  const symbols = config.symbols ?? SYMBOLS;

  const { dates, symbolDateMap } = buildDateIndex(allData, symbols);

  // A requested window the dataset cannot serve must be an ERROR, not a
  // fallback (2026-08-29 audit): the "2022 Bear Market" scenario silently ran
  // 2024→2026 for its whole life because 2022 wasn't in the default file.
  const outsideDataset = (which: string, d: string): Error =>
    new Error(
      `${which} ${d} is outside the dataset (${dates[0]} → ${dates[dates.length - 1]}). ` +
      `Point config.dataFile at a longer file (e.g. 'historical-long.json') instead of silently running a different window.`,
    );
  let startIdx = config.lookbackDays;
  let endIdx = dates.length;
  if (startDate) {
    const idx = dates.findIndex(x => x >= startDate); // first trading day on/after
    if (idx < 0 || dates[0] > startDate) throw outsideDataset('startDate', startDate);
    // A start inside the optimizer warm-up used to be moved silently to the end
    // of it (2026-09-24 review, G5) — the same class of lie as the window
    // fallback above: a "2024" study that actually began mid-2024.
    if (idx < config.lookbackDays) {
      throw new Error(
        `startDate ${startDate} is inside the ${config.lookbackDays}-day warm-up of this dataset; ` +
        `the first usable start is ${dates[config.lookbackDays]}. Start later, or use a longer dataFile.`,
      );
    }
    startIdx = idx;
  }
  if (endDate) {
    if (endDate < dates[0] || endDate > dates[dates.length - 1]) throw outsideDataset('endDate', endDate);
    let idx = dates.length - 1;
    while (idx > 0 && dates[idx] > endDate) idx--; // last trading day on/before
    endIdx = idx + 1;
  }

  const fx = config.fxDataFile ? loadFxSeries(config.fxDataFile) : null;
  const minTradeUsd = config.minTradeUsd ?? 50;

  // Open FIFO lots per symbol, kept beside `positions` (whose avgCost is what
  // the legacy engine always tracked). Lots drive the band gate's CGT guard.
  const lots = new Map<string, OpenLot[]>();
  const addLot = (sym: string, qty: number, cost: number, date: string): void => {
    const l = lots.get(sym) ?? [];
    l.push({ date, qty, cost });
    lots.set(sym, l);
  };
  const consumeLots = (sym: string, qty: number): void => {
    const l = lots.get(sym) ?? [];
    let left = qty;
    while (left > 0 && l.length > 0) {
      const take = Math.min(left, l[0].qty);
      l[0].qty -= take;
      left -= take;
      if (l[0].qty <= 0) l.shift();
    }
  };

  const seedPositions: Position[] | undefined = config.initialLots
    ? (() => {
        const agg = new Map<string, { shares: number; cost: number }>();
        for (const l of config.initialLots) {
          const a = agg.get(l.symbol) ?? { shares: 0, cost: 0 };
          a.shares += l.shares;
          a.cost += l.shares * l.cost;
          agg.set(l.symbol, a);
        }
        return [...agg.entries()].map(([symbol, a]) => ({ symbol, shares: a.shares, avgCost: a.shares > 0 ? a.cost / a.shares : 0 }));
      })()
    : initialPositions;
  let positions: Position[] = seedPositions ? seedPositions.map(p => ({ ...p })) : [];
  let cash = startingCapital;

  if (seedPositions && seedPositions.length > 0) {
    const date0 = dates[startIdx];
    let posValue = 0;
    for (const p of positions) {
      const dm = symbolDateMap.get(p.symbol);
      posValue += dm ? p.shares * getPrice(allData, p.symbol, dm, date0, config.useTotalReturn) : 0;
    }
    cash = Math.max(0, startingCapital - posValue);
  }
  if (config.initialLots) {
    for (const l of [...config.initialLots].sort((a, b) => a.date.localeCompare(b.date))) addLot(l.symbol, l.shares, l.cost, l.date);
  } else {
    for (const p of positions) addLot(p.symbol, p.shares, p.avgCost, dates[startIdx]);
  }

  const commissionFor = (shares: number, price: number): number =>
    config.commissionModel === 'ibkr-fixed'
      ? Math.min(Math.max(1.0, 0.005 * shares), 0.01 * shares * price)
      : config.commissionPerTrade;
  const divs = config.dividendsFile ? loadDividends(config.dividendsFile) : null;
  const wht = config.dividendWithholding ?? 0.15;
  const dividendsPaid: BacktestResult['dividends'] = [];
  const flowsApplied: BacktestResult['flows'] = [];
  const dailyDates: string[] = [];
  const decisionCounts: Record<string, number> = {};
  const missed = config.missedRunRate && config.missedRunRate > 0 ? prng(config.missedRunSeed ?? 1) : null;
  let missedRunDays = 0;
  const bandParams = config.bandParams ?? PLAN_BANDS;

  const trades: TradeRecord[] = [];
  const dailyValues: number[] = [];
  const dailyReturnsList: number[] = [];
  const regimeCounts: Record<string, number> = {};
  let rebalanceCount = 0;
  let hardStopDays = 0;
  // CALENDAR ms of the last real rebalance — production's cooldown counts
  // calendar days (Date.now() - lastRebalanceAt), not trading days. The old
  // trading-day-index cooldown stretched 45 configured days to ~63 real ones.
  let lastRebalanceMs = -Infinity;
  let peakValue = startingCapital;
  // Churn guards: the exposure actually applied last (dead-band memory), and
  // when each name was last SOLD by the strategy (rebuy guard).
  let lastAppliedExposure: number | null = null;
  const lastSellMs = new Map<string, number>();

  // Build rebalance params from config (same shape the shared module expects)
  const rebalParams: RebalanceParams = {
    optimizerMethod: config.optimizerMethod === 'buy_and_hold' ? 'equal_weight' : config.optimizerMethod,
    driftThresholdPct: config.rebalanceDriftPct,
    minTradeUsd: 50,
    enableRegimeOverlay: config.enableRegimeOverlay,
    regimeMinHistory: config.regimeMinHistory,
    unknownRegimeExposure: config.unknownRegimeExposure,
    staticWeights: config.staticWeights,
    enableVolTargeting: config.enableVolTargeting,
    targetVol: config.targetVol,
    maxLeverage: config.maxLeverage,
    drawdownLimits: config.drawdownLimits,
  };

  for (let dayIdx = startIdx; dayIdx < endIdx; dayIdx++) {
    const date = dates[dayIdx];
    const activeSymbols = getActiveSymbols(symbols, symbolDateMap, date);
    const n = activeSymbols.length;

    const prices = new Map<string, number>();
    for (const s of activeSymbols) {
      prices.set(s, getPrice(allData, s, symbolDateMap.get(s)!, date, config.useTotalReturn));
    }

    // G4: cash dividends on their ex-date, net of withholding, on shares held
    // going into the day.
    if (divs) {
      for (const pos of positions) {
        const amt = divs.get(pos.symbol)?.get(date);
        if (amt && pos.shares > 0) {
          const gross = pos.shares * amt;
          cash += gross * (1 - wht);
          dividendsPaid.push({ date, symbol: pos.symbol, grossUsd: gross, withheldUsd: gross * wht });
        }
      }
    }
    // G3: capital flows dated after the previous day, up to and including today.
    let flowUsd = 0;
    if (config.deposits?.length && fx) {
      const prevDate = dayIdx > startIdx ? dates[dayIdx - 1] : date;
      for (const d of config.deposits) {
        if (d.date > prevDate && d.date <= date) {
          const usd = d.amountAud / fxOn(fx, date);
          flowUsd += usd;
          flowsApplied.push({ date, amountAud: d.amountAud, amountUsd: usd });
        }
      }
      cash += flowUsd;
    }

    const nav = portfolioValue(positions, prices, cash);
    dailyValues.push(nav);
    dailyDates.push(date);

    if (dailyValues.length > 1) {
      const prev = dailyValues[dailyValues.length - 2];
      // Flow-adjusted: a deposit is not a return.
      dailyReturnsList.push(prev > 0 ? (nav - flowUsd - prev) / prev : 0);
    }

    peakValue = Math.max(peakValue, nav);

    // Buy & hold: equal-weight buy on first day
    if (config.optimizerMethod === 'buy_and_hold') {
      if (positions.length === 0 && cash > 50) {
        const perStock = cash / n;
        for (const s of activeSymbols) {
          const price = prices.get(s) ?? 0;
          if (price <= 0) continue;
          const fillPrice = price * (1 + config.slippagePctPerSide);
          const shares = Math.floor(perStock / fillPrice);
          if (shares > 0) {
            const commission = commissionFor(shares, fillPrice);
            positions.push({ symbol: s, shares, avgCost: fillPrice });
            addLot(s, shares, fillPrice, date);
            cash -= shares * fillPrice + commission;
            trades.push({ day: dayIdx, date, symbol: s, action: 'BUY', shares, price: fillPrice, commission, reason: 'Initial equal-weight buy' });
          }
        }
      }
      continue;
    }

    // G3: a day the strategist did not run (host down, gateway logged out).
    if (missed && missed() < (config.missedRunRate ?? 0)) {
      missedRunDays++;
      continue;
    }

    // No early cooldown short-circuit: production computes drift every run
    // and routes through decideRebalance, where urgent drift bypasses the
    // cooldown and 'within-threshold' (distinct from 'too-soon') unlocks the
    // cash-flow deployment path. Skipping the computation during cooldown
    // made those three states indistinguishable (2026-08-29 gate fix).

    // Build returns matrix for active symbols with enough lookback.
    // The optimizer window (`lookbackDays`) and the regime window
    // (`regimeLookbackDays`) are built separately: production computes its
    // regime on >= 200 daily samples while the covariance uses a shorter
    // window, and feeding both from `lookbackDays` silently shrank the
    // regime's 200-day MA to whatever the optimizer used (2026-08-29 audit).
    const collectWindow = (s: string, days: number) => {
      const dm = symbolDateMap.get(s)!;
      const windowDates = dates.slice(Math.max(0, dayIdx - days), dayIdx + 1);
      const closes: number[] = [];
      const bars: { high: number; low: number; close: number }[] = [];
      for (const d of windowDates) {
        const idx = dm.get(d);
        if (idx !== undefined) {
          const bar = allData[s][idx];
          const px = config.useTotalReturn ? (bar.adjClose || bar.close) : bar.close;
          const scale = bar.close > 0 ? px / bar.close : 1;
          closes.push(px);
          bars.push({ high: bar.high * scale, low: bar.low * scale, close: px });
        }
      }
      return { closes, bars };
    };
    const optimSymbols: string[] = [];
    const returnsMatrix: number[][] = [];
    const priceArrays: number[][] = [];
    const regimePriceArrays: number[][] = [];
    const regimeOhlcArrays: { high: number; low: number; close: number }[][] = [];
    for (const s of activeSymbols) {
      const optim = collectWindow(s, config.lookbackDays);
      if (optim.closes.length >= 30) {
        optimSymbols.push(s);
        priceArrays.push(optim.closes);
        returnsMatrix.push(dailyReturns(optim.closes));
        const regime = collectWindow(s, config.regimeLookbackDays);
        regimePriceArrays.push(regime.closes);
        regimeOhlcArrays.push(regime.bars);
      }
    }

    if (optimSymbols.length < 2 || returnsMatrix[0].length < 30) continue;

    // Use shared module for weight computation (computes covariance internally)
    // Static weights must be re-indexed to optimSymbols, which can be a subset
    // (a symbol with no data yet is excluded), or the mapping silently shifts.
    const staticForActive = rebalParams.staticWeights
      ? optimSymbols.map(s => {
          const i = symbols.indexOf(s);
          return i >= 0 ? (rebalParams.staticWeights as number[])[i] ?? 0 : 0;
        })
      : undefined;
    const { weights: rawWeights, source: weightSource, covMatrix } = computeTargetWeights(
      returnsMatrix, optimSymbols, priceArrays, rebalParams.optimizerMethod, undefined, staticForActive,
    );
    if (covMatrix.length === 0) continue;

    // Use shared module for exposure — regime-length arrays, OHLC for proper ADX
    const { exposure, regime, drawdown } = computeExposure(
      regimePriceArrays, covMatrix, dailyReturnsList, nav, peakValue, rebalParams, regimeOhlcArrays,
    );

    if (regime) regimeCounts[regime] = (regimeCounts[regime] ?? 0) + 1;

    // Hard stop: HALT, do not liquidate.
    //
    // This used to sell the entire book and `continue`. That was both unlike
    // production and unrecoverable. Unlike production because
    // portfolio-strategist at 'stopped' declines to GENERATE ORDERS and holds
    // what it has — "halt + manual review", not "sell everything" (the code
    // there says so explicitly, since a stale liquidation queue executing after
    // the level relaxes is its own hazard). Unrecoverable because peakValue
    // never resets: once the book was cash, NAV went flat, the drawdown against
    // the old peak stayed above the threshold forever, and the run was frozen
    // for its remaining years. That silently produced a 19.6% full-period return
    // for any config whose drawdown touched hardStopPct — read as a catastrophic
    // strategy result when it was an artefact of the harness.
    if (drawdown.level === 'stopped') {
      hardStopDays++;
      continue;
    }

    // Scale weights by exposure, through the dead-band (churn guard A)
    const effExposure = dampExposure(exposure, lastAppliedExposure, config.exposureDeadBand);
    lastAppliedExposure = effExposure;
    const adjustedWeights = rawWeights.map(w => w * effExposure);
    const targetWeightMap = new Map<string, number>();
    optimSymbols.forEach((s, i) => targetWeightMap.set(s, adjustedWeights[i]));

    // Build snapshot for shared drift/order logic
    const currentShares = new Map<string, number>();
    for (const pos of positions) currentShares.set(pos.symbol, pos.shares);
    for (const s of optimSymbols) {
      if (!currentShares.has(s)) currentShares.set(s, 0);
    }

    const snapshot: PortfolioSnapshot = { symbols: optimSymbols, prices, currentShares, nav, cash, peakNav: peakValue };

    const dateMs = new Date(`${date}T20:00:00Z`).getTime();
    const daysSince = (dateMs - lastRebalanceMs) / 86400000;

    const executeBuy = (symbol: string, shares: number, reason: string): boolean => {
      const price = (prices.get(symbol) ?? 0) * (1 + config.slippagePctPerSide);
      const commission = commissionFor(shares, price);
      const cost = shares * price + commission;
      if (shares <= 0 || cost > cash) return false;
      cash -= cost;
      const existing = positions.find(p => p.symbol === symbol);
      if (existing) {
        const totalCost = existing.avgCost * existing.shares + price * shares;
        existing.shares += shares;
        existing.avgCost = totalCost / existing.shares;
      } else {
        positions.push({ symbol, shares, avgCost: price });
      }
      addLot(symbol, shares, price, date);
      trades.push({ day: dayIdx, date, symbol, action: 'BUY', shares, price, commission, reason });
      return true;
    };
    const executeSell = (symbol: string, shares: number, reason: string): boolean => {
      const price = (prices.get(symbol) ?? 0) * (1 - config.slippagePctPerSide);
      const pos = positions.find(p => p.symbol === symbol);
      if (!pos || pos.shares < shares) return false;
      const commission = commissionFor(shares, price);
      pos.shares -= shares;
      consumeLots(symbol, shares);
      lastSellMs.set(symbol, dateMs);
      cash += shares * price - commission;
      trades.push({ day: dayIdx, date, symbol, action: 'SELL', shares, price, commission, reason });
      return true;
    };
    const recentlySold = (): Set<string> => {
      const guardMs = config.cashFlowRebuyGuardDays * 86400000;
      const exclude = new Set<string>();
      if (guardMs > 0) {
        for (const [sym, ms] of lastSellMs) {
          if (dateMs - ms <= guardMs) exclude.add(sym);
        }
      }
      return exclude;
    };
    // Production's buy-only cash-flow deployment. It does NOT reset the
    // rebalance cooldown (a cash deployment must never silence the only
    // mechanism that can SELL an overweight).
    const cashFlow = (extraExclude: ReadonlySet<string>, minDeficitShareFraction: number): void => {
      const CASH_THRESHOLD = config.cashFlowReserveBase !== undefined && fx
        ? config.cashFlowReserveBase / fxOn(fx, date)
        : (config.cashFlowReserveUsd ?? 1000);
      if (!config.modelCashFlowPath || cash <= CASH_THRESHOLD) return;
      const holdings = optimSymbols.map((s, i) => ({
        symbol: s,
        currentValue: (currentShares.get(s) ?? 0) * (prices.get(s) ?? 0),
        targetPct: adjustedWeights[i] * 100,
      }));
      // Rebuy guard (guard B): don't redeploy into names we just sold
      const exclude = recentlySold();
      for (const s of extraExclude) exclude.add(s);
      const cashOrders = allocateCashFlow(
        holdings, cash - CASH_THRESHOLD, 100, prices, exclude, config.cashFlowFillMode ?? 'proportional',
        minDeficitShareFraction,
      );
      for (const o of cashOrders) executeBuy(o.symbol, o.shares, 'cash_flow_rebalance');
    };

    if (config.gate === 'bands') {
      // F1 in the engine: the same pure functions the strategist runs under
      // DRIFT_GATE=bands, including its cash-flow refinements.
      const assessment = assessBands(snapshot, targetWeightMap, bandParams);
      const bandDecision = positions.length === 0 ? 'regular' : decideBands(assessment, daysSince, config.rebalanceFreqDays);
      decisionCounts[bandDecision] = (decisionCounts[bandDecision] ?? 0) + 1;
      if (bandDecision === 'within-threshold') { cashFlow(new Set(), 0.5); continue; }
      if (bandDecision === 'too-soon') {
        cashFlow(new Set(assessment.names.filter(x => x.dev > 0).map(x => x.symbol)), 0.5);
        continue;
      }
      const bandOrders = generateBandOrders(snapshot, assessment, {
        decision: bandDecision,
        params: bandParams,
        minTradeUsd,
        cashBufferPct: config.cashBufferPct ?? 0,
        lots,
        today: date,
        excludeBuys: recentlySold(),
      });
      let sold = false;
      for (const o of bandOrders.orders.filter(x => x.action === 'SELL')) sold = executeSell(o.symbol, o.shares, o.reason) || sold;
      for (const o of bandOrders.orders.filter(x => x.action === 'BUY')) executeBuy(o.symbol, o.shares, o.reason);
      if (sold) lastRebalanceMs = dateMs; // the cooldown is a SELL cooldown
      if (bandOrders.orders.length > 0) rebalanceCount++;
      positions = positions.filter(p => p.shares > 0);
      continue;
    }

    // Use shared drift calculation and the PRODUCTION gate. An empty book is
    // the backtest bootstrap (production seeds real positions), so day one
    // deploys unconditionally.
    const drift = computeDrift(snapshot, targetWeightMap);
    const decision = positions.length === 0
      ? 'regular'
      : decideRebalance(drift, daysSince, {
          driftThreshold: config.rebalanceDriftPct,
          urgentDriftThreshold: config.urgentDriftPct,
          frequencyDays: config.rebalanceFreqDays,
        });
    decisionCounts[decision] = (decisionCounts[decision] ?? 0) + 1;

    if (decision === 'within-threshold') {
      cashFlow(new Set(), 0);
      continue;
    }
    if (decision === 'too-soon') continue;

    // 'urgent' or 'regular' — full rebalance
    const rebalOrders = generateRebalanceOrders(snapshot, targetWeightMap, weightSource, minTradeUsd, {
      cashBufferPct: config.cashBufferPct ?? 0,
      fillMode: config.fillMode ?? 'proportional',
    });
    if (rebalOrders.length === 0) continue;

    lastRebalanceMs = dateMs;
    rebalanceCount++;

    // Execute orders (sells first, then buys — generateRebalanceOrders already sorts this way)
    for (const order of rebalOrders) {
      if (order.action === 'SELL') executeSell(order.symbol, order.shares, order.reason);
      else executeBuy(order.symbol, order.shares, order.reason);
    }
    positions = positions.filter(p => p.shares > 0);
  }

  // Final valuation
  const finalDate = dates[endIdx - 1];
  const finalPrices = new Map<string, number>();
  for (const s of symbols) {
    const dm = symbolDateMap.get(s)!;
    finalPrices.set(s, getPrice(allData, s, dm, finalDate, config.useTotalReturn));
  }
  const finalNav = portfolioValue(positions, finalPrices, cash);
  dailyValues.push(finalNav);
  dailyDates.push(finalDate);

  const totalReturn = ((finalNav - startingCapital) / startingCapital) * 100;
  const years = (endIdx - startIdx) / 252;
  const annualizedReturn = (Math.pow(finalNav / startingCapital, 1 / years) - 1) * 100;
  const maxDD = maxDrawdown(dailyValues);

  const avgReturn = dailyReturnsList.length > 0
    ? dailyReturnsList.reduce((s, r) => s + r, 0) / dailyReturnsList.length : 0;
  const stdReturn = dailyReturnsList.length > 1
    ? Math.sqrt(dailyReturnsList.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (dailyReturnsList.length - 1)) : 1;
  const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

  const var95 = historicalVaR(dailyReturnsList, 0.95) * finalNav;
  const cvar95 = conditionalVaR(dailyReturnsList, 0.95) * finalNav;
  const totalCommissions = trades.reduce((s, t) => s + t.commission, 0);

  return {
    config,
    startDate: dates[startIdx] ?? '',
    endDate: dates[endIdx - 1] ?? '',
    startingCapital,
    finalPortfolioValue: Math.round(finalNav * 100) / 100,
    totalReturn: Math.round(totalReturn * 100) / 100,
    annualizedReturn: Math.round(annualizedReturn * 100) / 100,
    maxDrawdownPct: Math.round(maxDD * 100) / 100,
    sharpeRatio: Math.round(sharpe * 100) / 100,
    trades, totalCommissions, regimeCounts, rebalanceCount, hardStopDays, dailyValues,
    dailyReturns: dailyReturnsList, finalPositions: positions,
    var95: Math.round(var95 * 100) / 100,
    cvar95: Math.round(cvar95 * 100) / 100,
    dailyDates,
    dividends: dividendsPaid,
    flows: flowsApplied,
    missedRunDays,
    decisionCounts,
    finalLots: Object.fromEntries([...lots.entries()].filter(([, l]) => l.length > 0)),
  };
}

export function formatResult(r: BacktestResult): string {
  const lines = [
    `=== ${r.config.name} ===`,
    `Period: ${r.startDate} → ${r.endDate}`,
    `Starting: $${r.startingCapital.toLocaleString()} → Final: $${r.finalPortfolioValue.toLocaleString()}`,
    `Return: ${r.totalReturn}% (${r.annualizedReturn}% annualized)`,
    `Max Drawdown: ${r.maxDrawdownPct}%`,
    `Sharpe: ${r.sharpeRatio}`,
    `Trades: ${r.trades.length} (commissions: $${r.totalCommissions.toFixed(0)})`,
    `Rebalances: ${r.rebalanceCount}`,
    `VaR(95%): $${r.var95.toFixed(0)} | CVaR(95%): $${r.cvar95.toFixed(0)}`,
  ];
  if (Object.keys(r.regimeCounts).length > 0) {
    lines.push(`Regimes: ${JSON.stringify(r.regimeCounts)}`);
  }
  if (r.finalPositions.length > 0) {
    lines.push('Final positions:');
    for (const p of r.finalPositions) {
      lines.push(`  ${p.symbol}: ${p.shares} shares @ avg $${p.avgCost.toFixed(2)}`);
    }
  }
  return lines.join('\n');
}
