/**
 * Observability Agent
 *
 * Polls bezant-server's `/events/{topic}` endpoints, advances a
 * persistent per-topic cursor, and appends new events to a capped ring
 * in `state.observedEvents`.
 *
 * **No strategy decisions are made here.** This agent is forensic: it
 * captures every order/PnL event the upstream WS saw, regardless of
 * whether other agents were running at the time. Downstream code
 * (execution-bot's fill confirmer, risk-manager's intraday DD) reads
 * `state.observedEvents` to enrich their own logic.
 */
import {
  reconcileCursor,
  reconcileMarketDataCursor,
} from '../observability/event-poller.js';
import type { GapEvent, ObservedEvent } from '../observability/event-types.js';
import { loadState, mergeState, type ObservedEventState } from '../state/store.js';
import { log, logError } from '../log.js';

const AGENT = 'Observer';

/** Topics polled on every run. Market data is polled per-conid only when
 *  the strategist holds the symbol (P2 wires this); P0 only does
 *  orders + pnl + gap. */
const STATIC_TOPICS = ['orders', 'pnl', 'gap'] as const;
type StaticTopic = (typeof STATIC_TOPICS)[number];

const OBSERVER_BUFFER_SIZE = parseInt(
  process.env.OBSERVER_BUFFER_SIZE || '5000',
  10,
);

/** Disable knob — set `OBSERVER_ENABLED=0` to no-op the agent. */
const OBSERVER_ENABLED = (process.env.OBSERVER_ENABLED ?? '1') !== '0';

interface RunResult {
  topicsPolled: number;
  totalEvents: number;
  gaps: number;
  errors: number;
}

async function run(): Promise<RunResult> {
  if (!OBSERVER_ENABLED) {
    log('OBSERVER_ENABLED=0 — skipping', AGENT);
    return { topicsPolled: 0, totalEvents: 0, gaps: 0, errors: 0 };
  }

  log('Observer poll starting', AGENT);
  const state = loadState();
  const cursors = (state.observerCursors as Record<string, { cursor: number; resetEpoch: number; lastPolledAt?: string }>) ?? {};
  const buffer = (state.observedEvents as ObservedEventState[]) ?? [];

  let totalEvents = 0;
  let gaps = 0;
  let errors = 0;

  for (const topic of STATIC_TOPICS) {
    const before = cursors[topic] ?? { cursor: 0, resetEpoch: 0 };
    try {
      const result = await reconcileCursor(topic as StaticTopic, before);
      cursors[topic] = result.newCursor;

      if (result.gap) {
        appendToBuffer(buffer, observedToState(result.gap));
        gaps += 1;
        log(
          `GAP topic=${topic} reason=${result.gap.payload.reason} ` +
            `prevEpoch=${before.resetEpoch} newEpoch=${result.gap.payload.newResetEpoch}`,
          AGENT,
        );
      }

      for (const evt of result.events) {
        appendToBuffer(buffer, observedToState(evt));
        totalEvents += 1;
        log(formatEvent(evt), AGENT);
      }
    } catch (err) {
      errors += 1;
      logError(`poll failed for topic ${topic}`, err, AGENT);
    }
  }

  // Cap the ring.
  while (buffer.length > OBSERVER_BUFFER_SIZE) {
    buffer.shift();
  }

  mergeState({
    observerCursors: cursors,
    observedEvents: buffer,
    lastObserverAt: new Date().toISOString(),
  });

  log(
    `Observer poll complete — topics=${STATIC_TOPICS.length} events=${totalEvents} gaps=${gaps} errors=${errors}`,
    AGENT,
  );
  return { topicsPolled: STATIC_TOPICS.length, totalEvents, gaps, errors };
}

/** Convert a wire `ObservedEvent` to the persistent state shape. */
export function observedToState<T = unknown>(evt: ObservedEvent<T>): ObservedEventState {
  return {
    cursor: evt.cursor,
    topic: evt.topic,
    receivedAt: evt.receivedAt,
    resetEpoch: evt.resetEpoch,
    payload: evt.payload,
    observedAt: new Date().toISOString(),
  };
}

/** Append + enforce cap. Exported for tests. */
export function appendToBuffer(
  buffer: ObservedEventState[],
  evt: ObservedEventState,
  cap: number = OBSERVER_BUFFER_SIZE,
): void {
  buffer.push(evt);
  while (buffer.length > cap) {
    buffer.shift();
  }
}

/** One-line human-readable formatter for events. Used in log lines. */
export function formatEvent<T>(evt: ObservedEvent<T>): string {
  const p = evt.payload as any;
  if (evt.topic === 'orders' && p) {
    const orderId = p.orderId ?? p.order_id ?? p.orderID ?? '?';
    const status = p.status ?? p.orderStatus ?? '?';
    const symbol = p.ticker ?? p.symbol ?? '';
    const side = p.side ?? p.action ?? '';
    const qty = p.totalSize ?? p.size ?? p.quantity ?? '';
    const filled = p.cumFill ?? p.filledQuantity ?? '';
    const px = p.avgPrice ?? p.lastFillPrice ?? p.price ?? '';
    const pieces = [
      `ORDER`,
      `orderId=${orderId}`,
      symbol && `symbol=${symbol}`,
      side && `side=${side}`,
      qty !== '' && `qty=${qty}`,
      filled !== '' && `filled=${filled}`,
      px !== '' && `px=${px}`,
      `status=${status}`,
    ].filter(Boolean);
    return pieces.join(' ');
  }
  if (evt.topic === 'pnl' && p) {
    const u = p.unrealized ?? p.unrealizedUsd ?? p.upnl ?? '';
    const r = p.realized ?? p.realizedUsd ?? '';
    const pieces = [`PNL`, u !== '' && `unrealized=${u}`, r !== '' && `realized=${r}`].filter(Boolean);
    return pieces.join(' ');
  }
  if (evt.topic === 'gap') {
    return `GAP ${JSON.stringify(p)}`;
  }
  if (typeof evt.topic === 'string' && evt.topic.startsWith('marketdata:')) {
    const last = p?.['31'] ?? p?.last ?? '';
    return `MD ${evt.topic} last=${last}`;
  }
  return `${evt.topic} ${JSON.stringify(p).slice(0, 200)}`;
}

if (process.argv.includes('--once')) {
  run()
    .then((r) => {
      log(`done: ${JSON.stringify(r)}`, AGENT);
      process.exit(r.errors > 0 ? 1 : 0);
    })
    .catch((err) => {
      logError('Fatal', err, AGENT);
      process.exit(2);
    });
}

// Exported for tests.
export { run, OBSERVER_BUFFER_SIZE, OBSERVER_ENABLED, STATIC_TOPICS };
// Silence the lint: market-data path is wired in P2 but the helper is
// available to callers (e.g. the marketdata-stream module) right now.
export { reconcileMarketDataCursor };
