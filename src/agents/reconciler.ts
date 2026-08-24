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
import { connect, disconnect, getAccountSummary, requestDelayedData } from '../connection/gateway.js';
import { TARGET_PORTFOLIO, config } from '../config.js';
import { assessModelConformance } from '../risk/model-conformance.js';
import { loadState, mergeState, loadTradeHistory } from '../state/store.js';
import { notify } from '../notify/slack.js';
import { storeHooks } from '../notify/store-hooks.js';
import { log, logError } from '../log.js';

const AGENT = 'Reconciler';

/** symbol -> net shares implied by everything we have recorded. */
function ledgerImpliedShares(): Map<string, number> {
  const implied = new Map<string, number>();
  for (const t of loadTradeHistory()) {
    const delta = t.qty * (t.action === 'BUY' ? 1 : -1);
    implied.set(t.symbol, (implied.get(t.symbol) ?? 0) + delta);
  }
  return implied;
}

/**
 * A stable description of how the ledger differs from the broker.
 *
 * The account pre-dates the ledger, so a non-zero difference is the NORMAL
 * steady state and alerting on its existence would be noise forever. What
 * matters is the difference CHANGING — that means a fill happened which we did
 * not record, or recorded wrongly.
 */
function driftSignature(implied: Map<string, number>, actual: Map<string, number>): string {
  const symbols = [...new Set([...implied.keys(), ...actual.keys()])].sort();
  return symbols
    .map(s => `${s}:${(actual.get(s) ?? 0) - (implied.get(s) ?? 0)}`)
    .filter(entry => !entry.endsWith(':0'))
    .join(',');
}

async function run(): Promise<void> {
  log('Reconciliation starting', AGENT);
  await connect();
  requestDelayedData();

  try {
    const account = await getAccountSummary();
    const positions = account.positions.filter(p => (p.qty ?? 0) !== 0);
    const investedValue = positions.reduce((s, p) => s + (p.marketValue ?? 0), 0);
    log(`IBKR reports ${positions.length} positions, invested value ${investedValue.toFixed(2)}`, AGENT);

    // ---- 1. Model conformance, measured against the broker's own numbers ----
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
      await notify(
        {
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
        },
        storeHooks,
      );
    }

    // ---- 2. Ledger vs broker positions ----
    const implied = ledgerImpliedShares();
    const actual = new Map(positions.map(p => [p.symbol, p.qty ?? 0]));
    const signature = driftSignature(implied, actual);
    const state = loadState();
    const known = state.ledgerDriftSignature as string | undefined;

    if (signature === '') {
      log('Ledger implies exactly the broker position for every symbol', AGENT);
    } else if (known === undefined) {
      // First run: adopt the existing difference as the baseline rather than
      // alerting about history we were never going to have recorded.
      log(`Ledger drift baseline adopted: ${signature}`, AGENT);
    } else if (signature !== known) {
      log(`LEDGER DRIFT CHANGED: was [${known}] now [${signature}]`, AGENT);
      await notify(
        {
          severity: 'critical',
          title: 'Ledger no longer implies the broker position',
          body:
            'The difference between our recorded trades and IBKR\'s actual shares has CHANGED, ' +
            'which means a fill occurred that we did not record, or recorded wrongly. The ledger ' +
            'is the tax record — cost basis and realised P&L derive from it.',
          fields: [
            { label: 'Was', value: known || '(none)' },
            { label: 'Now', value: signature },
          ],
          agent: AGENT,
          dedupe: { key: 'reconciler:ledger-drift', fingerprint: signature },
        },
        storeHooks,
      );
    } else {
      log(`Ledger drift unchanged from baseline (${signature})`, AGENT);
    }

    mergeState({ ledgerDriftSignature: signature, lastReconcileAt: new Date().toISOString() });
  } finally {
    disconnect();
  }
  log('Reconciliation complete', AGENT);
}

if (process.argv.includes('--once')) {
  run().then(() => process.exit(0)).catch(e => { logError('Fatal', e, AGENT); process.exit(1); });
}

export { run };
