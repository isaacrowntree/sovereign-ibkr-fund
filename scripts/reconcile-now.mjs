#!/usr/bin/env node
/**
 * Manual ledger reconciliation: record any IBKR execution the ledger is
 * missing (e.g. a fill the WS stream missed). Runs in the container against
 * the deployed dist. Safe to re-run.
 *
 * This used to carry its own matching loop, keyed on execId alone. That was a
 * second, weaker copy of `reconcileExecutions()`: it could not see the
 * executor's per-ORDER aggregate records (which carry no execId), so every
 * partial fill of an order the executor had already recorded was appended on
 * top of it — 100 real shares became 200. It also stamped each backfill with
 * the time the script ran rather than when the fill happened, which moves the
 * trade into the wrong day (and, near 30 June, the wrong financial year).
 *
 * Now it is only I/O around the same pure function execution-bot uses, so the
 * two can never disagree about what is already recorded. Timestamps are IBKR's
 * own execution time (`e.time`), which reconcileExecutions() stamps.
 *
 * Cost basis is not written here. The tax report derives every sale's basis
 * from the ledger's lots at report time; a figure frozen onto the sell record
 * (the old avgCost fallback) was only ever an estimate, and a wrong one when a
 * position had several lots.
 */
import { getExecutions, connect, disconnect } from '../dist/connection/gateway.js';
import { reconcileExecutions } from '../dist/execution/reconcile.js';
import { loadTradeHistory, appendTrade, loadState, mergeState, closeDb } from '../dist/state/store.js';

await connect();
const execs = await getExecutions();

const before = loadTradeHistory().length;
const backfill = reconcileExecutions(loadTradeHistory(), execs);
// appendTrade is itself idempotent (execId / order signature), so a concurrent
// execution-bot reconcile cannot make this double-record either.
for (const t of backfill) appendTrade(t);
const after = loadTradeHistory().length;

console.log(`Reconciled ${after - before} execution(s) into the ledger (${backfill.length} candidate(s)):`);
for (const r of backfill) {
  console.log(`  ${r.timestamp} ${r.action} ${r.qty} ${r.symbol} @ $${r.fillPrice} | execId ${r.execId}`);
}

// A live fill occurred, so validation is genuinely proven.
if (after > before && !loadState().liveExecutionValidatedAt) {
  mergeState({ liveExecutionValidatedAt: new Date().toISOString(), lastValidationFailure: null });
  console.log('Set liveExecutionValidatedAt (a live fill was confirmed against IBKR).');
}

console.log(`trade-history now has ${after} record(s).`);
closeDb();
disconnect();
