/**
 * Wire types for the bezant-server `/events/*` HTTP surface.
 *
 * The bezant-server side captures CPAPI WebSocket frames into ring
 * buffers and exposes them via cursor-paginated REST. Cursors are
 * monotonic per `(topic, resetEpoch)`. The reset epoch bumps on every
 * upstream WS reconnect or process restart — a change in epoch is the
 * signal that a `gap` happened and the consumer should emit a synthetic
 * gap marker into its own observed-events stream.
 */

/** Built-in topic names. Market data uses `marketdata:<conid>`. */
export type EventTopic =
  | 'orders'
  | 'pnl'
  | 'gap'
  | `marketdata:${number}`;

/**
 * One event as returned by `GET /events/{topic}`. Payload shape varies
 * by topic — for `orders` the bezant-client `WsOrderUpdate*` types
 * apply, for `pnl` the `WsPnl*` types, for `marketdata:<conid>` the raw
 * CPAPI snapshot fields keyed by their numeric codes.
 */
export interface ObservedEvent<T = unknown> {
  /** Server-assigned monotonic cursor within `(topic, resetEpoch)`. */
  cursor: number;
  /** Topic name — same as the path segment, with the conid suffix on market data. */
  topic: EventTopic | string;
  /** RFC 3339 timestamp at which bezant-server enqueued this event. */
  receivedAt: string;
  /** Bumps on each WS reconnect or process restart. */
  resetEpoch: number;
  /** The decoded JSON frame from CPAPI, or for `gap` the synthetic marker payload. */
  payload: T;
}

/** Successful read response. Empty `events` only on first poll of a fresh topic. */
export interface EventsOk<T = unknown> {
  kind: 'ok';
  events: ObservedEvent<T>[];
  nextCursor: number;
  resetEpoch: number;
}

/** Caller's cursor was older than the ring buffer's head — emit a gap. */
export interface CursorExpired {
  kind: 'cursor_expired';
  headCursor: number;
  resetEpoch: number;
}

/** No new events since the caller's cursor. */
export interface NoNewEvents {
  kind: 'empty';
  cursor: number;
}

/** All possible outcomes of a single `pollTopic` call. */
export type PollResult<T = unknown> = EventsOk<T> | CursorExpired | NoNewEvents;

/**
 * Synthetic event the observer agent emits when it detects a gap (the
 * reset epoch advanced or the server returned 412). Shape matches a
 * regular ObservedEvent for downstream consistency.
 */
export interface GapEvent extends ObservedEvent<GapPayload> {
  topic: 'gap';
}

/** Why the gap was emitted. */
export interface GapPayload {
  reason: 'reset_epoch_changed' | 'cursor_expired' | 'first_poll';
  previousResetEpoch?: number;
  previousCursor?: number;
  newResetEpoch: number;
  detectedAt: string;
}

/** Per-topic cursor + reset_epoch the observer agent persists in state. */
export interface ObserverCursor {
  cursor: number;
  resetEpoch: number;
  lastPolledAt?: string;
}

/** `GET /events/_status` response shape. */
export interface EventsStatus {
  connected: boolean;
  lastMessageAt?: string;
  reconnectCount: number;
  uptimeSeconds: number;
  resetEpoch: number;
  topicsSubscribed: string[];
  bufferSizes: Record<string, number>;
}
