#!/usr/bin/env node
/**
 * One command for the deposit sequence: check -> snapshot -> stage -> execute
 * -> reconcile.
 *
 * Read-only by default. `--confirm` is the single human gate; everything after
 * it is mechanical. The decision logic is src/execution/deposit-readiness.ts
 * (unit-tested) and src/portfolio/deposit-plan.ts — this file is I/O only.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *   FX. An AUD deposit lands in the AUD ledger bucket and funds no USD buy
 *   (cash account, no borrowing). Converting is a real, irreversible trade on
 *   a CASH-type contract, and the gateway's order path resolves STK contracts
 *   only — so it is reported as a blocker with the fix, not performed. Do it in
 *   IBKR.
 *
 *   The model reweight. `local.ts` must be compiled and pushed from the
 *   workstation (this host is `.prebuilt` and cannot build), so that stays a
 *   deploy step, after the fills reconcile.
 *
 *   Usage:
 *     node scripts/deposit-autopilot.mjs --targets <f.json> [--directed A,B]
 *          [--min-deploy-usd N] [--refresh] [--confirm]
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { planDepositBuy } from '../dist/portfolio/deposit-plan.js';
import { evaluateReadiness } from '../dist/execution/deposit-readiness.js';
import { isExecutionWindow } from '../dist/strategy/market-hours.js';
import { getUsdBalances, getMarketPrices } from '../dist/connection/gateway.js';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1] ?? null; };
const CONFIRM = args.includes('--confirm');
const DB = process.env.STATE_DB || `${process.env.STATE_DIR || '/fund-state/state'}/bot-state.db`;
const BEZANT = (process.env.BEZANT_URL || 'http://localhost:8080').replace(/\/$/, '');

const targetsPath = flag('--targets');
if (!targetsPath) { console.error('--targets <file.json> is required'); process.exit(2); }
const TARGETS = JSON.parse(readFileSync(targetsPath, 'utf8'));
const DIRECTED = (flag('--directed') || '').split(',').map(s => s.trim()).filter(Boolean);
const MIN_DEPLOY = flag('--min-deploy-usd') === null ? null : parseFloat(flag('--min-deploy-usd'));
const RESERVE = parseFloat(flag('--reserve-usd') ?? '150');

const sh = (label, cmd, argv) => {
  console.log(`\n── ${label} ─────────────────────────────`);
  const r = spawnSync(cmd, argv, { stdio: 'inherit', cwd: new URL('..', import.meta.url).pathname });
  if (r.status !== 0) { console.error(`\nFAILED: ${label} exited ${r.status}. Stopping.`); process.exit(1); }
};

const openDb = (write) => new DatabaseSync(DB, { readOnly: !write });
const readState = (db, k) => {
  const r = db.prepare('select value from state_kv where key = ?').get(k);
  return r ? JSON.parse(r.value) : null;
};

async function gather() {
  const db = openDb(false);
  const snap = readState(db, 'lastSnapshot');
  const pending = readState(db, 'pendingOrders') || [];
  const checkedAt = readState(db, 'lastCheckAt');
  if (!snap) throw new Error('no lastSnapshot — run managing-partner first');

  let authenticated = false, ledger = {};
  try {
    const h = await (await fetch(`${BEZANT}/health`)).json();
    authenticated = h.authenticated === true;
  } catch { /* stays false */ }

  let usdCash = snap.cashValue, audCash = 0, audToUsdRate = 0;
  if (authenticated) {
    try {
      const accts = await (await fetch(`${BEZANT}/accounts`)).json();
      const id = accts?.[0]?.accountId ?? accts?.[0]?.id;
      ledger = await (await fetch(`${BEZANT}/accounts/${id}/ledger`)).json();
      const rows = Object.values(ledger).filter(r => r && r.currency);
      const usd = rows.find(r => r.currency === 'USD');
      const aud = rows.find(r => r.currency === 'AUD');
      if (usd) usdCash = usd.cashbalance ?? usdCash;
      if (aud) audCash = aud.cashbalance ?? 0;
      // exchangerate is base(AUD) per 1 USD, so USD per AUD is its reciprocal.
      if (usd?.exchangerate > 0) audToUsdRate = 1 / usd.exchangerate;
    } catch { /* fall back to snapshot cash */ }
  }

  // Live prices resolve names not yet in the model (no snapshot price for them).
  const symbols = Object.keys(TARGETS);
  const prices = new Map((readState(db, 'lastPriceSnapshots') || []).map(p => [p.symbol, p.price]));
  if (authenticated) {
    try {
      for (const [s, p] of await getMarketPrices(symbols)) if (p > 0) prices.set(s, p);
    } catch (e) { console.error(`(live price fetch failed: ${e.message} — using snapshot prices)`); }
  }
  db.close?.();

  const missingPrices = symbols.filter(s => !(prices.get(s) > 0));
  let plan = null;
  if (missingPrices.length === 0) {
    plan = planDepositBuy({
      targets: TARGETS,
      holdings: new Map(snap.holdings.map(h => [h.symbol, h.currentValue])),
      prices,
      nav: snap.netLiquidation,
      cash: usdCash,
      depositUsd: 0,          // live ledger already includes anything settled
      directed: DIRECTED,
      reserveUsd: RESERVE,
    });
  }

  return {
    snap, pending, plan, prices, usdCash, audCash, audToUsdRate, authenticated, missingPrices,
    snapshotAgeMinutes: checkedAt ? (Date.now() - new Date(checkedAt).getTime()) / 60000 : 1e9,
  };
}

// `--refresh` folds the snapshot step in: managing-partner only reads the
// account and writes state, so it is safe to run before the gate.
if (args.includes('--refresh')) {
  sh('refresh snapshot (managing-partner)', 'node', ['dist/agents/managing-partner.js', '--once']);
}

const f = await gather();

console.log('deposit autopilot');
console.log(`  gateway     ${f.authenticated ? 'authenticated' : 'NOT authenticated'}`);
console.log(`  USD cash    $${f.usdCash.toFixed(2)}`);
console.log(`  AUD cash    ${f.audCash.toFixed(2)}${f.audCash > 200 ? '   <-- unconverted?' : ''}`);
console.log(`  NAV (USD)   $${f.snap.netLiquidation.toFixed(2)}`);
console.log(`  snapshot    ${f.snapshotAgeMinutes.toFixed(0)} min old`);
console.log(`  queued      ${f.pending.length} order(s)`);
console.log(`  window      ${isExecutionWindow() ? 'OPEN' : 'closed'}`);

if (f.plan) {
  console.log(`\n  plan (${f.plan.orders.length} orders, $${f.plan.deployedUsd.toFixed(0)}, residual $${f.plan.residualCashUsd.toFixed(0)}, drift ${f.plan.maxDriftPct.toFixed(2)}pp):`);
  for (const o of f.plan.orders) {
    console.log(`    BUY ${o.symbol.padEnd(6)} ${String(o.qty).padStart(3)} @ $${f.prices.get(o.symbol).toFixed(2).padStart(9)} = $${o.estimatedValue.toFixed(0).padStart(6)}`);
  }
}

const readiness = evaluateReadiness({
  authenticated: f.authenticated,
  usdCash: f.usdCash,
  audCash: f.audCash,
  audToUsdRate: f.audToUsdRate,
  minDeployUsd: MIN_DEPLOY,
  plannedDeployUsd: f.plan?.deployedUsd ?? 0,
  pendingOrderCount: f.pending.length,
  maxDriftPct: f.plan?.maxDriftPct ?? 0,
  driftThresholdPct: parseFloat(process.env.REBALANCE_DRIFT_THRESHOLD || '10'),
  missingPrices: f.missingPrices,
  executionWindowOpen: isExecutionWindow(),
  snapshotAgeMinutes: f.snapshotAgeMinutes,
});

if (!readiness.ready) {
  console.log(`\nNOT READY — ${readiness.blockers.length} blocker(s):\n`);
  for (const b of readiness.blockers) {
    console.log(`  [${b.code}] ${b.message}`);
    if (b.detail) console.log(`     ${b.detail}`);
    console.log(`     fix: ${b.fix}\n`);
  }
  process.exit(1);
}

console.log('\nREADY — no blockers.');
if (!CONFIRM) {
  console.log('Dry run. Re-run with --confirm to snapshot, stage, execute and reconcile.');
  process.exit(0);
}

// ---- past the gate: mechanical ----
const staged = f.plan.orders.map(o => ({
  symbol: o.symbol, action: 'BUY', qty: o.qty,
  estimatedValue: o.estimatedValue, reason: 'directed deposit deployment (pre-reweight)',
}));

const wdb = openDb(true);
if ((readState(wdb, 'pendingOrders') || []).length > 0) {
  console.error('REFUSING: a queue appeared since the check. Re-run.');
  process.exit(1);
}
wdb.prepare('insert into state_kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
  .run('pendingOrders', JSON.stringify(staged));
wdb.close?.();
console.log(`\nStaged ${staged.length} order(s).`);

sh('execute', 'node', ['dist/agents/execution-bot.js', '--once']);
sh('reconcile', 'node', ['scripts/reconcile-now.mjs']);

console.log('\nDone. Fills are in the ledger.');
console.log('NEXT (from the workstation, after checking the fills):');
console.log('  cp docs/private/local-2026-09.ts src/portfolios/local.ts && scripts/deploy-to-pi.sh');
