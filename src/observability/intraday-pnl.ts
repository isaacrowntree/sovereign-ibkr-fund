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

// ─────────────────────────────────────────────────────────────────────────────
// `nl`-based intraday drawdown (2026-09-24 review, C′3)
//
// The reconstruction above is wrong three ways on the real stream:
//   1. It looks for `upnl`/`rpnl`, but CPAPI's spl frames carry `upl`/`dpl`/`nl`
//      — so on real frames it finds nothing and reports zero samples.
//   2. Even when fed, `sessionStartNav + unrealized + realized` double counts:
//      unrealized P&L is cumulative since each lot was bought, not since the
//      session opened, and the caller passes the all-time high-water mark as
//      the "session start" NAV.
//   3. It resets the trough at every new peak and reports only the LAST
//      peak-to-trough, so a 10% dip followed by a small new high reads as ~0.
//
// `nl` is the account's net liquidation in base currency, so no reconstruction
// is needed: the equity curve IS the series. What remains is filtering (a frame
// without `nl`, or with `nl` = 0 — IBKR sends partial and zeroed updates — is
// not a sample) and measuring the worst peak-to-subsequent-trough move.
// ─────────────────────────────────────────────────────────────────────────────

interface NlRow { nl?: number | string }

export interface NlIntradayDrawdown {
  /** Worst peak-to-subsequent-trough fall within the window, in %. */
  drawdownPct: number;
  /** The peak that worst fall was measured from. */
  peakNav: number;
  /** The trough of that worst fall. */
  troughNav: number;
  /** Highest and lowest `nl` seen in the window. */
  sessionHigh: number;
  sessionLow: number;
  /** Most recent `nl` in the window. */
  lastNav: number;
  samples: number;
  /** Frames in the window that carried no usable `nl` (partial or zeroed updates). */
  ignored: number;
}

/**
 * Net liquidation from one spl frame. Accepts the CPAPI frame
 * (`{topic:'spl', args:{'<acct>.Core': {...}}}`), the REST-style
 * `{upnl: {'<acct>.Core': {...}}}`, or a bare row. Several account rows are
 * summed. Missing, non-numeric or non-positive → NaN (not a sample).
 */
export function extractNl(payload: unknown): number {
  if (!payload || typeof payload !== 'object') return NaN;
  const p = payload as Record<string, unknown>;
  const rows: NlRow[] = [];
  const container = (p.args ?? p.upnl) as Record<string, unknown> | undefined;
  if (container && typeof container === 'object') {
    for (const v of Object.values(container)) if (v && typeof v === 'object') rows.push(v as NlRow);
  } else {
    rows.push(p as NlRow);
  }
  let total = 0;
  let any = false;
  for (const r of rows) {
    const v = pickNumber(r.nl as number | string | undefined);
    if (Number.isFinite(v) && v > 0) {
      total += v;
      any = true;
    }
  }
  return any ? total : NaN;
}

/** Pure. Events outside [startMs, endMs] and frames without a usable `nl` are skipped. */
export function computeIntradayDrawdownFromNl(
  events: ReadonlyArray<ObservedEvent<unknown>>,
  window: { start: Date; end: Date },
): NlIntradayDrawdown {
  const startMs = window.start.getTime();
  const endMs = window.end.getTime();
  const inWindow = events
    .filter(e => e.topic === 'pnl')
    .map(e => ({ e, ts: Date.parse(e.receivedAt) }))
    .filter(x => Number.isFinite(x.ts) && x.ts >= startMs && x.ts <= endMs)
    .sort((a, b) => a.ts - b.ts);

  let samples = 0;
  let ignored = 0;
  let runningPeak = 0;
  let worst = 0;
  let worstPeak = 0;
  let worstTrough = 0;
  let high = 0;
  let low = Infinity;
  let last = 0;
  for (const { e } of inWindow) {
    const nl = extractNl(e.payload);
    if (!Number.isFinite(nl)) { ignored++; continue; }
    samples++;
    last = nl;
    high = Math.max(high, nl);
    low = Math.min(low, nl);
    runningPeak = Math.max(runningPeak, nl);
    const dd = (runningPeak - nl) / runningPeak;
    if (dd > worst) {
      worst = dd;
      worstPeak = runningPeak;
      worstTrough = nl;
    }
  }
  if (samples === 0) {
    return { drawdownPct: 0, peakNav: 0, troughNav: 0, sessionHigh: 0, sessionLow: 0, lastNav: 0, samples: 0, ignored };
  }
  return {
    drawdownPct: worst * 100,
    peakNav: worst > 0 ? worstPeak : high,
    troughNav: worst > 0 ? worstTrough : high,
    sessionHigh: high,
    sessionLow: low,
    lastNav: last,
    samples,
    ignored,
  };
}
