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
import { config as appConfig } from '../config';
import {
  computeTargetWeights,
  computeExposure,
  computeDrift,
  decideRebalance,
  generateRebalanceOrders,
  dailyReturns,
  type RebalanceParams,
  type PortfolioSnapshot,
} from '../portfolio/rebalance';
import { allocateCashFlow } from '../portfolio/cashflow-rebalance';

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

// ---------- Default Config (reads from centralized config.ts) ----------

export const DEFAULT_CONFIG: BacktestConfig = {
  name: 'Default HRP + Regime + Vol Target',
  optimizerMethod: appConfig.strategy.optimizer,
  rebalanceDriftPct: appConfig.rebalance.driftThreshold,
  rebalanceFreqDays: appConfig.rebalance.frequencyDays,
  drawdownLimits: {
    warningPct: appConfig.risk.drawdownWarningPct,
    deriskPct: appConfig.risk.drawdownDeriskPct,
    hardStopPct: appConfig.risk.drawdownHardStopPct,
  },
  targetVol: appConfig.risk.targetVol,
  maxLeverage: appConfig.risk.maxLeverage,
  enableRegimeOverlay: appConfig.strategy.enableRegimeOverlay,
  // OFF for production parity (2026-08-29 gate audit): risk-manager computes
  // volTargetLeverage and writes it to state, but portfolio-strategist never
  // reads it — no live order path applies a vol multiplier. Simulating one
  // means backtesting a strategy that is not running, and because it
  // recomputes from the trailing 60d daily it swings targets (and therefore
  // drift, urgent triggers, and cash-flow churn) that production never sees.
  enableVolTargeting: false,
  lookbackDays: appConfig.strategy.lookbackDays,
  commissionPerTrade: 1.0,
  slippagePctPerSide: 0.0005, // 5 bps/side; see BacktestConfig
  regimeLookbackDays: 200,    // production quant-analyst's history requirement
  // Production parity (2026-08-29 audit): quant-analyst publishes null below
  // 200 samples and portfolio-strategist then applies NO regime multiplier —
  // unknown fails open at 1.0, it does not extrapolate from a short window.
  regimeMinHistory: 200,
  unknownRegimeExposure: 1.0,
  useTotalReturn: true,
  urgentDriftPct: appConfig.rebalance.urgentDriftThreshold,
  modelCashFlowPath: true,
};

// ---------- Core Backtest ----------

export function runBacktest(
  config: BacktestConfig,
  startingCapital: number,
  initialPositions?: Position[],
  startDate?: string,
  endDate?: string,
): BacktestResult {
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
    startIdx = Math.max(idx, config.lookbackDays);
  }
  if (endDate) {
    if (endDate < dates[0] || endDate > dates[dates.length - 1]) throw outsideDataset('endDate', endDate);
    let idx = dates.length - 1;
    while (idx > 0 && dates[idx] > endDate) idx--; // last trading day on/before
    endIdx = idx + 1;
  }

  let positions: Position[] = initialPositions ? initialPositions.map(p => ({ ...p })) : [];
  let cash = startingCapital;

  if (initialPositions && initialPositions.length > 0) {
    const date0 = dates[startIdx];
    let posValue = 0;
    for (const p of positions) {
      const dm = symbolDateMap.get(p.symbol);
      posValue += dm ? p.shares * getPrice(allData, p.symbol, dm, date0, config.useTotalReturn) : 0;
    }
    cash = Math.max(0, startingCapital - posValue);
  }

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

    const nav = portfolioValue(positions, prices, cash);
    dailyValues.push(nav);

    if (dailyValues.length > 1) {
      const prev = dailyValues[dailyValues.length - 2];
      dailyReturnsList.push(prev > 0 ? (nav - prev) / prev : 0);
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
            positions.push({ symbol: s, shares, avgCost: fillPrice });
            cash -= shares * fillPrice + config.commissionPerTrade;
            trades.push({ day: dayIdx, date, symbol: s, action: 'BUY', shares, price: fillPrice, commission: config.commissionPerTrade, reason: 'Initial equal-weight buy' });
          }
        }
      }
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

    // Scale weights by exposure
    const adjustedWeights = rawWeights.map(w => w * exposure);
    const targetWeightMap = new Map<string, number>();
    optimSymbols.forEach((s, i) => targetWeightMap.set(s, adjustedWeights[i]));

    // Build snapshot for shared drift/order logic
    const currentShares = new Map<string, number>();
    for (const pos of positions) currentShares.set(pos.symbol, pos.shares);
    for (const s of optimSymbols) {
      if (!currentShares.has(s)) currentShares.set(s, 0);
    }

    const snapshot: PortfolioSnapshot = { symbols: optimSymbols, prices, currentShares, nav, cash, peakNav: peakValue };

    // Use shared drift calculation and the PRODUCTION gate. An empty book is
    // the backtest bootstrap (production seeds real positions), so day one
    // deploys unconditionally.
    const drift = computeDrift(snapshot, targetWeightMap);
    const dateMs = new Date(`${date}T20:00:00Z`).getTime();
    const daysSince = (dateMs - lastRebalanceMs) / 86400000;
    const decision = positions.length === 0
      ? 'regular'
      : decideRebalance(drift, daysSince, {
          driftThreshold: config.rebalanceDriftPct,
          urgentDriftThreshold: config.urgentDriftPct,
          frequencyDays: config.rebalanceFreqDays,
        });

    if (decision === 'within-threshold') {
      // Production deploys idle cash buy-only into underweights here, and it
      // does NOT reset the rebalance cooldown (a cash deployment must never
      // silence the only mechanism that can SELL an overweight).
      const CASH_THRESHOLD = 1000;
      if (config.modelCashFlowPath && cash > CASH_THRESHOLD) {
        const holdings = optimSymbols.map((s, i) => ({
          symbol: s,
          currentValue: (currentShares.get(s) ?? 0) * (prices.get(s) ?? 0),
          targetPct: adjustedWeights[i] * 100,
        }));
        const cashOrders = allocateCashFlow(holdings, cash - CASH_THRESHOLD, 100, prices);
        for (const o of cashOrders) {
          const price = (prices.get(o.symbol) ?? 0) * (1 + config.slippagePctPerSide);
          const cost = o.shares * price + config.commissionPerTrade;
          if (o.shares <= 0 || cost > cash) continue;
          cash -= cost;
          const existing = positions.find(p => p.symbol === o.symbol);
          if (existing) {
            const totalCost = existing.avgCost * existing.shares + price * o.shares;
            existing.shares += o.shares;
            existing.avgCost = totalCost / existing.shares;
          } else {
            positions.push({ symbol: o.symbol, shares: o.shares, avgCost: price });
          }
          trades.push({ day: dayIdx, date, symbol: o.symbol, action: 'BUY', shares: o.shares, price, commission: config.commissionPerTrade, reason: 'cash_flow_rebalance' });
        }
      }
      continue;
    }
    if (decision === 'too-soon') continue;

    // 'urgent' or 'regular' — full rebalance
    const rebalOrders = generateRebalanceOrders(snapshot, targetWeightMap, weightSource, 50);
    if (rebalOrders.length === 0) continue;

    lastRebalanceMs = dateMs;
    rebalanceCount++;

    // Execute orders (sells first, then buys — generateRebalanceOrders already sorts this way)
    for (const order of rebalOrders) {
      const mid = prices.get(order.symbol) ?? 0;
      if (order.action === 'SELL') {
        const price = mid * (1 - config.slippagePctPerSide);
        const pos = positions.find(p => p.symbol === order.symbol);
        if (pos && pos.shares >= order.shares) {
          pos.shares -= order.shares;
          cash += order.shares * price - config.commissionPerTrade;
          trades.push({ day: dayIdx, date, symbol: order.symbol, action: 'SELL', shares: order.shares, price, commission: config.commissionPerTrade, reason: order.reason });
        }
      } else {
        const price = mid * (1 + config.slippagePctPerSide);
        const cost = order.shares * price + config.commissionPerTrade;
        if (cost > cash) continue;
        cash -= cost;
        const existing = positions.find(p => p.symbol === order.symbol);
        if (existing) {
          const totalCost = existing.avgCost * existing.shares + price * order.shares;
          existing.shares += order.shares;
          existing.avgCost = totalCost / existing.shares;
        } else {
          positions.push({ symbol: order.symbol, shares: order.shares, avgCost: price });
        }
        trades.push({ day: dayIdx, date, symbol: order.symbol, action: 'BUY', shares: order.shares, price, commission: config.commissionPerTrade, reason: order.reason });
      }
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
