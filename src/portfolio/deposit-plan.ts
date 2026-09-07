/**
 * Directed deployment of an incoming deposit, sized against the targets the
 * model is ABOUT to adopt rather than the ones it currently holds.
 *
 * This is deliberately not `allocateCashFlow`. That path is the right one for
 * routine idle cash, but it is wrong immediately around a reweight:
 *
 *   - it skips names the strategy sold within the rebuy-guard window, so right
 *     after a rebalance it refuses to buy back the very names a deposit is
 *     meant to top up, and parks their share of the deposit in cash;
 *   - it sizes against the CURRENT model weights, and a deposit funding a new
 *     allocation has to be sized against the new ones.
 *
 * Using this first, then switching the model, means the new weights land on a
 * book that already matches them — `computeDrift` stays under the threshold and
 * the gate stays `within-threshold`, so no sells fire and the frequencyDays
 * cooldown is never reset. Doing it the other way round risks drift at or above
 * the threshold, which puts the gate in `too-soon` until the cooldown lapses and
 * blocks deployment entirely.
 *
 * Buy-only by construction: it can be wrong about where to put money, but it
 * cannot realise a gain.
 */

export interface DepositPlanInput {
  /** Target weights the model is moving TO. Must sum to 100. */
  targets: Record<string, number>;
  /** Current market value per symbol, in account currency. */
  holdings: Map<string, number>;
  /** Price per share per symbol. Every target name needs one. */
  prices: Map<string, number>;
  /** Net liquidation BEFORE the deposit. */
  nav: number;
  /** Idle cash BEFORE the deposit — deployed alongside it. */
  cash: number;
  depositUsd: number;
  /** Funded to target first, in order. The deposit's stated purpose. */
  directed?: string[];
  /** Held back for commission and slippage. Never spent. */
  reserveUsd?: number;
  /**
   * Names the rebuy guard is holding back, from `recentlySoldSymbols`.
   *
   * Applied to the water-fill only. A name in `directed` is exempt: the guard
   * exists to stop buy-only cash flow round-tripping something the strategy
   * just sold, which is right for incidental cash and wrong for a deposit —
   * a name the operator wrote down in advance is an instruction, not churn.
   */
  excluded?: ReadonlySet<string>;
}

export interface DepositPlanOrder {
  symbol: string;
  action: 'BUY';
  qty: number;
  estimatedValue: number;
  reason: string;
}

export interface DepositPlan {
  orders: DepositPlanOrder[];
  /** NAV including the deposit — the base every target is sized against. */
  navAfter: number;
  deployedUsd: number;
  residualCashUsd: number;
  /** Largest |current − target| in percentage points, AFTER the buy. */
  maxDriftPct: number;
}

const TARGET_SUM_TOLERANCE = 0.01;

export function planDepositBuy(input: DepositPlanInput): DepositPlan {
  const { targets, prices, nav, cash, depositUsd } = input;
  const reserveUsd = input.reserveUsd ?? 0;
  const directed = input.directed ?? [];

  if (!Number.isFinite(depositUsd) || depositUsd < 0) {
    throw new Error(`deposit must be a non-negative number, got ${depositUsd}`);
  }
  // Targets may sum to LESS than 100 and that is not an error: the strategist
  // passes `targetWeights * exposureMultiplier * ddMultiplier`, so in a
  // drawdown or with vol targeting on the shortfall is de-risking held as cash
  // on purpose. Demanding exactly 100 would throw inside the agent precisely
  // when the fund is already drawn down — the worst moment to lose it.
  //
  // Above 100 is a different thing entirely: not de-risking but a broken
  // model, sizing buys against money that does not exist.
  const sum = Object.values(targets).reduce((a, b) => a + b, 0);
  if (!(sum > 0)) {
    throw new Error(`targets sum to ${sum} — nothing to deploy against`);
  }
  if (sum > 100 + TARGET_SUM_TOLERANCE) {
    throw new Error(`targets sum to ${sum}, over 100`);
  }
  const missing = Object.keys(targets).filter((s) => !(prices.get(s)! > 0));
  if (missing.length > 0) {
    throw new Error(`no price for: ${missing.join(', ')}`);
  }
  const unknownDirected = directed.filter((s) => !(s in targets));
  if (unknownDirected.length > 0) {
    throw new Error(`directed names not in targets: ${unknownDirected.join(', ')}`);
  }

  // Local copy: callers pass live state, and a planner must not mutate it.
  const held = new Map<string, number>();
  for (const s of Object.keys(targets)) held.set(s, input.holdings.get(s) ?? 0);

  const navAfter = nav + depositUsd;
  let budget = cash + depositUsd - reserveUsd;
  const shares = new Map<string, number>();

  const deficitOf = (s: string): number => (navAfter * targets[s]) / 100 - held.get(s)!;
  const buy = (s: string, qty: number): void => {
    const price = prices.get(s)!;
    shares.set(s, (shares.get(s) ?? 0) + qty);
    held.set(s, held.get(s)! + qty * price);
    budget -= qty * price;
  };

  // 1. Directed names to target first, so the deposit's purpose is funded even
  //    when some other name happens to carry a larger deficit.
  for (const s of directed) {
    const price = prices.get(s)!;
    const qty = Math.floor(Math.min(deficitOf(s), budget) / price);
    if (qty > 0) buy(s, qty);
  }

  // 2. Greedy water-fill — one share at a time into the largest remaining
  //    deficit that still fits. Mirrors production's REBALANCE_FILL_MODE=greedy.
  //    A proportional split strands cash: each name's slice can fall below the
  //    price of a single share of the name that most needs it, so the money
  //    sits idle instead. One-share steps also self-terminate, because every
  //    step strictly reduces the budget by at least the cheapest price.
  const guarded = (s: string): boolean =>
    (input.excluded?.has(s) ?? false) && !directed.includes(s);

  for (;;) {
    let best: string | null = null;
    let bestDeficit = 0;
    for (const s of Object.keys(targets)) {
      if (guarded(s)) continue;
      const deficit = deficitOf(s);
      if (deficit > 0 && prices.get(s)! <= budget && deficit > bestDeficit) {
        bestDeficit = deficit;
        best = s;
      }
    }
    if (best === null) break;
    buy(best, 1);
  }

  const orders: DepositPlanOrder[] = [...shares.entries()]
    .map(([symbol, qty]) => ({
      symbol,
      action: 'BUY' as const,
      qty,
      estimatedValue: Math.round(qty * prices.get(symbol)! * 100) / 100,
      reason: 'directed deposit deployment (pre-reweight)',
    }))
    .sort((a, b) => b.estimatedValue - a.estimatedValue || a.symbol.localeCompare(b.symbol));

  const deployedUsd = orders.reduce((a, o) => a + o.estimatedValue, 0);

  let maxDriftPct = 0;
  for (const [s, target] of Object.entries(targets)) {
    const pct = navAfter > 0 ? (held.get(s)! / navAfter) * 100 : 0;
    maxDriftPct = Math.max(maxDriftPct, Math.abs(pct - target));
  }

  return {
    orders,
    navAfter,
    deployedUsd,
    residualCashUsd: Math.round((cash + depositUsd - deployedUsd) * 100) / 100,
    maxDriftPct,
  };
}
