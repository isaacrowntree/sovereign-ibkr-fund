/**
 * Shared rebalancing logic used by both live agents and backtest engine.
 *
 * Single source of truth for:
 *   - Target weight computation (HRP, B-L, equal weight)
 *   - Regime exposure adjustment
 *   - Vol targeting adjustment
 *   - Drawdown exposure adjustment
 *   - Drift calculation
 *   - Rebalance order generation (sells first, then buys)
 */
import { hrpWeights } from './hrp.js';
import { riskParityWeights } from './risk-parity.js';
import { blackLitterman } from './black-litterman.js';
import { ledoitWolfShrinkage } from './covariance.js';
import { trendSignal, trendStrengthSignal, momentumBreadthSignal, volRegimeSignal, volExpansionSignal, correlationSignal, compositeRegime, regimeExposure, type RegimeState, type OHLCBar } from '../quant/regime.js';
import { realizedVolatility, annualizeVol, volTargetLeverage } from '../risk/volatility.js';
import { assessDrawdown, drawdownExposureMultiplier, type DrawdownLimits, type DrawdownState } from '../risk/drawdown.js';
import { momentumScore } from '../quant/factors.js';
import { isWashSaleRestricted, type WashSaleEntry } from '../tax/harvesting.js';
import { covToCorr } from './covariance.js';

// ---------- Types ----------

/**
 * `static` is not an optimizer — it targets the model portfolio's own weights.
 * It exists so the allocation the fund ACTUALLY runs is expressible here: every
 * comparison in src/validation previously had to approximate it as buy-and-hold
 * (never rebalancing) or equal-weight, neither of which is what the strategist
 * does. It also replaces the HRP_MIN_DAYS=999999 workaround as the honest way to
 * say "do not optimize, hold the deliberate allocation".
 */
export type OptimizerMethod = 'hrp' | 'risk_parity' | 'black_litterman' | 'equal_weight' | 'static';

export interface RebalanceParams {
  optimizerMethod: OptimizerMethod;
  driftThresholdPct: number;
  minTradeUsd: number;
  enableRegimeOverlay: boolean;
  enableVolTargeting: boolean;
  targetVol: number;
  maxLeverage: number;
  drawdownLimits: DrawdownLimits;
  /**
   * Daily samples required before a regime is considered known. Matches
   * quant-analyst's `>= 200` gate. 0 keeps the legacy always-known behaviour.
   */
  regimeMinHistory?: number;
  /** Exposure multiplier applied while the regime is UNKNOWN. */
  unknownRegimeExposure?: number;
  /** Model portfolio weights, in `symbols` order. Required by optimizerMethod 'static'. */
  staticWeights?: number[];
}

export interface PortfolioSnapshot {
  symbols: string[];
  prices: Map<string, number>;
  currentShares: Map<string, number>;
  nav: number;
  cash: number;
  peakNav: number;
}

export interface RebalanceOrder {
  symbol: string;
  action: 'BUY' | 'SELL';
  shares: number;
  estimatedValue: number;
  reason: string;
}

export interface RebalanceDecision {
  targetWeights: Map<string, number>;
  weightSource: string;
  exposure: number;
  regime: RegimeState | null;
  drawdown: DrawdownState;
  maxDrift: number;
  shouldRebalance: boolean;
  orders: RebalanceOrder[];
}

// ---------- Weight computation ----------

export function computeTargetWeights(
  returnsMatrix: number[][],
  symbols: string[],
  priceArrays: number[][],
  method: OptimizerMethod,
  precomputedCov?: number[][],
  /** Required by `static`: the model portfolio weight per symbol, same order. */
  staticWeights?: number[],
): { weights: number[]; source: string; covMatrix: number[][] } {
  const n = symbols.length;
  if (n === 0) return { weights: [], source: 'empty', covMatrix: [] };

  // Use pre-computed covariance if provided, otherwise compute
  let covMatrix: number[][];
  if (precomputedCov && precomputedCov.length > 0) {
    covMatrix = precomputedCov;
  } else {
    const minRetLen = Math.min(...returnsMatrix.map(r => r.length));
    const aligned = returnsMatrix.map(r => r.slice(r.length - minRetLen));
    const { shrunk } = ledoitWolfShrinkage(aligned);
    covMatrix = shrunk;
  }
  // `static` still returns the covariance it computed above. It does not NEED it
  // to pick weights, but callers do: the backtest engine skips any day where the
  // covariance is empty, and computeExposure derives the regime's correlation
  // signal from it. Returning [] here silently turned every static run into a
  // no-trade buy-and-hold — identical numbers, no error.
  if (method === 'static') {
    if (!staticWeights || staticWeights.length !== n) {
      return { weights: new Array(n).fill(1 / n), source: 'equal_weight (no static weights supplied)', covMatrix };
    }
    const sum = staticWeights.reduce((a, b) => a + b, 0);
    return {
      weights: sum > 0 ? staticWeights.map(w => w / sum) : new Array(n).fill(1 / n),
      source: 'static',
      covMatrix,
    };
  }

  if (covMatrix.length === 0) return { weights: new Array(n).fill(1 / n), source: 'equal_weight (fallback)', covMatrix: [] };

  switch (method) {
    case 'hrp': {
      const { weights } = hrpWeights(covMatrix);
      return { weights, source: 'HRP', covMatrix };
    }
    case 'risk_parity': {
      return { weights: riskParityWeights(covMatrix), source: 'risk_parity', covMatrix };
    }
    case 'black_litterman': {
      const marketWeights = new Array(n).fill(1 / n);
      const P = Array.from({ length: n }, (_, i) => {
        const row = new Array(n).fill(0);
        row[i] = 1;
        return row;
      });
      const Q = priceArrays.map(pa => momentumScore(pa) * 0.1);
      try {
        const bl = blackLitterman(covMatrix, marketWeights, { P, Q }, 2.5, 0.05);
        const raw = bl.optimalWeights.map(w => Math.max(0, w));
        const sum = raw.reduce((s, w) => s + w, 0);
        return { weights: sum > 0 ? raw.map(w => w / sum) : new Array(n).fill(1 / n), source: 'black_litterman', covMatrix };
      } catch {
        return { weights: new Array(n).fill(1 / n), source: 'equal_weight (B-L failed)', covMatrix };
      }
    }
    case 'equal_weight':
    default:
      return { weights: new Array(n).fill(1 / n), source: 'equal_weight', covMatrix };
  }
}

// ---------- Exposure computation ----------

export function computeExposure(
  priceArrays: number[][],
  covMatrix: number[][],
  portfolioReturns: number[],
  nav: number,
  peakNav: number,
  params: RebalanceParams,
  ohlcBarArrays?: OHLCBar[][],
): { exposure: number; regime: RegimeState | null; drawdown: DrawdownState } {
  const dd = assessDrawdown(nav, peakNav, params.drawdownLimits);
  let ddMult = drawdownExposureMultiplier(dd.level);

  let regimeMult = 1.0;
  let regime: RegimeState | null = null;
  // Mirror the LIVE gate: quant-analyst only publishes a regime once it holds
  // `regimeMinHistory` daily samples, and writes null below that. Without this the
  // backtest always has a regime and is therefore systematically more optimistic
  // than production, which is exactly the blind spot being measured here.
  const minHist = params.regimeMinHistory ?? 0;
  const haveHist = priceArrays[0]?.length ?? 0;
  const regimeKnown = params.enableRegimeOverlay && priceArrays.length > 0 && haveHist >= minHist;
  if (params.enableRegimeOverlay && !regimeKnown) {
    // Unknown is NOT the same as risk-on. Defaulting to 1.0 means the exposure
    // overlay silently fails OPEN during every blind window.
    regimeMult = params.unknownRegimeExposure ?? 1.0;
  }
  if (regimeKnown) {
    const avgPrices = priceArrays[0].map((_, i) => {
      let sum = 0;
      for (const pa of priceArrays) sum += (pa[i] ?? 0);
      return sum / priceArrays.length;
    });

    const trend = trendSignal(avgPrices, 50, Math.min(200, avgPrices.length));

    // Per-stock ADX breadth: compute ADX for each stock individually, then aggregate
    let ts: 1 | 0 | -1;
    if (ohlcBarArrays && ohlcBarArrays.length > 0) {
      ts = trendStrengthSignal(ohlcBarArrays);
    } else {
      ts = trendStrengthSignal(priceArrays);
    }

    // Momentum breadth: % of stocks above their 50-day MA
    const mom = momentumBreadthSignal(priceArrays);
    const pReturns: number[] = [];
    for (let i = 1; i < avgPrices.length; i++) {
      pReturns.push((avgPrices[i] - avgPrices[i - 1]) / avgPrices[i - 1]);
    }
    const annVol = annualizeVol(realizedVolatility(pReturns)) * 100;
    const vol = volRegimeSignal(annVol);
    const ve = volExpansionSignal(pReturns);
    const corr = correlationSignal(covToCorr(covMatrix));
    const r = compositeRegime({ trend, trendStrength: ts, momentum: mom, volatility: vol, volExpansion: ve, correlation: corr });
    regime = r.composite;
    regimeMult = regimeExposure(r.composite);
  }

  let volMult = 1.0;
  if (params.enableVolTargeting && portfolioReturns.length >= 20) {
    const recent = portfolioReturns.slice(-60);
    const rv = annualizeVol(realizedVolatility(recent));
    volMult = volTargetLeverage(rv, params.targetVol, params.maxLeverage);
  }

  return {
    exposure: Math.min(params.maxLeverage, ddMult * regimeMult * volMult),
    regime,
    drawdown: dd,
  };
}

// ---------- Drift & order generation ----------

function dailyReturns(closes: number[]): number[] {
  const ret: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    ret.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return ret;
}

export function computeDrift(
  snapshot: PortfolioSnapshot,
  targetWeights: Map<string, number>,
): number {
  let maxD = 0;
  for (const [sym, target] of targetWeights) {
    const price = snapshot.prices.get(sym) ?? 0;
    const shares = snapshot.currentShares.get(sym) ?? 0;
    const currentPct = snapshot.nav > 0 ? (shares * price) / snapshot.nav : 0;
    maxD = Math.max(maxD, Math.abs(currentPct - target));
  }
  return maxD * 100; // as percentage
}

/**
 * Outcome of the rebalance-gate decision.
 *
 *   `urgent`             — single-name drift exceeded `urgentDriftThreshold`.
 *                          Bypasses the days-since-last cooldown.
 *   `regular`            — `maxDrift >= driftThreshold` AND
 *                          `daysSince >= frequencyDays`. Standard rebalance.
 *   `within-threshold`   — drift below threshold; cash-flow rebalance only.
 *   `too-soon`           — drift exceeds threshold but cooldown active.
 *                          Wait for either daysSince to lapse or for drift
 *                          to climb past the urgent threshold.
 */
export type RebalanceTrigger = 'urgent' | 'regular' | 'too-soon' | 'within-threshold';

export interface RebalanceGateConfig {
  driftThreshold: number;
  urgentDriftThreshold: number;
  frequencyDays: number;
}

/**
 * Pure decision: should we rebalance now? Two triggers:
 *
 *   1. Urgent — any single name drifted past `urgentDriftThreshold` (default
 *      25%). Bypasses the cooldown to avoid sitting on a wildly off-target
 *      position for 45+ days.
 *   2. Regular — max drift exceeds `driftThreshold` (default 10%) AND we're
 *      past the `frequencyDays` cooldown.
 */
export function decideRebalance(
  maxDrift: number,
  daysSinceLast: number,
  cfg: RebalanceGateConfig,
): RebalanceTrigger {
  if (maxDrift >= cfg.urgentDriftThreshold) return 'urgent';
  if (maxDrift >= cfg.driftThreshold && daysSinceLast >= cfg.frequencyDays) return 'regular';
  if (maxDrift < cfg.driftThreshold) return 'within-threshold';
  return 'too-soon';
}

/**
 * Options for `generateRebalanceOrders` controlling the algorithmic
 * behaviour: how much cash to reserve, how to allocate scarce cash across
 * BUYs, and tax-aware ordering of SELLs.
 */
export interface RebalanceOptions {
  /**
   * Reserve this percentage of NAV as cash. Each target value is scaled
   * by `(1 - cashBufferPct/100)` before sizing. Default 0 (no buffer
   * beyond `minTradeUsd`).
   */
  cashBufferPct?: number;
  /**
   * Strategy when the sum of full-size BUYs exceeds available cash.
   *
   *   `'greedy'` — sort by drift desc, fully fill the largest gaps first;
   *     drop the lowest-priority BUYs when cash runs out. Decisive — moves
   *     the portfolio meaningfully toward target each cycle.
   *   `'proportional'` — scale every BUY by the same factor. Preserves
   *     relative weights but leaves the portfolio uniformly underweight.
   *
   * Default: `'proportional'` (preserves backward compatibility with
   * earlier behaviour). Production config should set `'greedy'`.
   */
  fillMode?: 'greedy' | 'proportional';
  /**
   * Per-symbol average cost basis. When provided, SELLs are sorted so the
   * positions with the lowest unrealized P&L per share (most loss / least
   * gain) execute first. IBKR's default lot selection then realizes
   * losses preferentially — relevant for AU CGT on rebalances.
   */
  avgCosts?: Map<string, number>;
  /**
   * Active wash-sale entries (created when execution-bot SELLs at a loss).
   * Any BUY for a symbol still inside its 31-day wash window is dropped
   * from the queue — re-buying within that window risks the ATO denying
   * the loss claim per AU CGT wash-sale guidance. The strategist logs
   * which BUYs were suppressed so it's visible why a target stays
   * underweight.
   */
  washSales?: WashSaleEntry[];
}

/**
 * Small absolute reserve added on top of the percentage cash buffer to
 * absorb SELL-side commission / slippage so the BUY queue doesn't tip
 * into "insufficient buying power" territory at execution time.
 */
const CASH_ABSOLUTE_RESERVE_USD = 50;

export function generateRebalanceOrders(
  snapshot: PortfolioSnapshot,
  targetWeights: Map<string, number>,
  weightSource: string,
  minTradeUsd: number,
  options: RebalanceOptions = {},
): RebalanceOrder[] {
  const orders: RebalanceOrder[] = [];
  const cashBufferPct = options.cashBufferPct ?? 0;
  const fillMode = options.fillMode ?? 'proportional';
  const avgCosts = options.avgCosts;
  const washSales = options.washSales ?? [];

  // Apply cash buffer to target values: each target is scaled down by
  // `(1 - cashBufferPct/100)`, reserving that percentage of NAV as cash.
  // Without this, when targets sum to 100% and the account holds any
  // cash, the buy queue always exceeds the available-cash limit and the
  // scaling/greedy logic fires every cycle for no good reason.
  const bufferFraction = cashBufferPct / 100;
  const adjustedTargetValue = (targetPct: number): number =>
    snapshot.nav * targetPct * (1 - bufferFraction);

  // ---------- SELL pass ----------

  interface SellCandidate {
    sym: string;
    price: number;
    sellShares: number;
    currentValue: number;
    targetPct: number;
    /** P&L per share (price - avgCost). Negative = unrealized loss. */
    unrealizedPnlPerShare: number;
  }
  const sellCandidates: SellCandidate[] = [];
  for (const [sym, targetPct] of targetWeights) {
    const price = snapshot.prices.get(sym) ?? 0;
    if (price <= 0) continue;
    const shares = snapshot.currentShares.get(sym) ?? 0;
    const currentValue = shares * price;
    const targetValue = adjustedTargetValue(targetPct);

    if (currentValue > targetValue + minTradeUsd) {
      const sellShares = Math.floor((currentValue - targetValue) / price);
      if (sellShares > 0) {
        // When avgCost isn't known, treat P&L as 0 (price - price).
        const avgCost = avgCosts?.get(sym) ?? price;
        const unrealizedPnlPerShare = price - avgCost;
        sellCandidates.push({
          sym,
          price,
          sellShares,
          currentValue,
          targetPct,
          unrealizedPnlPerShare,
        });
      }
    }
  }

  // Loss-first ordering for tax efficiency (only when avgCosts provided —
  // otherwise the sort is meaningless). Lowest P&L-per-share first means
  // most-loss/least-gain executes earliest, so IBKR's lot accounting
  // realises losses preferentially. Relevant for AU CGT on this account.
  if (avgCosts) {
    sellCandidates.sort(
      (a, b) => a.unrealizedPnlPerShare - b.unrealizedPnlPerShare,
    );
  }

  let sellNotional = 0;
  for (const c of sellCandidates) {
    const value = c.sellShares * c.price;
    sellNotional += value;
    const taxNote = avgCosts
      ? (() => {
          const pnl = c.unrealizedPnlPerShare;
          const sign = pnl >= 0 ? '+' : '-';
          return ` (P&L/share: ${sign}$${Math.abs(pnl).toFixed(2)})`;
        })()
      : '';
    orders.push({
      symbol: c.sym, action: 'SELL', shares: c.sellShares,
      estimatedValue: value,
      reason: `rebalance: ${(c.currentValue / snapshot.nav * 100).toFixed(1)}% → ${(c.targetPct * 100).toFixed(1)}% (${weightSource})${taxNote}`,
    });
  }

  // ---------- BUY pass ----------

  interface BuyCandidate {
    sym: string;
    price: number;
    targetShares: number;
    currentValue: number;
    targetPct: number;
    /** Drift = targetPct - currentPct (positive for BUY candidates). */
    drift: number;
  }
  const buyCandidates: BuyCandidate[] = [];
  for (const [sym, targetPct] of targetWeights) {
    const price = snapshot.prices.get(sym) ?? 0;
    if (price <= 0) continue;
    // Wash-sale gate: if we sold this symbol at a loss within the last
    // 31 days, re-buying now risks the ATO denying the harvested loss.
    // Skip silently — the caller can compare target weights to generated
    // orders to surface what got suppressed.
    if (isWashSaleRestricted(sym, washSales)) continue;
    const shares = snapshot.currentShares.get(sym) ?? 0;
    const currentValue = shares * price;
    const targetValue = adjustedTargetValue(targetPct);

    if (targetValue > currentValue + minTradeUsd) {
      const buyShares = Math.floor((targetValue - currentValue) / price);
      if (buyShares > 0) {
        const currentPct = snapshot.nav > 0 ? currentValue / snapshot.nav : 0;
        const drift = targetPct - currentPct;
        buyCandidates.push({
          sym, price, targetShares: buyShares, currentValue, targetPct, drift,
        });
      }
    }
  }

  // Cash-aware gate. Reserve = the larger of the percentage buffer and
  // the absolute $50 floor. This way:
  //   * cashBufferPct = 0 (default) → reserve = $50, original behaviour
  //   * cashBufferPct = 1% on $10k NAV → reserve = max($50, $100) = $100
  //   * cashBufferPct = 1% on $1k NAV → reserve = max($50, $10) = $50
  // Avoids over-reserving when both knobs are set; the percentage buffer
  // already absorbs commission/slippage at any non-trivial NAV.
  const buyTotalAtFullSize = buyCandidates.reduce(
    (s, c) => s + c.targetShares * c.price,
    0,
  );
  const reserve = Math.max(
    CASH_ABSOLUTE_RESERVE_USD,
    snapshot.nav * bufferFraction,
  );
  const availableCashForBuys = Math.max(
    0,
    snapshot.cash + sellNotional - reserve,
  );

  if (fillMode === 'greedy') {
    // Greedy: sort by drift desc, fully fill highest-priority gaps first.
    // Drop (or partial-fill) when cash runs out.
    const sorted = [...buyCandidates].sort((a, b) => b.drift - a.drift);
    let cashRemaining = availableCashForBuys;
    for (const c of sorted) {
      const fullCost = c.targetShares * c.price;
      let shares: number;
      let partial = false;
      if (fullCost <= cashRemaining) {
        shares = c.targetShares;
      } else {
        shares = Math.floor(cashRemaining / c.price);
        partial = true;
      }
      if (shares <= 0) continue;
      const value = shares * c.price;
      if (value < minTradeUsd) continue;
      cashRemaining -= value;
      const partialNote = partial
        ? ` (partial fill: ${shares} of ${c.targetShares} fit cash)`
        : '';
      orders.push({
        symbol: c.sym, action: 'BUY', shares,
        estimatedValue: value,
        reason: `rebalance: ${(c.currentValue / snapshot.nav * 100).toFixed(1)}% → ${(c.targetPct * 100).toFixed(1)}% (${weightSource})${partialNote}`,
      });
    }
  } else {
    // Proportional: scale every BUY by the same factor. Preserves relative
    // weights at the cost of leaving the whole portfolio uniformly under-
    // target when cash-constrained.
    let scale = 1;
    if (buyTotalAtFullSize > availableCashForBuys && buyTotalAtFullSize > 0) {
      scale = availableCashForBuys / buyTotalAtFullSize;
    }
    for (const c of buyCandidates) {
      const shares = scale === 1 ? c.targetShares : Math.floor(c.targetShares * scale);
      if (shares <= 0) continue;
      const value = shares * c.price;
      if (value < minTradeUsd) continue;
      const scaleNote = scale === 1 ? '' : ` (scaled ${(scale * 100).toFixed(0)}% to fit cash)`;
      orders.push({
        symbol: c.sym, action: 'BUY', shares,
        estimatedValue: value,
        reason: `rebalance: ${(c.currentValue / snapshot.nav * 100).toFixed(1)}% → ${(c.targetPct * 100).toFixed(1)}% (${weightSource})${scaleNote}`,
      });
    }
  }

  return orders;
}

export { dailyReturns };
