/**
 * Market-data helpers backed by observer-agent state.
 *
 * The observer agent (when extended in P2.1) polls
 * `/events/marketdata?conid=…` for held conids and persists frames into
 * `state.observedEvents`. These helpers let downstream code prefer
 * those near-real-time prices over snapshot polling, with a freshness
 * threshold so stale entries fall back gracefully.
 */
import type { ObservedEvent } from './event-types.js';
import type { ObservedEventState } from '../state/store.js';

export interface PriceFromEvents {
  price: number;
  /** ISO 8601 timestamp from bezant-server's clock. */
  lastUpdate: string;
  /** How old the price is in milliseconds, computed against `now()`. */
  ageMs: number;
  source: 'ws';
  conid: number;
}

interface RawMarketDataPayload {
  '31'?: string | number;
  conid?: number | string;
  // Sometimes wrapped: { args: [{31: '...', conid: 123}] }
  args?: RawMarketDataPayload[];
}

export interface LatestPriceOpts {
  /** Override `Date.now()` (for tests). */
  now?: () => number;
  /** Max age before we ignore the entry. Defaults to 30s. */
  maxAgeMs?: number;
}

/**
 * Walk the observed-events ring backwards to find the most recent
 * market-data tick for `conid`. Returns `null` if none found in-window.
 */
export function getLatestPriceFromEvents(
  events: Array<ObservedEvent | ObservedEventState>,
  conid: number,
  opts: LatestPriceOpts = {},
): PriceFromEvents | null {
  const { now = () => Date.now(), maxAgeMs = 30_000 } = opts;
  const target = `marketdata:${conid}`;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const evt = events[i];
    if (evt.topic !== target) continue;
    const px = extractLastPrice(evt.payload as RawMarketDataPayload);
    if (!Number.isFinite(px)) continue;
    const ts = Date.parse(evt.receivedAt);
    if (!Number.isFinite(ts)) continue;
    const age = now() - ts;
    if (age > maxAgeMs) return null;
    return {
      price: px,
      lastUpdate: evt.receivedAt,
      ageMs: age,
      source: 'ws',
      conid,
    };
  }
  return null;
}

function extractLastPrice(payload: RawMarketDataPayload | undefined): number {
  if (!payload) return NaN;
  if (Array.isArray(payload.args)) {
    for (const inner of payload.args) {
      const p = extractLastPrice(inner);
      if (Number.isFinite(p)) return p;
    }
  }
  const raw = payload['31'];
  if (raw == null) return NaN;
  if (typeof raw === 'number') return raw;
  // Strip CPAPI status flag prefix ('C', 'H', 'L') — see
  // gateway.ts::parseSnapshotPrice for the full rationale.
  const m = String(raw).match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

/**
 * Build a `Map<conid, PriceFromEvents>` from a buffer + the requested
 * conid list. Useful when an agent wants to enrich a batch of REST
 * snapshot calls with WS-fresh prices.
 */
export function buildPriceMapFromEvents(
  events: Array<ObservedEvent | ObservedEventState>,
  conids: number[],
  opts: LatestPriceOpts = {},
): Map<number, PriceFromEvents> {
  const out = new Map<number, PriceFromEvents>();
  for (const conid of conids) {
    const p = getLatestPriceFromEvents(events, conid, opts);
    if (p) out.set(conid, p);
  }
  return out;
}
