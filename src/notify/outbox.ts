/**
 * The notify outbox — alerts that failed to reach Slack, retried until they do.
 *
 * notify() used to handle a failed send by releasing its dedupe claim, so the
 * NEXT run of the same agent would re-send. That works for a condition that
 * persists and an agent that runs again soon. It loses everything else: a
 * one-off event, an agent that runs daily, a condition that cleared before the
 * next run. And every retry wrote a second line to the ops feed.
 *
 * With NOTIFY_OUTBOX on, a failed send is persisted here instead, keyed on its
 * dedupe key, and the claim is kept. Four rules:
 *
 *   - Fails open. Nothing here throws; an outbox that cannot be written falls
 *     back to releasing the claim (notify/index.ts).
 *   - Never inside a trading transaction. The store functions each take their
 *     own short transaction, and notify() only ever runs between writes.
 *   - One drainer. Only the observer calls drainOutbox(), every 5 minutes; a
 *     compare-and-set lease stops two overlapping runs sending the same row.
 *   - Newest wins. A newer event under the same key replaces the queued one,
 *     and a delivered newer event deletes it.
 *
 * Delivery here goes straight to the transport, not through notify(): the feed
 * line and the claim were written when the event first happened.
 */
import { log, logError } from '../log.js';
import { feed } from './feed.js';
import { getNotifier, outboxEnabled, type NotifyEvent } from './index.js';
import type { OutboxRow } from '../state/store.js';

const AGENT = 'Alert';

/** The persistence the drainer needs — the real store in production, a fake in tests. */
export interface OutboxStore {
  due(now: number, limit: number): OutboxRow[];
  lease(row: OutboxRow, leaseUntil: number, now: number): boolean;
  reschedule(row: OutboxRow, nextAt: number, error: string): void;
  remove(key: string, createdAt: number): void;
}

export interface DrainOptions {
  now?: number;
  /** Deliver one event; resolves true when accepted. Defaults to the active notifier. */
  send?: (event: NotifyEvent) => Promise<boolean>;
  /** Give up on an event this old. Default 24h — past that it is history, not an alert. */
  maxAgeMs?: number;
  /** Rows per drain. Keeps one observer run bounded if Slack is down for a day. */
  batch?: number;
}

export interface DrainResult {
  delivered: number;
  retried: number;
  dropped: number;
}

const LEASE_MS = 10 * 60_000;
const BASE_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

/** Retry schedule after `attempts` failures: 5, 10, 20, 40, 60, 60… minutes. */
export function nextRetryDelay(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts), MAX_BACKOFF_MS);
}

/**
 * Deliver whatever is due. Never throws. A no-op when NOTIFY_OUTBOX is off —
 * the kill switch stops the drainer as well as the queueing, so switching it
 * off really does restore the old behaviour.
 */
export async function drainOutbox(store: OutboxStore, opts: DrainOptions = {}): Promise<DrainResult> {
  const result: DrainResult = { delivered: 0, retried: 0, dropped: 0 };
  if (!outboxEnabled()) return result;
  const now = opts.now ?? Date.now();
  const send = opts.send ?? ((e: NotifyEvent) => getNotifier().notify(e));
  const maxAge = opts.maxAgeMs ?? 24 * 60 * 60_000;

  let rows: OutboxRow[];
  try {
    rows = store.due(now, opts.batch ?? 20);
  } catch (err) {
    logError('outbox read failed — nothing drained this run', err, AGENT);
    return result;
  }

  for (const row of rows) {
    try {
      let event: NotifyEvent;
      try {
        event = JSON.parse(row.event) as NotifyEvent;
      } catch {
        store.remove(row.key, row.createdAt);
        result.dropped++;
        logError(`outbox row ${row.key} is unreadable — dropped`, '', AGENT);
        continue;
      }

      if (now - row.createdAt > maxAge) {
        store.remove(row.key, row.createdAt);
        result.dropped++;
        // Said on the page, because Slack is the thing that did not work.
        feed({
          severity: 'warn',
          title: `Alert never reached Slack: ${event.title}`,
          body: `Gave up after ${row.attempts} retries over ${Math.round((now - row.createdAt) / 3_600_000)}h` +
            (row.lastError ? ` — last error: ${row.lastError}` : ''),
          agent: event.agent ?? 'fund',
        });
        continue;
      }

      if (!store.lease(row, now + LEASE_MS, now)) continue; // superseded or taken

      let ok = false;
      let why = 'not accepted';
      try {
        ok = await send(event);
      } catch (err) {
        why = (err as Error)?.message ?? String(err);
      }
      if (ok) {
        store.remove(row.key, row.createdAt);
        result.delivered++;
        log(`outbox: delivered "${event.title}" after ${row.attempts + 1} retr${row.attempts ? 'ies' : 'y'}`, AGENT);
      } else {
        store.reschedule(row, now + nextRetryDelay(row.attempts), why);
        result.retried++;
      }
    } catch (err) {
      logError(`outbox: row ${row.key} failed to process`, err, AGENT);
    }
  }
  return result;
}
