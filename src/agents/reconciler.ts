/**
 * Reconciler — does reality still match what we believe?
 *
 * Every other health check added after the 2026-08-18 incident watches the
 * MACHINERY: market-data freshness, ledger liveness, agent heartbeats, backup
 * integrity. None of them would have caught what actually happened. The
 * allocation was quietly retargeted away from the deliberate book by an
 * optimizer running on six days of bad data, every component reported healthy
 * throughout, and it was found because a human looked at the account.
 *
 * This agent asks the broker directly and checks two things nothing else does:
 *
 *   1. CONFORMANCE — do IBKR's actual positions still look like the model
 *      portfolio? Compared against TARGET_PORTFOLIO deliberately, not against
 *      whatever the strategist currently intends: comparing to the strategist's
 *      own target would have agreed enthusiastically with the incident, because
 *      the whole problem was that its target had moved.
 *
 *   2. LEDGER DRIFT — do our recorded trades imply the share counts IBKR
 *      reports? The ledger is the tax record. execution-bot's
 *      reconcileExecutions() backfills individual FILLS, but nothing checked the
 *      resulting POSITIONS, so a silent divergence would surface at tax time.
 *
 * Both alert. Neither trades.
 */
import 'dotenv/config';
import { connect, disconnect, getAccountSummary, requestDelayedData, type AccountSummary } from '../connection/gateway.js';
import { TARGET_PORTFOLIO, config } from '../config.js';
import { assessModelConformance } from '../risk/model-conformance.js';
import { loadState, mergeState, loadTradeHistory, type FundState, type TradeRecord } from '../state/store.js';
import { ledgerImpliedShares, formatDriftSignature } from '../execution/orphan-recovery.js';
import { notify, type NotifyEvent } from '../notify/slack.js';
import { storeHooks } from '../notify/store-hooks.js';
import { log, logError } from '../log.js';
import { agentStartup } from '../startup.js';

const AGENT = 'Reconciler';

/**
 * A stable description of how the ledger differs from the broker.
 *
 * The account pre-dates the ledger, so a non-zero difference is the NORMAL
 * steady state and alerting on its existence would be noise forever. What
 * matters is the difference departing from the ACCEPTED one — that means a
 * fill happened which we did not record, or recorded wrongly.
 */
function driftSignature(implied: Map<string, number>, actual: Map<string, number>): string {
  const drift = new Map<string, number>();
  for (const s of new Set([...implied.keys(), ...actual.keys()])) {
    drift.set(s, (actual.get(s) ?? 0) - (implied.get(s) ?? 0));
  }
  // Shared with execution-bot's orphan recovery, which subtracts the accepted
  // baseline from this same difference. Two spellings of one signature would
  // make it silently disagree about what has already been accounted for.
  return formatDriftSignature(drift);
}

/** Everything the reconciler touches outside itself — real in production, fakes in tests. */
export interface ReconcileDeps {
  connect(): Promise<void>;
  getAccountSummary(): Promise<AccountSummary>;
  loadState(): FundState;
  mergeState(updates: Record<string, unknown>): unknown;
  loadTradeHistory(): TradeRecord[];
  notify(event: NotifyEvent): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export type ReconcileOutcome = 'reconciled' | 'deferred' | 'unknown';

/**
 * Waits between connect attempts while the gateway is logged out, in minutes.
 * 1+2+4+8+15 = 30: long enough to ride out a relogin or a tapped push, short
 * enough that the unit's TimeoutStartSec (45 min) is never the thing that ends it.
 */
export function authRetryDelaysMs(): number[] {
  const raw = process.env.RECONCILE_AUTH_RETRY_MIN ?? '1,2,4,8,15';
  return raw.split(',').filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n >= 0).map((m) => m * 60_000);
}

/**
 * bezant answers /health with a 401 when the gateway is logged out, and
 * connect() also throws when /health says authenticated:false. Both mean "try
 * later", not "the reconciler is broken".
 */
export function isNotAuthenticated(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | null;
  if (e?.status === 401) return true;
  return /not[ _]authenticated/i.test(String(e?.message ?? ''));
}

async function connectOrDefer(deps: ReconcileDeps): Promise<boolean> {
  const delays = authRetryDelaysMs();
  for (let attempt = 0; ; attempt++) {
    try {
      await deps.connect();
      return true;
    } catch (err) {
      // Anything else — bezant down, a bad URL — fails the run, and the unit's
      // OnFailure hook says so. Only a logged-out gateway is worth waiting for.
      if (!isNotAuthenticated(err)) throw err;
      if (attempt >= delays.length) return false;
      log(`gateway not logged in — retrying in ${Math.round(delays[attempt] / 60_000)} min`, AGENT);
      await deps.sleep(delays[attempt]);
    }
  }
}

/**
 * Which drift signature a run is compared against.
 *
 * It used to be the LAST run's signature, overwritten every run. So a change
 * alerted exactly once and the next run adopted it as normal — an unrecorded
 * fill became invisible twelve hours after it was reported. Comparing to the
 * ACCEPTED baseline instead keeps the alert up for as long as the ledger is
 * wrong, and lets a recovery be reported when it is fixed.
 * RECONCILE_DRIFT_REF=last restores the old comparison.
 */
function driftReference(state: FundState): string | undefined {
  const last = state.ledgerDriftSignature as string | undefined;
  if ((process.env.RECONCILE_DRIFT_REF || 'baseline') === 'last') return last;
  return (state.ledgerDriftBaseline as string | undefined) ?? last;
}

export async function reconcile(deps: ReconcileDeps): Promise<ReconcileOutcome> {
  log('Reconciliation starting', AGENT);
  if (!(await connectOrDefer(deps))) {
    const waited = authRetryDelaysMs().reduce((a, b) => a + b, 0) / 60_000;
    log(`DEFERRED — the gateway stayed logged out for ${waited} min; not reconciling this run`, AGENT);
    await deps.notify({
      severity: 'warn',
      title: 'Reconcile deferred — the IBKR gateway is logged out',
      body:
        `Waited ${waited} minutes for a session and got none, so the book was not checked against the broker ` +
        'this run. Nothing is wrong with the reconciler; it runs again at its next slot. Log the gateway in.',
      agent: AGENT,
      // One push per deferral, not one per retry; a second deferral 12h later
      // is a second event worth hearing about.
      dedupe: { key: 'reconciler:deferred', ttlMs: 6 * 3_600_000 },
    });
    return 'deferred';
  }

  const account = await deps.getAccountSummary();
  const positions = account.positions.filter(p => (p.qty ?? 0) !== 0);
  const investedValue = positions.reduce((s, p) => s + (p.marketValue ?? 0), 0);
  log(`IBKR reports ${positions.length} positions, invested value ${investedValue.toFixed(2)}`, AGENT);

  const history = deps.loadTradeHistory();
  const implied = ledgerImpliedShares(history);
  const ledgerHolds = [...implied.values()].some(v => v !== 0);

  // ---- 0. An empty answer is not an answer ----
  // IBKR commonly returns [] on the first call after a session bounce, and
  // getAccountSummary() turns that into a successful-looking empty list. Read
  // literally it is "everything was sold": conformance divided by a zero
  // invested value, and the drift signature was overwritten with the whole
  // book. Same guard as orphan recovery — unknown, change nothing, say so.
  if (positions.length === 0 && ledgerHolds) {
    log('Broker reported NO positions while the ledger implies holdings — treating as unknown, no state written', AGENT);
    await deps.notify({
      severity: 'warn',
      title: 'Reconcile skipped — IBKR reported no positions',
      body:
        'The broker returned an empty position list while the ledger implies holdings. That is almost always ' +
        'a session that has not finished warming up, not a liquidation — but it cannot be told apart here, so ' +
        'nothing was compared or recorded. The next run will try again.',
      agent: AGENT,
      dedupe: { key: 'reconciler:empty-positions', ttlMs: 6 * 3_600_000 },
    });
    return 'unknown';
  }

  // ---- 1. Model conformance, measured against the broker's own numbers ----
  if (investedValue > 0) {
    const weights = new Map<string, number>();
    for (const p of positions) weights.set(p.symbol, (p.marketValue ?? 0) / investedValue);

    const conf = assessModelConformance(weights, TARGET_PORTFOLIO, {
      maxNameDeviationPct: config.conformance.maxNameDeviationPct,
      maxSleeveDeviationPct: config.conformance.maxSleeveDeviationPct,
    });

    if (conf.conforms) {
      // Log the headroom, not just the pass. "Conforms" with 14pp of a 15pp
      // limit already consumed is a very different state from "conforms" at 2pp.
      // Each worst measured against its OWN limit. Comparing a sleeve deviation
      // to the per-name limit reported 0.0pp of headroom when 2.7pp remained.
      const nameHead = config.conformance.maxNameDeviationPct - conf.worstNamePct;
      const sleeveHead = config.conformance.maxSleeveDeviationPct - conf.worstSleevePct;
      log(
        `Book conforms — worst name ${conf.worstNamePct.toFixed(1)}pp (${nameHead.toFixed(1)}pp headroom), ` +
          `worst sleeve ${conf.worstSleevePct.toFixed(1)}pp (${sleeveHead.toFixed(1)}pp headroom)`,
        AGENT,
      );
    } else {
      for (const b of conf.breaches) {
        log(`  ${b.kind} ${b.key}: actual ${b.actualPct.toFixed(1)}% vs model ${b.targetPct.toFixed(1)}% (${b.deviationPct.toFixed(1)}pp)`, AGENT);
      }
      await deps.notify({
        severity: 'warn',
        title: `Book has drifted from the model — ${conf.breaches.length} breach${conf.breaches.length === 1 ? '' : 'es'}`,
        body:
          'Positions at IBKR no longer match the model portfolio. This compares against the ' +
          'MODEL, not the strategist\'s current target, so it still fires when the strategist ' +
          'itself is the thing that moved. No orders were placed.',
        fields: conf.breaches.slice(0, 8).map(b => ({
          label: `${b.kind} ${b.key}`,
          value: `${b.actualPct.toFixed(1)}% vs ${b.targetPct.toFixed(1)}% (${b.deviationPct.toFixed(1)}pp)`,
        })),
        agent: AGENT,
        dedupe: { key: 'reconciler:conformance', fingerprint: conf.fingerprint },
      });
    }
  } else {
    log('No invested value — conformance not assessed', AGENT);
  }

  // ---- 2. Ledger vs broker positions ----
  const actual = new Map(positions.map(p => [p.symbol, p.qty ?? 0]));
  const signature = driftSignature(implied, actual);
  const state = deps.loadState();
  const known = state.ledgerDriftSignature as string | undefined;
  const reference = driftReference(state);
  const wasAlerting = state.ledgerDriftAlerting === true;
  let alerting = false;

  if (reference === undefined) {
    // First run: adopt the existing difference as the baseline rather than
    // alerting about history we were never going to have recorded.
    log(`Ledger drift baseline adopted: ${signature || '(none)'}`, AGENT);
  } else if (signature !== reference) {
    alerting = true;
    log(`LEDGER DRIFT: accepted [${reference}] now [${signature}]`, AGENT);
    await deps.notify({
      severity: 'critical',
      title: 'Ledger no longer implies the broker position',
      body:
        'The difference between our recorded trades and IBKR\'s actual shares no longer matches the ' +
        'accepted pre-ledger difference, which means a fill occurred that we did not record, or recorded ' +
        'wrongly. The ledger is the tax record — cost basis and realised P&L derive from it. This repeats ' +
        'until the ledger is corrected.',
      fields: [
        { label: 'Accepted', value: reference || '(none)' },
        { label: 'Now', value: signature || '(none)' },
      ],
      agent: AGENT,
      // Keyed on the current difference: a different wrong is a new alert,
      // the same wrong re-nags on the critical ttl while it lasts.
      dedupe: { key: 'reconciler:ledger-drift', fingerprint: signature },
    });
  } else {
    log(`Ledger drift matches the accepted baseline (${signature || 'none'})`, AGENT);
    if (wasAlerting) {
      await deps.notify({
        severity: 'recovery',
        title: 'Ledger implies the broker position again',
        body: 'The ledger-vs-broker difference is back to the accepted baseline.',
        fields: [{ label: 'Accepted', value: reference || '(none)' }],
        agent: AGENT,
        dedupe: { key: 'reconciler:ledger-drift', fingerprint: 'recovered' },
      });
    }
  }

  // Two different things, deliberately stored separately:
  //
  //   ledgerDriftSignature — the last-seen difference, for diagnostics and the
  //     RECONCILE_DRIFT_REF=last comparison.
  //   ledgerDriftBaseline — the difference ACCEPTED as pre-ledger history.
  //     execution-bot's orphan recovery subtracts it before concluding that
  //     shares at the broker are an unrecorded fill, so it must never absorb
  //     a real fill: if it did, the orphan that fill left in the queue would
  //     look explained and get placed a second time.
  //
  // Only a genuine first run seeds the baseline here. Once a signature
  // exists the difference may already contain an unrecorded fill, and
  // adopting that would hide exactly what recovery hunts for. From then on
  // the baseline is execution-bot's to advance, because only it knows which
  // part of the drift the queue accounts for.
  const updates: Record<string, unknown> = {
    ledgerDriftSignature: signature,
    ledgerDriftAlerting: alerting,
    lastReconcileAt: new Date().toISOString(),
  };
  if (known === undefined && state.ledgerDriftBaseline === undefined) {
    updates.ledgerDriftBaseline = signature;
  }
  deps.mergeState(updates);
  log('Reconciliation complete', AGENT);
  return 'reconciled';
}

const liveDeps: ReconcileDeps = {
  connect: async () => { await connect(); requestDelayedData(); },
  getAccountSummary,
  loadState,
  mergeState,
  loadTradeHistory,
  notify: (event) => notify(event, storeHooks),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

async function run(): Promise<ReconcileOutcome> {
  try {
    return await reconcile(liveDeps);
  } finally {
    disconnect();
  }
}

if (process.argv.includes('--once')) {
  // A deferral exits 0 on purpose: the unit did its job (it waited, then
  // said so), and a failed unit would page a second time for the same logout.
  Promise.resolve()
    .then(() => agentStartup(AGENT, { config }))
    .then(() => run())
    .then(() => process.exit(0))
    .catch(e => { logError('Fatal', e, AGENT); process.exit(1); });
}

export { run };
