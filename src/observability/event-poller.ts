/**
 * HTTP poller for bezant-server `/events/*` endpoints.
 *
 * Handles the four wire outcomes:
 * - **200**  → typed events array + advanced cursor
 * - **204**  → caller is caught up; no body, cursor stays put
 * - **412**  → caller's cursor is older than ring buffer head — gap
 * - **503**  → events disabled or connector down — surface as error
 *
 * `reconcileCursor` wraps `pollTopic` with the gap-detection logic the
 * observer agent depends on: any change in `resetEpoch` produces a
 * synthetic gap marker, and a 412 cursor-expired forces a resync to
 * the buffer head.
 */

import { config } from '../config.js';
import type {
  CursorExpired,
  EventsOk,
  EventsStatus,
  GapEvent,
  NoNewEvents,
  ObservedEvent,
  ObserverCursor,
  PollResult,
} from './event-types.js';

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

interface PollerOptions {
  /** Override `fetch` (used in tests). */
  fetcher?: FetchLike;
  /** Override config.bezant.url (used in tests). */
  baseUrl?: string;
  /** Override timeout (ms). Defaults to config.bezant.timeoutMs. */
  timeoutMs?: number;
}

function cfHeaders(): Record<string, string> {
  const { cfAccessClientId, cfAccessClientSecret } = config.bezant;
  if (!cfAccessClientId || !cfAccessClientSecret) return {};
  return {
    'CF-Access-Client-Id': cfAccessClientId,
    'CF-Access-Client-Secret': cfAccessClientSecret,
  };
}

/** Lower-level fetch that surfaces typed events outcomes (200/204/412). */
async function eventsFetch<T>(
  path: string,
  opts: PollerOptions = {},
): Promise<{ status: number; body?: T }> {
  const baseUrl = (opts.baseUrl ?? config.bezant.url).replace(/\/$/, '');
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? config.bezant.timeoutMs;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetcher(`${baseUrl}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...cfHeaders() },
      signal: controller.signal,
    });
    if (resp.status === 204) return { status: 204 };
    const text = await resp.text();
    const body: T | undefined = text ? (JSON.parse(text) as T) : undefined;
    return { status: resp.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll a single topic. Topic is the path segment after `/events/`
 * (`orders`, `pnl`, `gap`) — for market data use `pollMarketDataTopic`
 * instead, since it requires the `?conid=` query.
 */
export async function pollTopic<T = unknown>(
  topic: 'orders' | 'pnl' | 'gap',
  since: number,
  limit = 500,
  opts: PollerOptions = {},
): Promise<PollResult<T>> {
  const path = `/events/${topic}?since=${encodeURIComponent(String(since))}&limit=${limit}`;
  return parseEventsResponse<T>(await eventsFetch<RawEventsBody<T>>(path, opts), since);
}

/**
 * Poll a market-data topic (per-conid). The first poll for a conid
 * lazily subscribes the upstream WS to that conid's L1 feed.
 */
export async function pollMarketDataTopic<T = unknown>(
  conid: number,
  since: number,
  limit = 500,
  opts: PollerOptions = {},
): Promise<PollResult<T>> {
  const path =
    `/events/marketdata?conid=${encodeURIComponent(String(conid))}` +
    `&since=${encodeURIComponent(String(since))}&limit=${limit}`;
  return parseEventsResponse<T>(await eventsFetch<RawEventsBody<T>>(path, opts), since);
}

/** `GET /events/_status` → typed status object. */
export async function getEventsStatus(opts: PollerOptions = {}): Promise<EventsStatus> {
  const result = await eventsFetch<RawStatus>('/events/_status', opts);
  if (result.status !== 200 || !result.body) {
    throw new Error(`events status returned ${result.status}`);
  }
  return statusFromRaw(result.body);
}

interface RawEventsBody<T> {
  events?: Array<{
    cursor: number;
    topic: string;
    received_at: string;
    reset_epoch: number;
    payload: T;
  }>;
  next_cursor?: number;
  reset_epoch?: number;
  /** 412 body. */
  code?: string;
  head_cursor?: number;
  message?: string;
}

interface RawStatus {
  connected: boolean;
  last_message_at?: string;
  reconnect_count: number;
  uptime_seconds: number;
  reset_epoch: number;
  topics_subscribed: string[];
  buffer_sizes: Record<string, number>;
}

function parseEventsResponse<T>(
  res: { status: number; body?: RawEventsBody<T> },
  since: number,
): PollResult<T> {
  if (res.status === 204) {
    return { kind: 'empty', cursor: since } satisfies NoNewEvents;
  }
  if (res.status === 412 && res.body?.code === 'cursor_expired') {
    return {
      kind: 'cursor_expired',
      headCursor: res.body.head_cursor ?? 0,
      resetEpoch: res.body.reset_epoch ?? 0,
    } satisfies CursorExpired;
  }
  if (res.status === 503) {
    throw new Error('bezant-server events capture is disabled (503)');
  }
  if (res.status !== 200 || !res.body) {
    throw new Error(`events poll returned ${res.status}`);
  }
  const events = (res.body.events ?? []).map<ObservedEvent<T>>((e) => ({
    cursor: e.cursor,
    topic: e.topic,
    receivedAt: e.received_at,
    resetEpoch: e.reset_epoch,
    payload: e.payload,
  }));
  return {
    kind: 'ok',
    events,
    nextCursor: res.body.next_cursor ?? since,
    resetEpoch: res.body.reset_epoch ?? 0,
  } satisfies EventsOk<T>;
}

function statusFromRaw(r: RawStatus): EventsStatus {
  return {
    connected: r.connected,
    lastMessageAt: r.last_message_at,
    reconnectCount: r.reconnect_count,
    uptimeSeconds: r.uptime_seconds,
    resetEpoch: r.reset_epoch,
    topicsSubscribed: r.topics_subscribed ?? [],
    bufferSizes: r.buffer_sizes ?? {},
  };
}

/**
 * Drive a single reconcile pass: poll the topic, advance the cursor,
 * detect gaps. Returns the events to append plus the new cursor state.
 */
export async function reconcileCursor<T = unknown>(
  topic: 'orders' | 'pnl' | 'gap',
  state: ObserverCursor,
  opts: { limit?: number } & PollerOptions = {},
): Promise<{
  events: ObservedEvent<T>[];
  gap?: GapEvent;
  newCursor: ObserverCursor;
}> {
  const { limit = 500, ...poller } = opts;
  const result = await pollTopic<T>(topic, state.cursor, limit, poller);
  return reconcileFromResult<T>(state, result);
}

/**
 * Same as `reconcileCursor` for the market-data path. Required because
 * the path/query shape differs.
 */
export async function reconcileMarketDataCursor<T = unknown>(
  conid: number,
  state: ObserverCursor,
  opts: { limit?: number } & PollerOptions = {},
): Promise<{
  events: ObservedEvent<T>[];
  gap?: GapEvent;
  newCursor: ObserverCursor;
}> {
  const { limit = 500, ...poller } = opts;
  const result = await pollMarketDataTopic<T>(conid, state.cursor, limit, poller);
  return reconcileFromResult<T>(state, result);
}

/**
 * Pure function — extracted from reconcileCursor so the gap-detection
 * branches can be unit-tested without a fetch mock. Drives the state
 * machine: cursor advances, epoch changes, expirations.
 */
export function reconcileFromResult<T = unknown>(
  state: ObserverCursor,
  result: PollResult<T>,
): {
  events: ObservedEvent<T>[];
  gap?: GapEvent;
  newCursor: ObserverCursor;
} {
  const now = new Date().toISOString();

  if (result.kind === 'empty') {
    return {
      events: [],
      newCursor: { ...state, cursor: result.cursor, lastPolledAt: now },
    };
  }

  if (result.kind === 'cursor_expired') {
    const gap: GapEvent = {
      cursor: state.cursor,
      topic: 'gap',
      receivedAt: now,
      resetEpoch: result.resetEpoch,
      payload: {
        reason: 'cursor_expired',
        previousResetEpoch: state.resetEpoch,
        previousCursor: state.cursor,
        newResetEpoch: result.resetEpoch,
        detectedAt: now,
      },
    };
    return {
      events: [],
      gap,
      newCursor: {
        cursor: Math.max(0, result.headCursor - 1),
        resetEpoch: result.resetEpoch,
        lastPolledAt: now,
      },
    };
  }

  // result.kind === 'ok'
  const epochChanged = state.resetEpoch !== 0 && state.resetEpoch !== result.resetEpoch;
  const isFirstPoll = state.resetEpoch === 0 && state.cursor === 0;

  let gap: GapEvent | undefined;
  if (epochChanged) {
    gap = {
      cursor: state.cursor,
      topic: 'gap',
      receivedAt: now,
      resetEpoch: result.resetEpoch,
      payload: {
        reason: 'reset_epoch_changed',
        previousResetEpoch: state.resetEpoch,
        previousCursor: state.cursor,
        newResetEpoch: result.resetEpoch,
        detectedAt: now,
      },
    };
  } else if (isFirstPoll && result.events.length > 0) {
    // First-time observer — no gap; the events are simply "all we know".
    gap = undefined;
  }

  return {
    events: result.events,
    gap,
    newCursor: {
      cursor: result.nextCursor,
      resetEpoch: result.resetEpoch,
      lastPolledAt: now,
    },
  };
}
