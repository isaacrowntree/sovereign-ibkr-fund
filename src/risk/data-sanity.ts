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
