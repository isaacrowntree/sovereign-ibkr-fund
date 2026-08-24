/**
 * Pure sanity checks on market data and order size — the backstops that keep a
 * garbled bezant read (zeroed NAV, a 100x-low price tick) from generating or
 * executing a wrong-sized trade. All functions are pure and unit-tested; the
 * strategist and executor call them and act (skip generation / halt the run).
 */

export interface NavSanityConfig {
  minNavUsd: number;
  maxNavMovePct: number;
}

/**
 * Reason the NAV read looks suspect, or null if it's fine. `lastNavUsd` is the
 * NAV from the previous strategist cycle (undefined on the first run).
 */
export function navSanityViolation(
  navUsd: number,
  lastNavUsd: number | undefined,
  cfg: NavSanityConfig,
): string | null {
  if (!Number.isFinite(navUsd) || navUsd <= 0) return `NAV is ${navUsd} (non-positive/NaN)`;
  if (navUsd < cfg.minNavUsd) return `NAV $${navUsd.toFixed(0)} below floor $${cfg.minNavUsd}`;
  if (lastNavUsd !== undefined && lastNavUsd > 0) {
    const movePct = Math.abs(navUsd - lastNavUsd) / lastNavUsd * 100;
    if (movePct > cfg.maxNavMovePct) {
      return `NAV moved ${movePct.toFixed(0)}% ($${lastNavUsd.toFixed(0)}→$${navUsd.toFixed(0)}) > ${cfg.maxNavMovePct}%`;
    }
  }
  return null;
}

/**
 * Symbols whose current price looks suspect vs the last known price. Missing/
 * zero prices and moves beyond `maxPriceMovePct` are flagged. `lastPrices` may
 * omit a symbol (no prior) — a first-seen price is only rejected if ≤ 0.
 */
export function priceSanityViolations(
  prices: Map<string, number>,
  lastPrices: Map<string, number>,
  maxPriceMovePct: number,
): Array<{ symbol: string; reason: string }> {
  const bad: Array<{ symbol: string; reason: string }> = [];
  for (const [symbol, px] of prices) {
    if (!Number.isFinite(px) || px <= 0) {
      bad.push({ symbol, reason: `price ${px} (missing/non-positive)` });
      continue;
    }
    const last = lastPrices.get(symbol);
    if (last !== undefined && last > 0) {
      const movePct = Math.abs(px - last) / last * 100;
      if (movePct > maxPriceMovePct) {
        bad.push({ symbol, reason: `price moved ${movePct.toFixed(0)}% ($${last}→$${px}) > ${maxPriceMovePct}%` });
      }
    }
  }
  return bad;
}

export interface NotionalCaps {
  maxOrderNotionalUsd: number;
  maxOrderPctNav: number;
  maxRunNotionalUsd: number;
}

/**
 * Reason a single order breaches the absolute backstop caps, or null. These
 * are independent of the percentage-of-NAV sizing — a final gate against an
 * order that is implausibly large in dollars.
 */
export function orderCapViolation(
  orderNotionalUsd: number,
  navUsd: number,
  runNotionalSoFarUsd: number,
  caps: NotionalCaps,
): string | null {
  const n = orderNotionalUsd;
  if (n > caps.maxOrderNotionalUsd) {
    return `order notional $${n.toFixed(0)} > cap $${caps.maxOrderNotionalUsd}`;
  }
  if (navUsd > 0 && n > (caps.maxOrderPctNav / 100) * navUsd) {
    return `order notional $${n.toFixed(0)} > ${caps.maxOrderPctNav}% of NAV ($${navUsd.toFixed(0)})`;
  }
  if (runNotionalSoFarUsd + n > caps.maxRunNotionalUsd) {
    return `run notional $${(runNotionalSoFarUsd + n).toFixed(0)} would exceed cap $${caps.maxRunNotionalUsd}`;
  }
  return null;
}

// ---------- Market-data freshness ----------

export interface MarketDataFreshnessInput {
  /** `state.lastQuantAt` — when quant-analyst last wrote market data. */
  lastQuantAt?: string;
  /** `state.priceHistoryDates` — the trading-day index behind priceHistory. */
  priceHistoryDates?: string[];
  now: Date;
  /** Max age of lastQuantAt before the data is refused. */
  maxQuantAgeMs: number;
  /** Max calendar days between the newest stored trading day and now. */
  maxHistoryGapDays: number;
}

export type MarketDataFreshness =
  | { fresh: true; ageMs: number }
  | { fresh: false; reason: 'missing' | 'stale' | 'clock'; detail: string };

/**
 * FAIL SAFE: refuse to size orders against market data we cannot prove is current.
 *
 * The execution side already gates on risk staleness (see execution/risk-gate.ts),
 * but nothing gated the QUANT data that order sizing is actually derived from.
 * If quant-analyst dies, priceHistory silently freezes: the optimizer keeps
 * emitting weights from an old covariance matrix, and — worse — the strategist's
 * own price sanity check compares today's live quotes against that frozen baseline,
 * so it stops being able to detect a bad tick at the same moment it is most needed.
 * Both failures are invisible; the agent keeps running and keeps trading.
 *
 * Seeded history makes this sharper, not softer: a seeded series is indistinguishable
 * from an accumulated one, so without a freshness check a seed could keep a dead
 * pipeline looking healthy indefinitely.
 *
 * Depth is deliberately NOT checked here. Thin history is a real, handled state —
 * the strategist falls back to the static model portfolio, which needs no history
 * at all. Only staleness blocks.
 */
export function marketDataFreshness(input: MarketDataFreshnessInput): MarketDataFreshness {
  const { lastQuantAt, priceHistoryDates, now, maxQuantAgeMs, maxHistoryGapDays } = input;

  if (!lastQuantAt) {
    return { fresh: false, reason: 'missing', detail: 'no lastQuantAt — quant-analyst has never written market data' };
  }
  const at = new Date(lastQuantAt).getTime();
  if (Number.isNaN(at)) {
    return { fresh: false, reason: 'stale', detail: `unparseable lastQuantAt (${lastQuantAt})` };
  }
  const ageMs = now.getTime() - at;
  // A future timestamp means a clock step or a corrupted write, not freshness.
  // The Pi has no RTC and steps on NTP sync, so this is reachable.
  if (ageMs < 0) {
    return { fresh: false, reason: 'clock', detail: `lastQuantAt is in the future (${lastQuantAt}) — clock step?` };
  }
  if (ageMs > maxQuantAgeMs) {
    return {
      fresh: false,
      reason: 'stale',
      detail: `market data is ${(ageMs / 3_600_000).toFixed(1)}h old (limit ${(maxQuantAgeMs / 3_600_000).toFixed(1)}h)`,
    };
  }

  // lastQuantAt only proves the agent RAN. If it ran but stored nothing new — a
  // gateway returning no quotes, or every run landing on a non-trading day — the
  // series itself is what went stale.
  if (priceHistoryDates && priceHistoryDates.length > 0) {
    const newest = priceHistoryDates[priceHistoryDates.length - 1];
    const t = new Date(`${newest}T00:00:00Z`).getTime();
    if (Number.isNaN(t)) {
      return { fresh: false, reason: 'stale', detail: `unparseable newest trading day (${newest})` };
    }
    const gapDays = (now.getTime() - t) / 86_400_000;
    if (gapDays > maxHistoryGapDays) {
      return {
        fresh: false,
        reason: 'stale',
        detail: `newest stored trading day is ${newest}, ${gapDays.toFixed(1)} days ago (limit ${maxHistoryGapDays})`,
      };
    }
  }

  return { fresh: true, ageMs };
}
