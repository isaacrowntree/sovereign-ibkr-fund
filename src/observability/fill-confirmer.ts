/**
 * Fill confirmer: poll bezant-server's `/events/orders` until we know
 * an order's terminal state (filled / partial-with-no-more-coming /
 * rejected / cancelled), or a timeout elapses.
 *
 * Used by execution-bot in place of "trust the synchronous order
 * submission response" — that response only tells us the order was
 * accepted, not what actually filled.
 */
import { pollTopic } from './event-poller.js';
import type { ObservedEvent } from './event-types.js';

export type FillStatus = 'filled' | 'partial' | 'rejected' | 'cancelled' | 'pending';

export interface FillConfirmation {
  orderId: number;
  status: FillStatus;
  totalFilledQty: number;
  /** Average fill price across all fills. NaN if no fills observed. */
  avgFillPrice: number;
  /** Quantity that wasn't filled. `targetQty - totalFilledQty`. */
  remainingQty: number;
  /** All raw events seen while waiting. */
  events: ObservedEvent<RawOrderEvent>[];
  /** True if the timeout elapsed before reaching a terminal state. */
  timedOut: boolean;
}

interface RawOrderEvent {
  orderId?: number | string;
  order_id?: number | string;
  orderID?: number | string;
  status?: string;
  orderStatus?: string;
  cumFill?: number | string;
  filledQuantity?: number | string;
  avgPrice?: number | string;
  lastFillPrice?: number | string;
  totalSize?: number | string;
  size?: number | string;
  // CPAPI's WS order frames sometimes wrap a list: { args: [...] }
  args?: RawOrderEvent[];
}

export interface ConfirmFillOpts {
  /** Total quantity submitted (used to compute remainingQty). */
  targetQty: number;
  /** Hard deadline. Default 60s. */
  timeoutMs?: number;
  /** How often to poll while waiting. Default 1s. */
  pollIntervalMs?: number;
  /** Resume from this cursor (so we don't fetch events older than the order). */
  fromCursor?: number;
  /** Override pollTopic (for tests). */
  pollFn?: typeof pollTopic;
  /** Override the wall clock (for tests). */
  now?: () => number;
  /** Override sleep (for tests — short-circuit). */
  sleepFn?: (ms: number) => Promise<void>;
}

// A cancel is terminal only once it is CONFIRMED cancelled. `PendingCancel`
// (CPAPI's in-flight cancel-request state) is deliberately NOT here: the
// order can still fill before the cancel lands, so we keep polling until a
// real terminal state or the timeout. (The old snake_case `pending_cancel`
// entry never matched CPAPI's camelCase `PendingCancel` anyway — it was dead
// and, had it matched, would have reported a live order as terminal.)
// NOTE: 'inactive' is deliberately NOT terminal. Every CPAPI order STARTS in
// 'Inactive' (pending-submit, pre-confirmation) before it fills — treating it
// as terminal made confirmFill bail at the first event and report a phantom
// cancel on orders that then filled. A genuinely dead order just times out,
// which the executor reconciles against executions.
const TERMINAL_STATUSES = new Set([
  'filled',
  'rejected',
  'cancelled',
  'cancelled_by_system',
]);

/**
 * Wait for a terminal state on the given orderId. Polls
 * `/events/orders` until either a Filled/Rejected/Cancelled status is
 * seen for that orderId, or the timeout elapses.
 *
 * Returns the best-known state at exit. `timedOut=true` indicates the
 * timeout fired before a terminal status; the caller should treat the
 * result as "as far as we know" — a `partial` with `timedOut=true`
 * means there could still be more fills we didn't see.
 */
export async function confirmFill(
  orderId: number,
  opts: ConfirmFillOpts,
): Promise<FillConfirmation> {
  const {
    targetQty,
    timeoutMs = 60_000,
    pollIntervalMs = 1_000,
    fromCursor = 0,
    pollFn = pollTopic,
    now = () => Date.now(),
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = opts;

  const start = now();
  let cursor = fromCursor;
  const collected: ObservedEvent<RawOrderEvent>[] = [];
  let lastStatus: FillStatus = 'pending';
  let lastFilledQty = 0;
  let lastAvgPrice = NaN;

  while (now() - start < timeoutMs) {
    const result = await pollFn<RawOrderEvent>('orders', cursor, 500);
    if (result.kind === 'cursor_expired') {
      // Catastrophic: server's ring overflowed. Reset to head; we may
      // have missed the order's events entirely.
      cursor = Math.max(0, result.headCursor - 1);
    } else if (result.kind === 'ok') {
      cursor = result.nextCursor;
      for (const evt of result.events) {
        // Some frames are wrapped in `args: [...]`; flatten.
        const inner = unwrapArgs(evt.payload);
        for (const o of inner) {
          if (!matchesOrder(o, orderId)) continue;
          collected.push(evt);
          const status = pickStatus(o);
          const filled = pickNumber(o.cumFill ?? o.filledQuantity);
          const px = pickNumber(o.avgPrice ?? o.lastFillPrice);
          if (filled > lastFilledQty) {
            lastFilledQty = filled;
            if (Number.isFinite(px)) lastAvgPrice = px;
          }
          if (status) lastStatus = mapStatus(status, lastFilledQty, targetQty);
          if (status && TERMINAL_STATUSES.has(status.toLowerCase())) {
            return finalize(
              orderId,
              targetQty,
              lastStatus,
              lastFilledQty,
              lastAvgPrice,
              collected,
              false,
            );
          }
        }
      }
    }
    // result.kind === 'empty' just means no new events; sleep + retry.
    if (now() - start + pollIntervalMs >= timeoutMs) break;
    await sleepFn(pollIntervalMs);
  }

  return finalize(
    orderId,
    targetQty,
    lastStatus,
    lastFilledQty,
    lastAvgPrice,
    collected,
    true,
  );
}

function finalize(
  orderId: number,
  targetQty: number,
  lastStatus: FillStatus,
  filled: number,
  avg: number,
  events: ObservedEvent<RawOrderEvent>[],
  timedOut: boolean,
): FillConfirmation {
  // If we've seen full fills but no terminal status, treat as filled.
  let status = lastStatus;
  if (filled >= targetQty && targetQty > 0) status = 'filled';
  else if (filled > 0 && status === 'pending') status = 'partial';
  // Never report 'filled' with zero observed fills: a bare 'Filled' status
  // frame carrying no cumFill would otherwise let the caller record a phantom
  // full-quantity trade. With no shares seen, downgrade to 'pending' so the
  // caller treats it as unconfirmed rather than complete.
  if (status === 'filled' && filled <= 0) status = 'pending';
  return {
    orderId,
    status,
    totalFilledQty: filled,
    avgFillPrice: avg,
    remainingQty: Math.max(0, targetQty - filled),
    events,
    timedOut,
  };
}

function unwrapArgs(payload: RawOrderEvent | undefined): RawOrderEvent[] {
  if (!payload) return [];
  if (Array.isArray(payload.args)) return payload.args;
  return [payload];
}

function matchesOrder(p: RawOrderEvent, orderId: number): boolean {
  const id = pickNumber(p.orderId ?? p.order_id ?? p.orderID);
  return id === orderId;
}

function pickStatus(p: RawOrderEvent): string | undefined {
  return p.status ?? p.orderStatus;
}

function pickNumber(v: number | string | undefined): number {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : NaN;
}

function mapStatus(raw: string, filled: number, target: number): FillStatus {
  const s = raw.toLowerCase();
  if (s === 'filled') return 'filled';
  if (s === 'rejected') return 'rejected';
  if (s.startsWith('cancel')) return 'cancelled';
  if (filled > 0 && filled < target) return 'partial';
  return 'pending';
}
