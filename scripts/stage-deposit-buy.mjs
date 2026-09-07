#!/usr/bin/env node
/**
 * Stage a DIRECTED buy for an incoming deposit, ahead of a model-weight change.
 *
 * WHY THIS EXISTS, rather than letting the cash-flow path do it. Two reasons,
 * both of which make the automatic path the wrong tool right after a reweight:
 *
 *   1. `allocateCashFlow` skips names the strategy sold within
 *      CASH_FLOW_REBUY_GUARD_DAYS (the churn rebuy guard). If a recent
 *      rebalance trimmed the very names a deposit is meant to top up, the
 *      automatic path refuses to buy them and parks that share of the deposit
 *      in cash instead.
 *   2. It deploys against the CURRENT model weights. A deposit intended to
 *      fund a new allocation has to be sized against the NEW ones.
 *
 * So the order is: stage a directed buy -> execute it -> THEN switch
 * src/portfolios/local.ts to the new targets. Buying first means the new
 * weights land on a book that already matches them, so `computeDrift` stays
 * under REBALANCE_DRIFT_THRESHOLD and the gate stays `within-threshold` — no
 * sells, no realised gains, no reset of the frequencyDays cooldown. Flipping
 * the weights first risks the opposite: drift at or above the threshold puts
 * the gate in `too-soon` until the cooldown lapses, which BLOCKS cash-flow
 * deployment entirely and leaves the deposit idle.
 *
 * Targets are read from a JSON file, not hardcoded: this repo is public and a
 * real book's weights belong with local.ts and docs/private/, not in it.
 * Format — `{ "SYM": pct, ... }`, summing to 100.
 *
 * Dry-run by default. Writes state only with --confirm.
 *
 *   node scripts/stage-deposit-buy.mjs --targets docs/private/targets.json \
 *     --deposit-usd 3602 --directed NET,XLE --price XLE=64.06
 *
 * --price is needed for any name not yet in the model portfolio: research-scout
 * only snapshots prices for names local.ts already lists, so a name being ADDED
 * has none in state until after the reweight.
 *
 * RACE: run the executor straight after staging. The strategist also writes
 * pendingOrders, and in `within-threshold` with idle cash over its floor it
 * will queue its own cash-flow orders and overwrite this queue. Once this buy
 * fills, cash sits under that floor and the race is gone.
 *
 *   scripts/run-agent.sh execution-bot
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
// The planning logic is src/portfolio/deposit-plan.ts, unit-tested there. This
// script is only state I/O and a CLI around it — the Pi runs prebuilt dist/, so
// import the built artefact rather than duplicating the algorithm here.
import { planDepositBuy } from '../dist/portfolio/deposit-plan.js';

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};

const DB = process.env.STATE_DB || `${process.env.STATE_DIR || '/fund-state/state'}/bot-state.db`;

/**
 * Cash NOT YET reflected in `lastSnapshot`, for planning before money lands.
 * Defaults to 0 — the correct value once the deposit has arrived, been
 * CONVERTED TO USD, and the snapshot refreshed, because `cashValue` already
 * includes it by then. Passing it again would double-count: the planner adds
 * this to snapshot cash for the budget AND to snapshot NAV for target sizing.
 */
const DEPOSIT = flag('--deposit-usd') === null ? 0 : parseFloat(flag('--deposit-usd'));
if (!Number.isFinite(DEPOSIT) || DEPOSIT < 0) {
  console.error('usage: --targets <file.json> [--deposit-usd <not-yet-settled amount>] [--directed SYM,SYM] [--price SYM=VAL] [--confirm]');
  process.exit(2);
}

const targetsPath = flag('--targets');
if (!targetsPath) { console.error('--targets <file.json> is required'); process.exit(2); }
let TARGETS;
try { TARGETS = JSON.parse(readFileSync(targetsPath, 'utf8')); }
catch (e) { console.error(`cannot read --targets ${targetsPath}: ${e.message}`); process.exit(2); }

/** Funded to target first — the deposit's stated purpose. */
const DIRECTED = (flag('--directed') || '').split(',').map((s) => s.trim()).filter(Boolean);

/** --price SYM=VAL, repeatable. For names not yet in the model (no state price). */
const PRICE_OVERRIDES = new Map();
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--price') continue;
  const [sym, val] = String(args[i + 1] ?? '').split('=');
  const n = parseFloat(val);
  if (!sym || !Number.isFinite(n) || n <= 0) { console.error(`bad --price ${args[i + 1]}`); process.exit(2); }
  PRICE_OVERRIDES.set(sym, n);
}

/** Held back for commission + slippage so the last BUY can't tip into no-buying-power. */
const RESERVE_USD = parseFloat(flag('--reserve-usd') ?? '150');

const db = new DatabaseSync(DB, { readOnly: !CONFIRM });
const get = (k) => {
  const r = db.prepare('select value from state_kv where key = ?').get(k);
  return r ? JSON.parse(r.value) : null;
};

const snap = get('lastSnapshot');
if (!snap) { console.error('no lastSnapshot in state — run the managing-partner agent first'); process.exit(1); }

const prices = new Map((get('lastPriceSnapshots') || []).map((p) => [p.symbol, p.price]));
for (const [sym, val] of PRICE_OVERRIDES) prices.set(sym, val);

const holdings = new Map(snap.holdings.map((h) => [h.symbol, h.currentValue]));

let plan;
try {
  plan = planDepositBuy({
    targets: TARGETS,
    holdings,
    prices,
    nav: snap.netLiquidation,
    cash: snap.cashValue,
    depositUsd: DEPOSIT,
    directed: DIRECTED,
    reserveUsd: RESERVE_USD,
  });
} catch (e) {
  console.error(e.message);
  if (/no price for/.test(e.message)) {
    const first = e.message.split(':')[1].trim().split(',')[0];
    console.error(`research-scout snapshots prices for MODEL names only. Pass one, e.g. --price ${first}=<last trade>`);
  }
  process.exit(1);
}

const { orders, navAfter, deployedUsd, residualCashUsd, maxDriftPct } = plan;
if (orders.length === 0) { console.error('no affordable buys — nothing staged'); process.exit(1); }

/**
 * Silent under-deployment is the failure mode that matters here, and it does
 * NOT look like an error.
 *
 * The executor gates BUYs on `getUsdBalances().usdCash`, which reads ONLY the
 * USD ledger bucket. This is an AUD-base STKCASH account: it cannot borrow USD,
 * and a deposit that arrives in AUD sits in the AUD bucket funding nothing. So
 * an unconverted deposit does not raise an error — `cashValue` simply never
 * moves, and this planner cheerfully produces a much smaller plan that fits the
 * old balance. It looks like success.
 *
 * `--min-deploy-usd` is how the operator states what they came to deploy, so
 * that case fails loudly instead.
 */
const MIN_DEPLOY = flag('--min-deploy-usd') === null ? null : parseFloat(flag('--min-deploy-usd'));
if (MIN_DEPLOY !== null && !Number.isFinite(MIN_DEPLOY)) { console.error('bad --min-deploy-usd'); process.exit(2); }

console.log(`state      ${DB}`);
console.log(`targets    ${targetsPath} (${Object.keys(TARGETS).length} names)`);
console.log(`NAV        $${snap.netLiquidation.toFixed(0)} + deposit $${DEPOSIT.toFixed(0)} = $${navAfter.toFixed(0)}`);
console.log(`USD cash   $${snap.cashValue.toFixed(0)}${DEPOSIT ? ` + $${DEPOSIT.toFixed(0)} not-yet-settled` : ''}, less $${RESERVE_USD} reserve`);
if (DEPOSIT > 0) {
  console.log('           !! --deposit-usd is for cash NOT yet in the snapshot.');
  console.log('              If the money has landed and the snapshot is fresh, use 0.');
}
console.log('');
for (const o of orders) {
  console.log(`  BUY ${o.symbol.padEnd(6)} ${String(o.qty).padStart(3)} @ $${prices.get(o.symbol).toFixed(2).padStart(9)} = $${o.estimatedValue.toFixed(0).padStart(6)}`);
}
console.log(`\ndeployed   $${deployedUsd.toFixed(0)}`);
console.log(`residual   $${residualCashUsd.toFixed(0)} (${((residualCashUsd / navAfter) * 100).toFixed(1)}% of NAV)`);
console.log(`maxDrift   ${maxDriftPct.toFixed(2)}pp against the NEW targets`);
console.log(`gate       ${maxDriftPct >= 25 ? 'URGENT — a rebalance fires immediately, bypassing the cooldown'
  : maxDriftPct >= 10 ? 'AT/OVER THRESHOLD — leaves within-threshold; cash-flow deployment blocks until the cooldown lapses'
  : 'within-threshold — no sells, cash-flow path stays open'}`);
if (maxDriftPct >= 10) console.log('\n!! Do NOT switch local.ts to these targets while drift is this high.');

if (MIN_DEPLOY !== null && deployedUsd < MIN_DEPLOY) {
  console.error(`\nREFUSING: plan deploys $${deployedUsd.toFixed(0)}, below the --min-deploy-usd floor of $${MIN_DEPLOY.toFixed(0)}.`);
  console.error(`Only $${snap.cashValue.toFixed(0)} of USD cash is visible in the snapshot.`);
  console.error('If a deposit was expected, the most likely cause is that it landed in AUD:');
  console.error('  this is an AUD-base STKCASH account, so USD buys need USD cash and');
  console.error('  IBKR will not fund them from the AUD bucket.');
  console.error('Fix: convert AUD -> USD in IBKR, re-run managing-partner, then retry.');
  process.exit(1);
}

if (!CONFIRM) {
  console.log('\nDRY RUN — nothing written. Re-run with --confirm to stage these orders.');
  process.exit(0);
}

const existing = get('pendingOrders') || [];
if (existing.length) {
  console.error(`\nREFUSING: ${existing.length} order(s) already queued. Clear or execute them first.`);
  process.exit(1);
}
db.prepare('insert into state_kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
  .run('pendingOrders', JSON.stringify(orders));
console.log(`\nStaged ${orders.length} order(s) to pendingOrders.`);
console.log('Execute NOW (see RACE above): scripts/run-agent.sh execution-bot');
