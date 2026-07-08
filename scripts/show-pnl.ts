#!/usr/bin/env -S npx tsx
/**
 * Pretty-print PnL trajectory from observed WS events.
 *
 * Reads state.observedEvents (or remote /events/pnl/history with --remote),
 * computes session peak/trough/drawdown given the local fund's last
 * known NAV, and prints a tabular view.
 *
 * Usage:
 *   pnpm tsx scripts/show-pnl.ts
 *   pnpm tsx scripts/show-pnl.ts --since 2026-05-06T13:00:00Z
 *   pnpm tsx scripts/show-pnl.ts --remote --since 2026-05-06T13:00:00Z
 */
import { config } from '../src/config.js';
import { computeIntradayDrawdownFromEvents } from '../src/observability/intraday-pnl.js';
import { loadState, type ObservedEventState } from '../src/state/store.js';

async function fromHistory(sinceTs: string): Promise<ObservedEventState[]> {
  const url = `${config.bezant.url.replace(/\/$/, '')}/events/pnl/history?since_ts=${encodeURIComponent(sinceTs)}&limit=5000`;
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
  const sinceTs = since ?? new Date(Date.now() - 8 * 3600 * 1000).toISOString();

  const state = loadState();
  const lastNav = (state.lastNav as number | undefined)
    ?? ((state.lastSnapshot as { netLiquidation?: number } | undefined)?.netLiquidation)
    ?? NaN;

  let events: ObservedEventState[];
  if (remote) {
    events = await fromHistory(sinceTs);
  } else {
    events = ((state.observedEvents as ObservedEventState[] | undefined) ?? []).filter(
      (e) => e.topic === 'pnl' && e.receivedAt >= sinceTs,
    );
  }

  if (events.length === 0) {
    console.log(`(no pnl events since ${sinceTs})`);
    return;
  }

  if (Number.isFinite(lastNav)) {
    const dd = computeIntradayDrawdownFromEvents(
      events.map((e) => ({
        cursor: e.cursor,
        topic: e.topic,
        receivedAt: e.receivedAt,
        resetEpoch: e.resetEpoch,
        payload: e.payload as Record<string, unknown>,
      })),
      lastNav,
    );
    console.log(
      `NAV anchor: $${lastNav.toFixed(2)}\n` +
        `Peak:       $${dd.peakNav.toFixed(2)}\n` +
        `Trough:     $${dd.troughNav.toFixed(2)}\n` +
        `Drawdown:   ${dd.drawdownPct.toFixed(3)}% over ${dd.samples} samples\n`,
    );
  } else {
    console.log('(no NAV anchor in state — drawdown not computed)\n');
  }

  // Print last 30 events as a table.
  const recent = events.slice(-30);
  console.log(`Last ${recent.length} pnl frames:`);
  for (const e of recent) {
    const p = e.payload as Record<string, unknown>;
    const u = p.upnl ?? p.unrealized ?? p.unrealizedUsd ?? '';
    const r = p.rpnl ?? p.realized ?? p.realizedUsd ?? '';
    console.log(`  ${e.receivedAt}  upnl=${u}  rpnl=${r}`);
  }
  console.log();
  console.log(`${events.length} total pnl events since ${sinceTs}${remote ? ' (remote)' : ' (local state)'}`);
}

main().catch((err) => {
  console.error('show-pnl failed:', err);
  process.exit(1);
});
