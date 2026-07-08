#!/usr/bin/env -S npx tsx
/**
 * Pretty-print recent order fills from the observer agent's buffer.
 *
 * Sources tried in order:
 *  1. `state.observedEvents` ring (last 5000 events the observer has
 *     captured during the lifetime of the state file)
 *  2. `/events/orders/history?since_ts=…` on bezant-server (if sqlite
 *     persistence is enabled)
 *
 * Usage:
 *   pnpm tsx scripts/show-fills.ts                # last 24h from local state
 *   pnpm tsx scripts/show-fills.ts --since 2026-05-01
 *   pnpm tsx scripts/show-fills.ts --remote --since 2026-05-01
 */
import { config } from '../src/config.js';
import { loadState, type ObservedEventState } from '../src/state/store.js';

interface RawOrderEvt {
  orderId?: number | string;
  status?: string;
  ticker?: string;
  symbol?: string;
  side?: string;
  cumFill?: number | string;
  totalSize?: number | string;
  avgPrice?: number | string;
  args?: RawOrderEvt[];
}

function unwrap(p: RawOrderEvt | undefined): RawOrderEvt[] {
  if (!p) return [];
  if (Array.isArray(p.args)) return p.args;
  return [p];
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function fmtRow(evt: ObservedEventState): string[] | null {
  const inner = unwrap(evt.payload as RawOrderEvt);
  if (inner.length === 0) return null;
  const o = inner[0];
  const orderId = String(o.orderId ?? '?');
  const sym = String(o.ticker ?? o.symbol ?? '');
  const side = String(o.side ?? '');
  const status = String(o.status ?? '');
  const filled = num(o.cumFill);
  const total = num(o.totalSize);
  const avg = num(o.avgPrice);
  return [
    evt.receivedAt,
    orderId,
    sym,
    side,
    Number.isFinite(filled) && Number.isFinite(total) ? `${filled}/${total}` : '?',
    Number.isFinite(avg) ? `$${avg.toFixed(2)}` : '?',
    status,
  ];
}

async function fromHistory(sinceTs: string): Promise<ObservedEventState[]> {
  const url = `${config.bezant.url.replace(/\/$/, '')}/events/orders/history?since_ts=${encodeURIComponent(sinceTs)}&limit=5000`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.bezant.cfAccessClientId) headers['CF-Access-Client-Id'] = config.bezant.cfAccessClientId;
  if (config.bezant.cfAccessClientSecret) headers['CF-Access-Client-Secret'] = config.bezant.cfAccessClientSecret;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(`history fetch failed: ${resp.status} ${await resp.text()}`);
  }
  const body = (await resp.json()) as {
    events: Array<{
      cursor: number;
      topic: string;
      received_at: string;
      reset_epoch: number;
      payload: unknown;
    }>;
  };
  return body.events.map((e) => ({
    cursor: e.cursor,
    topic: e.topic,
    receivedAt: e.received_at,
    resetEpoch: e.reset_epoch,
    payload: e.payload,
    observedAt: e.received_at,
  }));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let since: string | undefined;
  let remote = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--since') since = argv[i + 1];
    if (argv[i] === '--remote') remote = true;
  }
  const sinceTs = since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  let events: ObservedEventState[];
  if (remote) {
    events = await fromHistory(sinceTs);
  } else {
    const state = loadState();
    events = ((state.observedEvents as ObservedEventState[] | undefined) ?? []).filter(
      (e) => e.topic === 'orders' && e.receivedAt >= sinceTs,
    );
  }

  if (events.length === 0) {
    console.log(`(no order events since ${sinceTs})`);
    return;
  }

  const rows = events.map(fmtRow).filter((r): r is string[] => r !== null);
  const headers = ['Timestamp', 'OrderId', 'Symbol', 'Side', 'Filled', 'AvgPx', 'Status'];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(fmt(r));
  console.log();
  console.log(`${rows.length} fill events since ${sinceTs}${remote ? ' (remote)' : ' (local state)'}`);
}

main().catch((err) => {
  console.error('show-fills failed:', err);
  process.exit(1);
});
