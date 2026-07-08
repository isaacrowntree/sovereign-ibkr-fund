/**
 * Reconcile the local trade ledger against IBKR's authoritative executions.
 *
 * The WS event stream can miss a fill (a reconnect, a timeout-then-fill race),
 * in which case the shares move at IBKR but no TradeRecord is written — FIFO
 * cost basis, realised P&L and wash-sale windows then silently diverge. This
 * pure function returns the executions that are NOT yet in the ledger, which
 * the caller appends. Idempotent: an execution already recorded (by execId, or
 * matched to an existing record by orderId+symbol+side+qty) is skipped.
 */
import type { TradeRecord } from '../state/store.js';
import type { Execution } from '../connection/gateway.js';

export function reconcileExecutions(
  history: TradeRecord[],
  executions: Execution[],
): TradeRecord[] {
  const seenExecIds = new Set(history.map(t => t.execId).filter(Boolean) as string[]);
  // Fallback key for records written before execIds were captured, so a fill
  // the executor already recorded (no execId) isn't backfilled a second time.
  const seenLegacy = new Set(
    history.map(t => `${t.orderId}:${t.action}:${t.symbol}:${t.qty}`),
  );

  const out: TradeRecord[] = [];
  for (const e of executions) {
    if (e.execId && seenExecIds.has(e.execId)) continue;
    if (e.orderId != null && seenLegacy.has(`${e.orderId}:${e.action}:${e.symbol}:${e.qty}`)) continue;
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
