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
// Load .env before anything reads process.env: this agent doesn't import
// ../config.js, so without this the new stream-health notify() would never see
// IBKR_FUND_ALERT_WEBHOOK. dotenv does not override injected env vars.
import 'dotenv/config';
import {
  reconcileCursor,
  reconcileMarketDataCursor,
  getEventsStatus,
} from '../observability/event-poller.js';
import type { EventsStatus, GapEvent, ObservedEvent } from '../observability/event-types.js';
import { loadState, mergeState, appendObservedEvents, type ObservedEventState } from '../state/store.js';
import { notify } from '../notify/slack.js';
import { storeHooks } from '../notify/store-hooks.js';
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
  // Only the NEW events for this poll. The history is no longer loaded, mutated
  // and rewritten to append to it — see appendObservedEvents in state/store.ts.
  const fresh: ObservedEventState[] = [];

  let totalEvents = 0;
  let gaps = 0;
  let errors = 0;

  for (const topic of STATIC_TOPICS) {
    const before = cursors[topic] ?? { cursor: 0, resetEpoch: 0 };
    try {
      const result = await reconcileCursor(topic as StaticTopic, before);
      cursors[topic] = result.newCursor;

      if (result.gap) {
        fresh.push(observedToState(result.gap));
        gaps += 1;
        log(
          `GAP topic=${topic} reason=${result.gap.payload.reason} ` +
            `prevEpoch=${before.resetEpoch} newEpoch=${result.gap.payload.newResetEpoch}`,
          AGENT,
        );
      }

      for (const evt of result.events) {
        fresh.push(observedToState(evt));
        totalEvents += 1;
        log(formatEvent(evt), AGENT);
      }
    } catch (err) {
      errors += 1;
      logError(`poll failed for topic ${topic}`, err, AGENT);
    }
  }

  // Two writes, deliberately: the cursors/timestamp are small and always change,
  // while the events are appended only when there are any. A poll that finds
  // nothing — the common case — now writes a few hundred bytes instead of 1.3MB.
  appendObservedEvents(fresh, OBSERVER_BUFFER_SIZE);
  mergeState({
    observerCursors: cursors,
    lastObserverAt: new Date().toISOString(),
  });

  await reportStreamHealth(gaps);

  log(
    `Observer poll complete — topics=${STATIC_TOPICS.length} events=${totalEvents} gaps=${gaps} errors=${errors}`,
    AGENT,
  );
  return { topicsPolled: STATIC_TOPICS.length, totalEvents, gaps, errors };
}

/**
 * Alert when the upstream event stream is unhealthy.
 *
 * Wires up getEventsStatus(), which had zero callers — the status endpoint was
 * implemented and then never asked. It matters because everything downstream
 * trusts this stream: execution-bot confirms fills from it, and risk-manager
 * derives intraday drawdown from it. A disconnected stream doesn't fail loudly;
 * it just quietly stops telling you things.
 *
 * Best-effort. getEventsStatus THROWS on a non-200 (event-poller.ts), and an
 * observability check must never be the reason a poll run fails.
 */
async function reportStreamHealth(gaps: number): Promise<void> {
  let status;
  try {
    status = await getEventsStatus();
  } catch (err) {
    logError('could not read event stream status (continuing)', err, AGENT);
    return;
  }

  const verdict = judgeStream(status, gaps);
  if (!verdict) return;

  await notify(
    {
      severity: 'warn',
      channel: verdict.channel,
      title: verdict.title,
      body: verdict.body,
      fields: [
        { label: 'Connected', value: String(status.connected) },
        { label: 'Orders subscription', value: status.subscriptions?.orders ?? 'unknown (old bezant)' },
        { label: 'Last message', value: status.lastMessageAt ?? 'never' },
        { label: 'Reconnects', value: String(status.reconnectCount) },
        ...(status.subscribeRefusals ? [{ label: 'Refusals', value: String(status.subscribeRefusals) }] : []),
        ...(gaps ? [{ label: 'Gaps this run', value: String(gaps) }] : []),
      ],
      agent: AGENT,
      // Coarse: reconnectCount and uptime change constantly, so fingerprinting
      // on them would alert every poll. This is one condition — "the stream is
      // unhealthy" — that re-nags on its ttl until it clears.
      dedupe: { key: 'observer:stream-health', fingerprint: verdict.reason },
    },
    storeHooks,
  );
}

/**
 * Is the stream telling us what we rely on it for? Pure, so the cases are
 * pinned in tests. Ranked: a socket that is up but whose `orders` subscription
 * CPAPI refused is the condition that lost fills in Sep 2026 — it looks
 * healthy on every older signal (connected, heartbeating, no gaps).
 */
export function judgeStream(
  status: Pick<EventsStatus, 'connected' | 'subscriptions'>,
  gaps: number,
): { reason: string; title: string; body: string; channel: 'slack' | 'ops' } | null {
  if (!status.connected) {
    return {
      reason: 'disconnected',
      channel: 'slack',
      title: 'Event stream DISCONNECTED from bezant',
      body: 'No live event feed. Fill confirmations and intraday drawdown enrichment are blind until it reconnects.',
    };
  }
  // Only an explicit refusal is evidence. `pending` is silence, and CPAPI is
  // silent on a subscribe it honoured when there are no orders to snapshot —
  // seen 2026-09-16 after a fresh login: pnl confirmed, sor said nothing,
  // nothing to be alarmed about until an order is placed and no event comes,
  // which the execution bot reports on its own.
  const orders = status.subscriptions?.orders;
  if (orders === 'refused') {
    return {
      reason: 'orders-refused',
      channel: 'slack',
      title: 'Order event stream not delivering — CPAPI refused the subscription',
      body:
        'The socket is up and heartbeating, but CPAPI is not sending order events on it, so no fill will arrive ' +
        'this way. bezant retries the subscription with backoff; until it takes, the execution bot confirms fills ' +
        'from IBKR executions instead (slower, and a second dependency).',
    };
  }
  if (gaps > 0) {
    // Record-only. A gap is what every reconnect leaves behind, and reconnects
    // are routine: IBKR closes the socket a few times a day and re-keys it
    // nightly, bezant is back in seconds, and fills no longer depend on the
    // stream. It belongs on the page as a fact, not on a phone as a task.
    return {
      reason: 'gaps',
      channel: 'ops',
      title: `Event stream gap — ${gaps} topic${gaps === 1 ? '' : 's'} lost continuity`,
      body:
        'The cursor jumped, so events between the old and new positions were never seen. Fill confirmation and ' +
        'intraday drawdown are both derived from this stream.',
    };
  }
  return null;
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
