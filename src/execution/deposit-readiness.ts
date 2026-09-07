/**
 * Pre-flight for a directed deposit deployment.
 *
 * Pure so the decision is testable without a gateway, a clock, or an account.
 * The orchestrator gathers the facts; this decides whether to proceed and, when
 * not, says exactly what to do about it.
 *
 * Every check here exists because the corresponding failure is SILENT. The
 * executor defers buys it cannot fund rather than erroring; the planner sizes
 * happily against a stale balance; the strategist logs and exits outside market
 * hours. Nothing throws, and the deposit simply does not get deployed.
 */

export interface ReadinessInput {
  authenticated: boolean;
  /** USD ledger bucket — the only cash that can fund USD buys. */
  usdCash: number;
  /** AUD ledger bucket. Large idle AUD means an unconverted deposit. */
  audCash: number;
  /** USD per 1 AUD, for reporting what the idle AUD is worth. */
  audToUsdRate: number;
  /** What the operator expects to deploy. null = no floor. */
  minDeployUsd: number | null;
  plannedDeployUsd: number;
  pendingOrderCount: number;
  maxDriftPct: number;
  driftThresholdPct: number;
  /** Target names whose price could not be resolved. */
  missingPrices: string[];
  executionWindowOpen: boolean;
  snapshotAgeMinutes: number;
}

export interface Blocker {
  code: string;
  message: string;
  fix: string;
  detail?: string;
}

export interface Readiness {
  ready: boolean;
  blockers: Blocker[];
}

/**
 * Idle AUD above this is treated as an unconverted deposit rather than the
 * dividend/interest residue that always sits in the base bucket.
 */
const AUD_RESIDUE_TOLERANCE = 200;

/**
 * The snapshot is what the plan is sized from. Older than this and it may
 * predate the deposit, the conversion, or a material price move.
 */
const MAX_SNAPSHOT_AGE_MINUTES = 60;

export function evaluateReadiness(input: ReadinessInput): Readiness {
  const blockers: Blocker[] = [];

  if (!input.authenticated) {
    blockers.push({
      code: 'not_authenticated',
      message: 'The IBKR session is not authenticated.',
      fix: 'Start a login at the gateway URL and tap the IB Key push, then re-run.',
    });
  }

  if (input.audCash > AUD_RESIDUE_TOLERANCE) {
    const usdWorth = input.audCash * input.audToUsdRate;
    blockers.push({
      code: 'unconverted_aud',
      message: `AUD ${input.audCash.toFixed(0)} (~USD ${usdWorth.toFixed(0)}) is sitting in the AUD ledger bucket.`,
      fix: 'Convert AUD -> USD in IBKR, then refresh the snapshot. This is a cash (STKCASH) account: it cannot borrow USD, and AUD cash funds no USD buy.',
      detail: `usdCash=${input.usdCash.toFixed(2)} audCash=${input.audCash.toFixed(2)}`,
    });
  }

  if (input.minDeployUsd !== null && input.plannedDeployUsd < input.minDeployUsd) {
    blockers.push({
      code: 'under_deploy',
      message: `Plan deploys $${input.plannedDeployUsd.toFixed(0)}, below the $${input.minDeployUsd.toFixed(0)} floor.`,
      fix: 'Usually means the deposit has not landed, or landed in AUD and was never converted. Check the ledger before overriding.',
    });
  }

  if (input.pendingOrderCount > 0) {
    blockers.push({
      code: 'orders_queued',
      message: `${input.pendingOrderCount} order(s) already queued.`,
      fix: 'Execute or clear pendingOrders first — staging on top of an existing queue would double the position.',
    });
  }

  if (input.maxDriftPct >= input.driftThresholdPct) {
    blockers.push({
      code: 'drift_gate',
      message: `Max drift ${input.maxDriftPct.toFixed(2)}pp is at or over the ${input.driftThresholdPct}pp threshold.`,
      fix: 'The gate leaves `within-threshold`, so this becomes a full rebalance (sells, realised gains) or blocks on the cooldown. Re-check the target weights before proceeding.',
    });
  }

  if (input.missingPrices.length > 0) {
    blockers.push({
      code: 'missing_prices',
      message: `No price for ${input.missingPrices.length} target name(s).`,
      fix: 'A name being ADDED has no price in state until it is in the model. Confirm the gateway resolves its contract.',
      detail: input.missingPrices.join(', '),
    });
  }

  if (!input.executionWindowOpen) {
    blockers.push({
      code: 'market_closed',
      message: 'Outside the US execution window.',
      fix: 'Stage and execute inside 09:30-16:00 ET on a weekday; outside it the executor will not fill and the queue just sits.',
    });
  }

  if (input.snapshotAgeMinutes > MAX_SNAPSHOT_AGE_MINUTES) {
    blockers.push({
      code: 'stale_snapshot',
      message: `Snapshot is ${Math.round(input.snapshotAgeMinutes)} minutes old.`,
      fix: 'Re-run with --refresh (or run the managing-partner agent) so NAV, cash and prices post-date the deposit and conversion.',
    });
  }

  return { ready: blockers.length === 0, blockers };
}
