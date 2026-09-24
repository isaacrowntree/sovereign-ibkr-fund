#!/usr/bin/env node
/**
 * One-way ledger migration: opening lots from IBKR, IBKR trade dates and AUD
 * rates on every trade, brokerage where missing — then zero the accepted
 * drift baseline, all in ONE transaction.
 *
 * Everything is fetched from IBKR at run time (POST /pa/transactions, one
 * conid per call, ~1 s apart). No holdings data lives in this repo.
 *
 *   node scripts/seed-opening-lots.mjs --dry-run          # plan + verification, writes nothing
 *   node scripts/seed-opening-lots.mjs                    # write, if and only if it verifies
 *   node scripts/seed-opening-lots.mjs --include-post-ledger
 *        also write IBKR trades from after the ledger began that it lacks
 *
 * It refuses to write when the ledger it would produce does not imply
 * exactly IBKR's positions, when any sale would still lack a parcel, when an
 * execution run holds the lock, or when the ledger changed while it was
 * planning. Idempotent: a second run finds its own opening lots (keyed
 * conid:date:qty:price) and patches nothing.
 *
 * Run it with execution PAUSED and a fresh backup — see the runbook in the
 * commit that added this script.
 */
import { connect, disconnect, getAccountSummary, getExecutions, resolveConid } from '../dist/connection/gateway.js';
import { fetchPaHistory } from '../dist/connection/ibkr-history.js';
import { planLedgerMigration } from '../dist/ledger/migration.js';
import { loadTradeRows, loadState, applyLedgerMigration, closeDb } from '../dist/state/store.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const INCLUDE_POST = args.includes('--include-post-ledger');
const DELAY_MS = parseInt(process.env.PA_DELAY_MS || '1000', 10);
const RUN_LOCK_FRESH_MS = 20 * 60 * 1000;

const fail = (msg) => { console.error(`REFUSING: ${msg}`); closeDb(); process.exit(1); };

await connect();

const state = loadState();
const lock = state.executionRunLock;
if (!DRY && lock?.at && Date.now() - new Date(lock.at).getTime() < RUN_LOCK_FRESH_MS) {
  fail(`an execution run holds the lock (since ${lock.at}). Pause execution and wait for it to finish.`);
}

const rows = loadTradeRows();
const expect = { count: rows.length, maxId: rows.reduce((m, r) => Math.max(m, r.id), 0) };

const summary = await getAccountSummary();
const positions = summary.positions.filter((p) => (p.qty ?? 0) !== 0);
if (positions.length === 0 && rows.length > 0) {
  fail('IBKR reported no positions while the ledger has trades — the broker answer is not trustworthy right now.');
}

// Every held and every ledgered symbol needs its history.
const symbolByConid = new Map();
for (const p of positions) {
  if (!p.conid) fail(`position ${p.symbol} has no conid`);
  symbolByConid.set(Number(p.conid), p.symbol);
}
const held = new Set(positions.map((p) => p.symbol));
for (const s of new Set(rows.map((r) => r.trade.symbol))) {
  if (held.has(s)) continue;
  const known = rows.find((r) => r.trade.symbol === s && r.trade.conid)?.trade.conid;
  symbolByConid.set(Number(known ?? (await resolveConid(s))), s);
}

console.log(`Fetching IBKR history for ${symbolByConid.size} contract(s), ${DELAY_MS} ms apart...`);
const history = await fetchPaHistory([...symbolByConid.keys()], { days: 2000, delayMs: DELAY_MS });

let executions = [];
try { executions = await getExecutions(); } catch (e) { console.log(`(no session executions: ${e.message} — brokerage will be estimated)`); }

const plan = planLedgerMigration({
  ledger: rows,
  positions: positions.map((p) => ({ symbol: p.symbol, conid: p.conid, qty: p.qty, avgCost: p.avgCost })),
  history,
  symbolByConid,
  executions,
  includePostLedger: INCLUDE_POST,
});

console.log(`\nOpening lots to write: ${plan.opening.length}`);
for (const t of plan.opening) {
  console.log(`  ${t.tradeDate} ${t.action.padEnd(4)} ${String(t.qty).padStart(8)} ${t.symbol.padEnd(7)} @ ${t.fillPrice}  ` +
    `AUD/USD ${t.audPerUsd}  brokerage ~${t.commission}`);
}
if (plan.postLedger.length) {
  console.log(`\nIBKR trades after the ledger began, missing from it: ${plan.postLedger.length}${INCLUDE_POST ? ' (will be written)' : ''}`);
  for (const t of plan.postLedger) console.log(`  ${t.tradeDate} ${t.action} ${t.qty} ${t.symbol} @ ${t.fillPrice}`);
}
console.log(`\nLedger rows to annotate: ${plan.patches.length}`);
for (const p of plan.patches) console.log(`  #${p.id} ${p.symbol}: ${p.why.join('; ')}`);

console.log('\nPositions   ledger now   ledger after   IBKR');
for (const p of plan.positions) {
  const mark = Math.abs(p.ledgerAfter - p.broker) > 1e-6 ? '   <-- MISMATCH' : '';
  console.log(`  ${p.symbol.padEnd(8)} ${String(p.ledgerBefore).padStart(10)} ${String(p.ledgerAfter).padStart(14)} ${String(p.broker).padStart(8)}${mark}`);
}
if (plan.warnings.length) {
  console.log('\nWarnings:');
  for (const w of plan.warnings) console.log(`  - ${w}`);
}

if (!plan.ok) {
  console.error('\nThe migrated ledger would NOT match IBKR:');
  for (const r of plan.refusals) console.error(`  - ${r}`);
  fail('nothing written.');
}

console.log(`\nVerified: the migrated ledger implies exactly IBKR's positions. Drift baseline will be zeroed.`);
if (DRY) {
  console.log('Dry run — nothing written.');
  closeDb();
  disconnect();
  process.exit(0);
}

const at = new Date().toISOString();
applyLedgerMigration({
  expect,
  insert: [...plan.opening, ...(INCLUDE_POST ? plan.postLedger : [])],
  patches: plan.patches.map((p) => ({ id: p.id, set: p.set, unset: p.unset })),
  // The pre-ledger history is now IN the ledger, so the accepted difference is
  // nothing. Both keys: leaving the rolling signature at the old drift would
  // make the reconciler report the change as a critical "drift changed".
  state: { ledgerDriftBaseline: '', ledgerDriftSignature: '', ledgerMigratedAt: at },
});
console.log(`Written in one transaction at ${at}: ${plan.opening.length} opening lot(s), ` +
  `${INCLUDE_POST ? plan.postLedger.length : 0} backfill(s), ${plan.patches.length} annotation(s); drift baseline zeroed.`);
closeDb();
disconnect();
