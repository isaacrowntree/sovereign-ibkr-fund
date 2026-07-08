/**
 * Compute intraday drawdown from a sequence of WS PnL events. Used by
 * risk-manager to enrich the REST-snapshot drawdown with sub-tick
 * resolution (snapshots can miss intraday peaks/troughs that happen
 * between agent runs).
 */
import type { ObservedEvent } from './event-types.js';

interface RawPnlPayload {
  // CPAPI's WS PnL frames vary; we look for any of these field shapes.
  upnl?: number | string;
  unrealized?: number | string;
  unrealizedUsd?: number | string;
  unrealizedPnl?: number | string;
  rpnl?: number | string;
  realized?: number | string;
  realizedUsd?: number | string;
  // Sometimes wrapped per-account: { args: { ACCID: { upnl: ... } } }
  args?: Record<string, RawPnlPayload>;
}

export interface IntradayDrawdown {
  /** Highest equity (sessionStartNav + unrealized + realized) observed. */
  peakNav: number;
  /** Lowest equity observed at or after the peak. */
  troughNav: number;
  /** `(peak - trough) / peak` × 100. `0` if peak <= 0. */
  drawdownPct: number;
  /** Number of PnL samples actually used. Out-of-window/parse-failed events drop. */
  samples: number;
}

export interface IntradayDrawdownOpts {
  /** Filter events strictly newer than this RFC 3339 timestamp. */
  sessionStartedAt?: string;
  /** Filter events strictly older than this RFC 3339 timestamp. */
  sessionEndsAt?: string;
}

/**
 * Compute intraday drawdown from a list of PnL events. Pure function.
 *
 * `sessionStartNav` is the NAV at the start of the trading window
 * (typically what the strategist last observed via REST). Each PnL
 * event contributes `unrealized + realized` to derive the current
 * equity at that timestamp.
 */
export function computeIntradayDrawdownFromEvents(
  events: ObservedEvent<RawPnlPayload>[],
  sessionStartNav: number,
  opts: IntradayDrawdownOpts = {},
): IntradayDrawdown {
  if (!Number.isFinite(sessionStartNav) || sessionStartNav <= 0) {
    return { peakNav: 0, troughNav: 0, drawdownPct: 0, samples: 0 };
  }

  const startMs = opts.sessionStartedAt ? Date.parse(opts.sessionStartedAt) : Number.NEGATIVE_INFINITY;
  const endMs = opts.sessionEndsAt ? Date.parse(opts.sessionEndsAt) : Number.POSITIVE_INFINITY;

  let peak = sessionStartNav;
  let trough = sessionStartNav;
  let samples = 0;

  for (const evt of events) {
    if (evt.topic !== 'pnl') continue;
    const ts = Date.parse(evt.receivedAt);
    if (!Number.isFinite(ts)) continue;
    if (ts < startMs || ts > endMs) continue;

    const totals = extractPnl(evt.payload);
    if (!Number.isFinite(totals.unrealized) && !Number.isFinite(totals.realized)) continue;

    const equity = sessionStartNav + (Number.isFinite(totals.unrealized) ? totals.unrealized : 0)
      + (Number.isFinite(totals.realized) ? totals.realized : 0);

    if (samples === 0) {
      peak = equity;
      trough = equity;
    } else {
      if (equity > peak) {
        peak = equity;
        trough = equity;
      } else if (equity < trough) {
        trough = equity;
      }
    }
    samples += 1;
  }

  if (samples === 0) {
    return { peakNav: sessionStartNav, troughNav: sessionStartNav, drawdownPct: 0, samples: 0 };
  }
  const drawdownPct = peak > 0 ? ((peak - trough) / peak) * 100 : 0;
  return { peakNav: peak, troughNav: trough, drawdownPct, samples };
}

function extractPnl(p: RawPnlPayload | undefined): {
  unrealized: number;
  realized: number;
} {
  if (!p) return { unrealized: NaN, realized: NaN };
  // Handle the per-account-wrapped shape — sum over all accounts.
  if (p.args && typeof p.args === 'object') {
    let u = 0;
    let r = 0;
    let any = false;
    for (const acc of Object.values(p.args)) {
      const sub = extractPnl(acc as RawPnlPayload);
      if (Number.isFinite(sub.unrealized)) {
        u += sub.unrealized;
        any = true;
      }
      if (Number.isFinite(sub.realized)) {
        r += sub.realized;
        any = true;
      }
    }
    return any ? { unrealized: u, realized: r } : { unrealized: NaN, realized: NaN };
  }
  const u = pickNumber(p.upnl ?? p.unrealized ?? p.unrealizedUsd ?? p.unrealizedPnl);
  const r = pickNumber(p.rpnl ?? p.realized ?? p.realizedUsd);
  return { unrealized: u, realized: r };
}

function pickNumber(v: number | string | undefined): number {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : NaN;
}
