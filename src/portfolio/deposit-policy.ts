/**
 * The standing instruction for deploying new cash.
 *
 * The approval for a deposit moves from TRADE time to DECLARATION time: you
 * say in advance which names the money is for, and the fund executes that
 * without asking. Nothing unattended decides where the money goes — you did,
 * on a file, before it arrived.
 *
 * What the policy deliberately does NOT carry is the target weights. Those are
 * the model, and since the model can now be published as data
 * (PORTFOLIO_TARGETS_FILE) there is no second copy to drift out of step. The
 * policy is the small residue that is genuinely about this deposit: which
 * names it is for, what to hold back, how much is worth acting on, and when
 * the instruction lapses.
 *
 * Why `directed` earns its place: the cash-flow rebuy guard excludes names the
 * strategy sold inside the guard window, which is right for churn but wrong
 * for a deposit — right after a rebalance it refuses to buy exactly the names
 * a top-up is meant to fund. A name you have named in advance is an explicit
 * instruction, not churn, so it is exempt. Everything else still respects the
 * guard.
 */

export interface DepositPolicy {
  /** Funded to target first, in order, and exempt from the rebuy guard. */
  directed: string[];
  /** Below this the deployment is not worth doing; 0 means no floor. */
  minDeployUsd: number;
  /** Held back for commission and slippage. Never spent. */
  reserveUsd: number;
  /** The instruction lapses at this instant. Required. */
  expiresAt: Date;
}

/** Enough for commission and a little slippage on a retail-size batch. */
const DEFAULT_RESERVE_USD = 150;

export function parseDepositPolicy(raw: unknown, where: string): DepositPolicy {
  const bad = (msg: string): never => {
    throw new Error(`${where}: ${msg}`);
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad('expected an object with { directed, expiresAt, minDeployUsd?, reserveUsd? }');
  }
  const o = raw as Record<string, unknown>;

  const directed: string[] = [];
  if (o.directed !== undefined) {
    if (!Array.isArray(o.directed)) bad('directed must be an array of symbols');
    for (const d of o.directed as unknown[]) {
      if (typeof d !== 'string' || !d.trim()) bad('directed contains a blank or non-string symbol');
      const sym = (d as string).trim().toUpperCase();
      if (directed.includes(sym)) bad(`directed lists ${sym} twice`);
      directed.push(sym);
    }
  }

  const num = (v: unknown, name: string, dflt: number): number => {
    if (v === undefined || v === null) return dflt;
    if (typeof v !== 'number' || !Number.isFinite(v)) return bad(`${name} must be a number`);
    if (v < 0) return bad(`${name} must not be negative`);
    return v;
  };
  const minDeployUsd = num(o.minDeployUsd, 'minDeployUsd', 0);
  const reserveUsd = num(o.reserveUsd, 'reserveUsd', DEFAULT_RESERVE_USD);

  // An instruction with no expiry is how a deposit six months from now gets
  // deployed against intentions from today.
  if (typeof o.expiresAt !== 'string' || !o.expiresAt.trim()) {
    bad('expiresAt is required (ISO 8601) — a standing instruction must lapse');
  }
  const expiresAt = new Date(o.expiresAt as string);
  if (Number.isNaN(expiresAt.getTime())) {
    bad(`expiresAt is not a valid date: ${String(o.expiresAt)}`);
  }

  return { directed, minDeployUsd, reserveUsd, expiresAt };
}

export interface DepositDecisionInput {
  /** null when no policy file is configured or present. */
  policy: DepositPolicy | null;
  /**
   * SETTLED USD cash. Not `usdCash`: an unsettled deposit shows in the balance
   * but cannot fund a buy, and staging against it produces orders the executor
   * silently defers.
   */
  settledCashUsd: number;
  /** Cash kept back from any deployment, deposit or not. */
  cashThresholdUsd: number;
  now: Date;
}

export interface DepositDecision {
  /** Use the directed planner rather than the ordinary cash-flow path. */
  directed: boolean;
  /** What may be deployed, before the policy's own reserve. */
  deployableUsd: number;
  /** Why, for the log — this decision is otherwise invisible. */
  reason: string;
}

export function decideDeposit(i: DepositDecisionInput): DepositDecision {
  const deployableUsd = Math.max(0, i.settledCashUsd - i.cashThresholdUsd);
  const no = (reason: string): DepositDecision => ({ directed: false, deployableUsd, reason });

  if (deployableUsd <= 0) {
    return { directed: false, deployableUsd: 0, reason: 'no settled cash above the threshold' };
  }
  if (!i.policy) return no('no deposit policy in force');
  if (i.policy.expiresAt.getTime() <= i.now.getTime()) {
    return no(`deposit policy expired ${i.policy.expiresAt.toISOString()}`);
  }
  if (i.policy.minDeployUsd > 0 && deployableUsd < i.policy.minDeployUsd) {
    return no(
      `settled cash $${deployableUsd.toFixed(0)} is below the policy floor `
      + `$${i.policy.minDeployUsd.toFixed(0)}`,
    );
  }
  return {
    directed: true,
    deployableUsd,
    reason: `deposit policy in force${i.policy.directed.length
      ? ` (directed: ${i.policy.directed.join(', ')})` : ''}`,
  };
}
