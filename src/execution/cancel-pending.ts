/**
 * Resolve the cancels earlier runs asked for.
 *
 * A DELETE on an order is a request. It can fail outright, or be accepted and
 * then lose the race with a fill, and the run that sent it has usually moved
 * on (or halted) by the time the answer would be known. So every cancel is
 * written to state `cancelPending` as it is sent, and the next run checks each
 * one against the live orders:
 *
 *   - gone from the live orders, or in a dead state → resolved, dropped;
 *   - still working → the cancel is sent again and the entry kept;
 *   - live orders unreadable → nothing is concluded, everything kept.
 *
 * An entry still working on a later run is surfaced as `stuck`, which the
 * caller alerts on: an order we meant to kill is still able to fill.
 *
 * Pure orchestration over injected I/O, like the executor.
 */
import type { CancelRequest } from './executor.js';
import { isWorkingOrder, DEFAULT_INACTIVE_WORKING_MS } from './order-status.js';

export interface CancelPendingDeps {
  getLiveOrders(): Promise<Array<{ orderId: number; status: string; ageMs?: number }>>;
  cancelOrder(orderId: number): Promise<void>;
  log(message: string): void;
  logError(message: string, err: unknown): void;
}

export interface CancelPendingResult {
  /** Entries still unresolved — persist these back. */
  pending: CancelRequest[];
  /** Entries whose order is no longer working. */
  resolved: CancelRequest[];
  /** Entries whose order is still working despite the earlier cancel. */
  stuck: CancelRequest[];
  /** False when the live orders could not be read (nothing was concluded). */
  checked: boolean;
}

export async function resolveCancelPending(
  pending: CancelRequest[],
  deps: CancelPendingDeps,
  inactiveMaxMs: number = DEFAULT_INACTIVE_WORKING_MS,
): Promise<CancelPendingResult> {
  if (pending.length === 0) return { pending: [], resolved: [], stuck: [], checked: true };

  let live: Awaited<ReturnType<CancelPendingDeps['getLiveOrders']>>;
  try {
    live = await deps.getLiveOrders();
  } catch (e) {
    deps.logError('cancelPending: live orders unreadable — keeping every pending cancel', e);
    return { pending, resolved: [], stuck: [], checked: false };
  }

  const byId = new Map(live.map((o) => [o.orderId, o]));
  const still: CancelRequest[] = [];
  const resolved: CancelRequest[] = [];
  const stuck: CancelRequest[] = [];

  for (const req of pending) {
    const lo = byId.get(req.orderId);
    if (!lo || !isWorkingOrder(lo.status, lo.ageMs, inactiveMaxMs)) {
      deps.log(`cancelPending: orderId=${req.orderId} (${req.symbol}) is no longer working (${lo?.status ?? 'gone'}) — resolved`);
      resolved.push(req);
      continue;
    }
    stuck.push(req);
    let requestOk = false;
    try {
      await deps.cancelOrder(req.orderId);
      requestOk = true;
      deps.log(`cancelPending: orderId=${req.orderId} (${req.symbol}) still ${lo.status} — cancel re-sent`);
    } catch (e) {
      deps.logError(`cancelPending: re-sending cancel for orderId=${req.orderId} failed`, e);
    }
    still.push({ ...req, requestOk });
  }

  return { pending: still, resolved, stuck, checked: true };
}
