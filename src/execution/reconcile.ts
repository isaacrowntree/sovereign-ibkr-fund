/**
 * Reconcile the local trade ledger against IBKR's authoritative executions.
 *
 * The WS event stream can miss a fill (a reconnect, a timeout-then-fill race),
 * in which case the shares move at IBKR but no TradeRecord is written — FIFO
 * cost basis, realised P&L and wash-sale windows then silently diverge. This
 * pure function returns the executions that are NOT yet in the ledger, which
 * the caller appends.
 *
 * ## The grain mismatch
 *
 * The two sides count differently, and getting this wrong INFLATES the ledger:
 *
 * - **The ledger is per-ORDER.** The executor calls recordFilledTrade once per
 *   order with `conf.totalFilledQty`, writing a single aggregate record — and
 *   with no execId, because CPAPI's WS order frames don't carry one (see
 *   fill-confirmer's RawOrderEvent).
 * - **IBKR is per-EXECUTION.** An order that filled 30 + 30 + 40 comes back as
 *   three rows, each with its own execId.
 *
 * Comparing an aggregate against individual rows by
 * `orderId+action+symbol+qty` never matches (`…:100` vs `…:30`), so every
 * partial used to be backfilled on top of the aggregate: 100 real shares became
 * 200. A single-fill order reconciles fine, which is why that hid.
 *
 * A third case has no identifiers at all: a fill reconciled from broker
 * POSITIONS, or repaired from the daily trade report, which publishes neither
 * an order id nor an execution id. Those are credited by symbol+side+trade
 * date instead — see `dayCredit` below.
 *
 * So an aggregate record acts as CREDIT against the executions of its order:
 * each execution is charged to the credit in time order, and only what the
 * credit can't cover is genuinely missing. Idempotent: an execution already
 * recorded (by execId, or covered by an aggregate) is skipped.
 */
import type { TradeRecord } from '../state/store.js';
import type { Execution } from '../connection/gateway.js';

/** Identity of an order's fills. Side and symbol included so one order's credit can't cover another's. */
function orderKey(orderId: number | undefined | null, action: string, symbol: string): string {
  return `${orderId}:${action}:${symbol}`;
}

/**
 * Identity for a fill we know happened but hold no broker identifiers for.
 *
 * The trade date is the only anchor left, so it is part of the key: without it
 * one backfilled record would silently absorb an unrelated fill of the same
 * symbol and side months later.
 */
function dayKey(timestamp: string, action: string, symbol: string): string {
  return `${(timestamp || '').slice(0, 10)}:${action}:${symbol}`;
}

export function reconcileExecutions(
  history: TradeRecord[],
  executions: Execution[],
): TradeRecord[] {
  const seenExecIds = new Set(history.map(t => t.execId).filter(Boolean) as string[]);

  // Credit per order, from records the executor wrote WITHOUT an execId — i.e.
  // per-order aggregates. Records that DO carry an execId are already matched
  // 1:1 above, so counting them here would credit the same shares twice.
  const credit = new Map<string, number>();
  for (const t of history) {
    if (t.execId) continue;
    if (t.orderId == null) continue;
    const k = orderKey(t.orderId, t.action, t.symbol);
    credit.set(k, (credit.get(k) ?? 0) + t.qty);
  }

  // Second credit ledger, for fills recorded with NO broker identifiers at all.
  //
  // orphan-recovery (reconciled from positions) and a repair from the daily
  // trade report both write real fills that IBKR never gave us an order id or
  // an execution id for — the statement publishes neither. Such a record can
  // be matched by neither route above, so when /iserver/account/trades later
  // starts serving that day the same fill would be backfilled a SECOND time,
  // doubling the shares and corrupting cost basis.
  //
  // Deliberately built only from records with neither identifier. A record
  // carrying a real execId is already matched 1:1 by it, and letting it also
  // fund this pool would leave credit lying around for an unrelated fill of
  // the same symbol and day to consume — losing a real execution instead of
  // duplicating one.
  const dayCredit = new Map<string, number>();
  for (const t of history) {
    if (t.execId) continue;
    if (t.orderId) continue; // 0 / null / undefined — no usable order id
    const k = dayKey(t.timestamp, t.action, t.symbol);
    dayCredit.set(k, (dayCredit.get(k) ?? 0) + t.qty);
  }

  // Time order matters: an aggregate reflects a point-in-time snapshot, so it
  // covers the EARLIEST executions. A partial that landed after that snapshot
  // is the genuinely-missing one.
  const ordered = [...executions].sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));

  const out: TradeRecord[] = [];
  for (const e of ordered) {
    if (e.execId && seenExecIds.has(e.execId)) continue;

    const k = orderKey(e.orderId, e.action, e.symbol);
    const available = credit.get(k) ?? 0;
    if (available >= e.qty) {
      // Already accounted for by the executor's aggregate.
      credit.set(k, available - e.qty);
      continue;
    }
    // Partial credit (available > 0 but < e.qty) can't happen when the
    // aggregate is the exact sum of its executions, which is how the executor
    // builds it. If it ever does, record the fill rather than drop it: a
    // reconcile that loses a fill defeats its own purpose.

    // Fall back to the identifier-less pool: same symbol, same side, same day.
    // Pooled rather than exact-quantity so one recorded aggregate still covers
    // an execution IBKR reports as several partials.
    const dk = dayKey(e.time ?? '', e.action, e.symbol);
    const dayAvailable = dayCredit.get(dk) ?? 0;
    if (dayAvailable >= e.qty) {
      dayCredit.set(dk, dayAvailable - e.qty);
      continue;
    }

    out.push({
      timestamp: e.time || new Date().toISOString(),
      symbol: e.symbol,
      action: e.action,
      qty: e.qty,
      estimatedValue: e.qty * e.price,
      fillPrice: e.price,
      orderId: e.orderId ?? 0,
      status: 'filled',
      reason: 'reconciled_from_ibkr',
      execId: e.execId,
    });
    if (e.execId) seenExecIds.add(e.execId);
  }
  return out;
}
