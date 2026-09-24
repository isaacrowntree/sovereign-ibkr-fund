#!/usr/bin/env node
/**
 * Unit NAV index maintenance (2026-09-24 review, F6). Nothing here runs by
 * itself: risk-manager only COLLECTS post-close samples; building history from
 * the legacy series and recording capital flows are operator steps.
 *
 *   node scripts/unit-nav.mjs show
 *   node scripts/unit-nav.mjs migrate [--fx fx-audusd.json] [--confirm]
 *   node scripts/unit-nav.mjs add-flow --date YYYY-MM-DD --aud 5000 [--note "..."] [--confirm]
 *
 * Read-only unless --confirm. The state DB is STATE_DIR/bot-state.db (same as
 * the agents).
 *
 * migrate: copies navHistory/navHistoryDates to navHistory_legacy /
 *   navHistoryDates_legacy (once) and backfills navSamples from the dated
 *   legacy points. Idempotent: a second run adds nothing. --fx takes a
 *   { "YYYY-MM-DD": AUD per USD } file (src/validation/fetch-data.ts
 *   FETCH_EXTRAS=1 writes one from public data) so the USD index — the one
 *   the ladder uses — has history too; without it the USD index starts at the
 *   next post-close sample. RUN IT with execution paused, after a DB backup,
 *   and read the dry run first (plan ground rules).
 *
 * add-flow: records an AUD deposit (+) or withdrawal (−). Only AUD cash moving
 *   in or out of the account is a flow — never an AUD→USD conversion, never a
 *   dividend. The id is date:amount unless --id is given, so recording the
 *   same flow twice is a no-op. Historical flows must be entered before
 *   RISK_NAV_SOURCE=units is switched on, or the index will read them as
 *   performance.
 */
import { readFileSync } from 'node:fs';
import { loadState, mergeState } from '../dist/state/store.js';
import { buildUnitIndex, migrateToUnitNav } from '../dist/risk/unit-nav.js';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1] ?? null; };
const CONFIRM = args.includes('--confirm');

function fxLookup(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const dates = Object.keys(raw).sort();
  return (date) => {
    let best = null;
    for (const d of dates) { if (d <= date) best = raw[d]; else break; }
    return best;
  };
}

function show(state) {
  const samples = state.navSamples ?? [];
  const flows = state.capitalFlows ?? [];
  const idx = buildUnitIndex(samples, flows);
  const last = idx.points[idx.points.length - 1];
  console.log(`samples: ${samples.length} (${samples[0]?.date ?? '-'} → ${samples[samples.length - 1]?.date ?? '-'})`);
  console.log(`flows:   ${flows.length}${flows.length ? ` (${flows.map(f => `${f.date} ${f.amountAud > 0 ? '+' : ''}${f.amountAud}`).join(', ')})` : ''}`);
  console.log(`legacy preserved: ${Array.isArray(state.navHistory_legacy)}`);
  if (last) {
    console.log(`unit price AUD ${last.unitPriceAud.toFixed(4)}, USD ${last.unitPriceUsd?.toFixed(4) ?? 'n/a'} at ${last.date}`);
  }
  for (const p of idx.problems) console.log(`problem: ${p}`);
  if (idx.flowsBeforeStart.length) console.log(`flows before the first sample (inside the starting NAV): ${idx.flowsBeforeStart.length}`);
}

const state = loadState();
if (cmd === 'show') {
  show(state);
} else if (cmd === 'migrate') {
  const fxPath = flag('--fx');
  const m = migrateToUnitNav(state, fxPath ? fxLookup(fxPath) : undefined);
  console.log(JSON.stringify(m.summary, null, 2));
  if (!CONFIRM) {
    console.log('\nDry run. Re-run with --confirm to write.');
  } else {
    mergeState(m.updates);
    console.log('\nWritten.');
    show(loadState());
  }
} else if (cmd === 'add-flow') {
  const date = flag('--date');
  const aud = parseFloat(flag('--aud') ?? '');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(aud) || aud === 0) {
    console.error('add-flow needs --date YYYY-MM-DD and a non-zero --aud');
    process.exit(2);
  }
  const flow = { id: flag('--id') ?? `${date}:${aud}`, date, amountAud: aud, note: flag('--note') ?? undefined };
  const flows = state.capitalFlows ?? [];
  if (flows.some(f => f.id === flow.id)) {
    console.log(`flow ${flow.id} already recorded — nothing to do`);
    process.exit(0);
  }
  console.log(`would record ${JSON.stringify(flow)}`);
  if (CONFIRM) {
    mergeState({ capitalFlows: [...flows, flow] });
    console.log('Written.');
    show(loadState());
  } else {
    console.log('Dry run. Re-run with --confirm to write.');
  }
} else {
  console.error('usage: unit-nav.mjs show | migrate [--fx file] [--confirm] | add-flow --date D --aud N [--note s] [--id s] [--confirm]');
  process.exit(2);
}
