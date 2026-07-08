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
  generateRebalanceOrders,
  dailyReturns,
  type RebalanceParams,
  type PortfolioSnapshot,
} from '../portfolio/rebalance';

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
  optimizerMethod: 'hrp' | 'risk_parity' | 'black_litterman' | 'equal_weight' | 'buy_and_hold';
  rebalanceDriftPct: number;
  rebalanceFreqDays: number;
  drawdownLimits: { warningPct: number; deriskPct: number; hardStopPct: number };
  targetVol: number;
  maxLeverage: number;
  enableRegimeOverlay: boolean;
  enableVolTargeting: boolean;
  lookbackDays: number;
  commissionPerTrade: number;
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
  dailyValues: number[];
  dailyReturns: number[];
  finalPositions: Position[];
  var95: number;
  cvar95: number;
}

// ---------- Data Loading ----------

let _cachedData: Record<string, DailyBar[]> | null = null;

export function loadHistoricalData(): Record<string, DailyBar[]> {
  if (_cachedData) return _cachedData;
  const dataPath = resolve(__dirname, 'data', 'historical-daily.json');
  _cachedData = JSON.parse(readFileSync(dataPath, 'utf8'));
  return _cachedData!;
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

function getPrice(allData: Record<string, DailyBar[]>, sym: string, dateMap: Map<string, number>, date: string): number {
  const idx = dateMap.get(date);
  return idx !== undefined ? (allData[sym][idx]?.close ?? 0) : 0;
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
  enableVolTargeting: appConfig.strategy.enableVolTargeting,
  lookbackDays: appConfig.strategy.lookbackDays,
  commissionPerTrade: 1.0,
};

// ---------- Core Backtest ----------

export function runBacktest(
  config: BacktestConfig,
  startingCapital: number,
  initialPositions?: Position[],
  startDate?: string,
  endDate?: string,
): BacktestResult {
  const allData = loadHistoricalData();
  const symbols = config.symbols ?? SYMBOLS;

  const { dates, symbolDateMap } = buildDateIndex(allData, symbols);

  let startIdx = config.lookbackDays;
  let endIdx = dates.length;
  if (startDate) {
    const idx = dates.indexOf(startDate);
    if (idx >= 0) startIdx = Math.max(idx, config.lookbackDays);
  }
  if (endDate) {
    const idx = dates.indexOf(endDate);
    if (idx >= 0) endIdx = idx + 1;
  }

  let positions: Position[] = initialPositions ? initialPositions.map(p => ({ ...p })) : [];
  let cash = startingCapital;

  if (initialPositions && initialPositions.length > 0) {
    const date0 = dates[startIdx];
    let posValue = 0;
    for (const p of positions) {
      const dm = symbolDateMap.get(p.symbol);
      posValue += dm ? p.shares * getPrice(allData, p.symbol, dm, date0) : 0;
    }
    cash = Math.max(0, startingCapital - posValue);
  }

  const trades: TradeRecord[] = [];
  const dailyValues: number[] = [];
  const dailyReturnsList: number[] = [];
  const regimeCounts: Record<string, number> = {};
  let rebalanceCount = 0;
  let lastRebalanceIdx = -Infinity;
  let peakValue = startingCapital;

  // Build rebalance params from config (same shape the shared module expects)
  const rebalParams: RebalanceParams = {
    optimizerMethod: config.optimizerMethod === 'buy_and_hold' ? 'equal_weight' : config.optimizerMethod,
    driftThresholdPct: config.rebalanceDriftPct,
    minTradeUsd: 50,
    enableRegimeOverlay: config.enableRegimeOverlay,
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
      prices.set(s, getPrice(allData, s, symbolDateMap.get(s)!, date));
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
          const shares = Math.floor(perStock / price);
          if (shares > 0) {
            positions.push({ symbol: s, shares, avgCost: price });
            cash -= shares * price + config.commissionPerTrade;
            trades.push({ day: dayIdx, date, symbol: s, action: 'BUY', shares, price, commission: config.commissionPerTrade, reason: 'Initial equal-weight buy' });
          }
        }
      }
      continue;
    }

    // Rebalance frequency gate
    if (dayIdx - lastRebalanceIdx < config.rebalanceFreqDays) continue;

    // Build returns matrix for active symbols with enough lookback
    const lookbackDates = dates.slice(Math.max(0, dayIdx - config.lookbackDays), dayIdx + 1);
    const optimSymbols: string[] = [];
    const returnsMatrix: number[][] = [];
    const priceArrays: number[][] = [];
    const ohlcBarArrays: { high: number; low: number; close: number }[][] = [];
    for (const s of activeSymbols) {
      const dm = symbolDateMap.get(s)!;
      const closes: number[] = [];
      const bars: { high: number; low: number; close: number }[] = [];
      for (const d of lookbackDates) {
        const idx = dm.get(d);
        if (idx !== undefined) {
          const bar = allData[s][idx];
          closes.push(bar.close);
          bars.push({ high: bar.high, low: bar.low, close: bar.close });
        }
      }
      if (closes.length >= 30) {
        optimSymbols.push(s);
        priceArrays.push(closes);
        ohlcBarArrays.push(bars);
        returnsMatrix.push(dailyReturns(closes));
      }
    }

    if (optimSymbols.length < 2 || returnsMatrix[0].length < 30) continue;

    // Use shared module for weight computation (computes covariance internally)
    const { weights: rawWeights, source: weightSource, covMatrix } = computeTargetWeights(
      returnsMatrix, optimSymbols, priceArrays, rebalParams.optimizerMethod,
    );
    if (covMatrix.length === 0) continue;

    // Use shared module for exposure — pass OHLC bars for proper ADX
    const { exposure, regime, drawdown } = computeExposure(
      priceArrays, covMatrix, dailyReturnsList, nav, peakValue, rebalParams, ohlcBarArrays,
    );

    if (regime) regimeCounts[regime] = (regimeCounts[regime] ?? 0) + 1;

    // Hard stop: liquidate all
    if (drawdown.level === 'stopped') {
      for (const pos of positions) {
        if (pos.shares > 0) {
          const price = prices.get(pos.symbol) ?? 0;
          cash += pos.shares * price - config.commissionPerTrade;
          trades.push({ day: dayIdx, date, symbol: pos.symbol, action: 'SELL', shares: pos.shares, price, commission: config.commissionPerTrade, reason: `Hard stop: drawdown ${drawdown.drawdownPct.toFixed(1)}%` });
          pos.shares = 0;
        }
      }
      positions = positions.filter(p => p.shares > 0);
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

    // Use shared drift calculation
    const drift = computeDrift(snapshot, targetWeightMap);
    if (drift < config.rebalanceDriftPct && positions.length > 0) continue;

    // Use shared order generation
    const rebalOrders = generateRebalanceOrders(snapshot, targetWeightMap, weightSource, 50);
    if (rebalOrders.length === 0) continue;

    lastRebalanceIdx = dayIdx;
    rebalanceCount++;

    // Execute orders (sells first, then buys — generateRebalanceOrders already sorts this way)
    for (const order of rebalOrders) {
      const price = prices.get(order.symbol) ?? 0;
      if (order.action === 'SELL') {
        const pos = positions.find(p => p.symbol === order.symbol);
        if (pos && pos.shares >= order.shares) {
          pos.shares -= order.shares;
          cash += order.shares * price - config.commissionPerTrade;
          trades.push({ day: dayIdx, date, symbol: order.symbol, action: 'SELL', shares: order.shares, price, commission: config.commissionPerTrade, reason: order.reason });
        }
      } else {
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
    finalPrices.set(s, getPrice(allData, s, dm, finalDate));
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
    trades, totalCommissions, regimeCounts, rebalanceCount, dailyValues,
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
