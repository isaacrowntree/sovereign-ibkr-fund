/**
 * Staged execution planning: pure decision logic for execution-bot's
 * validation-first / sells-first / cash-gated-buys pattern.
 *
 * Why staged: the queue is generated from estimated prices on a cash
 * account with ~$0 free cash, so buys are funded entirely by sell
 * proceeds. Executing everything blind risks (a) discovering a wedged
 * gateway session only after several orders are in flight, and (b)
 * buys bouncing off insufficient cash. The pattern:
 *
 *   1. First-ever live session: execute ONE smallest-value SELL and
 *      require a confirmed fill before anything else — this is the
 *      live-order validation the bot was paused for.
 *   2. SELLs before BUYs (existing behavior, kept).
 *   3. BUYs only execute against actual account cash fetched at
 *      execution time, greedily in queue order, with headroom for
 *      price drift since the estimate. Deferred buys stay queued.
 */

import { tradingMsBetween } from '../strategy/market-hours.js';

export interface StagedOrder {
  symbol: string;
  action: 'BUY' | 'SELL';
  qty: number;
  estimatedValue: number;
  reason: string;
  /**
   * When the order was staged (ISO). Its quantity and value were sized
   * against prices and positions at that moment, so an old order is a guess
   * about a book that has since moved. Absent on orders staged before this
   * field existed; those never expire.
   */
  createdAt?: string;
}

/**
 * A directed-deposit order: staged on an explicit instruction (the deposit
 * policy, or the operator's --confirm in the deposit scripts), not derived
 * from drift. Never expired or cleared automatically — the instruction stands
 * until a human withdraws it.
 */
export function isDirectedOrder(o: Pick<StagedOrder, 'reason'>): boolean {
  return /^directed[ _]deposit/.test(o.reason ?? '');
}

/**
 * STAGED_ORDER_TTL_TRADING_HOURS: how many NYSE trading hours a staged order
 * lives. Default 13 — two full sessions. 0 turns expiry off.
 */
export function stagedOrderTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STAGED_ORDER_TTL_TRADING_HOURS;
  if (raw === undefined || raw.trim() === '') return 13 * 60 * 60 * 1000;
  const h = parseFloat(raw);
  return Number.isFinite(h) && h > 0 ? h * 60 * 60 * 1000 : 0;
}

/**
 * Has this order outlived its TTL, counted in trading time (a weekend or a
 * holiday does not age it)? Directed orders, orders with no createdAt and a
 * TTL of 0 never expire.
 */
export function isExpiredOrder(o: StagedOrder, now: Date, ttlMs: number): boolean {
  if (ttlMs <= 0 || isDirectedOrder(o) || !o.createdAt) return false;
  const at = new Date(o.createdAt);
  if (Number.isNaN(at.getTime())) return false;
  return tradingMsBetween(at, now) >= ttlMs;
}

/** Split a queue into orders still good and orders past their TTL. */
export function partitionExpired(
  queue: StagedOrder[],
  now: Date,
  ttlMs: number,
): { live: StagedOrder[]; expired: StagedOrder[] } {
  const live: StagedOrder[] = [];
  const expired: StagedOrder[] = [];
  for (const o of queue) (isExpiredOrder(o, now, ttlMs) ? expired : live).push(o);
  return { live, expired };
}

export interface ExecutionPlan {
  /**
   * 'validate' — never had a confirmed live fill: execute only
   * `orders[0]` (the smallest sell, or smallest order if no sells),
   * and require fill confirmation before the queue continues on the
   * next pass. 'normal' — run the whole queue, sells first.
   */
  mode: 'validate' | 'normal';
  /** Orders to attempt this run, in execution order. */
  orders: StagedOrder[];
  /** Orders to leave in the queue untouched this run. */
  deferred: StagedOrder[];
}

/**
 * Decide what this run should attempt.
 *
 * When `validated` is false the plan is a single smallest-value SELL
 * (falling back to the smallest order overall if the queue has no
 * sells — a buy can validate the pipe too, it just can't happen on a
 * cash account with no cash, which the cash gate enforces separately).
 */
export function planExecution(pending: StagedOrder[], validated: boolean): ExecutionPlan {
  const sells = pending.filter(o => o.action === 'SELL');
  const buys = pending.filter(o => o.action === 'BUY');

  if (!validated && pending.length > 0) {
    const pool = sells.length > 0 ? sells : buys;
    const probe = [...pool].sort((a, b) => a.estimatedValue - b.estimatedValue)[0];
    return {
      mode: 'validate',
      orders: [probe],
      // Exclude the probe by identity, NOT by position: the smallest-value
      // probe is frequently not queue index 0 (the strategist emits sells
      // loss-first, not cheapest-first), so `slice(1)` would drop the real
      // index-0 order AND re-queue the probe that just executed — a
      // duplicate order on a live account.
      deferred: pending.filter(o => o !== probe),
    };
  }

  return { mode: 'normal', orders: [...sells, ...buys], deferred: [] };
}

export interface CashGateResult {
  /** Buys that fit within available cash, in original queue order. */
  execute: StagedOrder[];
  /** Buys deferred to a later run for lack of cash. */
  deferred: StagedOrder[];
}

/**
 * Greedy cash gate for BUY orders. Walks the queue in order (the
 * strategist already emits buys largest-drift-first in greedy fill
 * mode) and admits each buy while its estimated cost — inflated by
 * `headroomPct` to absorb price drift since the estimate — fits in
 * the remaining cash. Skipped buys don't block later smaller ones:
 * a $3.4k TLT buy that misses by $100 shouldn't stop a $1.5k GLD
 * buy that fits.
 */
export function gateBuysByCash(
  buys: StagedOrder[],
  availableCashUsd: number,
  headroomPct: number,
): CashGateResult {
  const execute: StagedOrder[] = [];
  const deferred: StagedOrder[] = [];
  let remaining = availableCashUsd;
  const factor = 1 + headroomPct / 100;

  for (const buy of buys) {
    const cost = buy.estimatedValue * factor;
    if (cost <= remaining) {
      execute.push(buy);
      remaining -= cost;
    } else {
      deferred.push(buy);
    }
  }

  return { execute, deferred };
}
