/**
 * Rollout flags for the 2026-09-24 review's risk/strategy changes.
 *
 * Each one ships DARK: its default is exactly what production did before the
 * change, so deploying the code alters no trading. A switch-on is a separate,
 * deliberate `.env` edit, made one flag at a time.
 *
 *   DRIFT_GATE          legacy | bands        (default legacy)
 *     legacy — `decideRebalance` on max single-name drift, as before.
 *     bands  — the per-name tolerance-band gate (portfolio/drift-bands.ts),
 *              with the cash-flow refinements that belong to it (settled cash,
 *              buy-only deployment while a sell cooldown runs, target-aware
 *              rebuy guard, half-share deficit rule, quant-this-cycle gate).
 *              The bands gate is evaluated and logged on EVERY run either way
 *              ("bands gate would: ..."), which is its out-of-sample record.
 *
 *   RISK_NAV_SOURCE     legacy | units        (default legacy)
 *     legacy — drawdown ladder on the raw AUD net-liquidation history.
 *     units  — drawdown ladder on the USD unit index (risk/unit-nav.ts), so a
 *              deposit or withdrawal is not a gain or a drawdown.
 *
 *   INTRADAY_DD_SOURCE  legacy | shadow | nl  (default shadow)
 *     legacy — the old upnl+rpnl reconstruction gates, nothing else runs.
 *     shadow — legacy still gates; the `nl`-based figure is computed and
 *              logged beside it for comparison.
 *     nl     — the `nl`-based figure gates.
 *
 * An unrecognised value falls back to the default (today's behaviour) and is
 * reported in `problems`, which every agent that reads a flag logs at start. A
 * typo therefore can never switch something ON.
 */

export type DriftGate = 'legacy' | 'bands';
export type RiskNavSource = 'legacy' | 'units';
export type IntradayDdSource = 'legacy' | 'shadow' | 'nl';

export interface RolloutFlags {
  driftGate: DriftGate;
  riskNavSource: RiskNavSource;
  intradayDdSource: IntradayDdSource;
  /** One line per env var that held an unrecognised value. */
  problems: string[];
}

function pick<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  fallback: T,
  problems: string[],
): T {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase() as T;
  if ((allowed as readonly string[]).includes(v)) return v;
  problems.push(`${name}='${raw}' is not one of ${allowed.join('|')} — using ${fallback}`);
  return fallback;
}

/** Pure parse, for tests and for the agents' start-of-run log line. */
export function readRolloutFlags(env: NodeJS.ProcessEnv = process.env): RolloutFlags {
  const problems: string[] = [];
  return {
    driftGate: pick(env, 'DRIFT_GATE', ['legacy', 'bands'] as const, 'legacy', problems),
    riskNavSource: pick(env, 'RISK_NAV_SOURCE', ['legacy', 'units'] as const, 'legacy', problems),
    intradayDdSource: pick(env, 'INTRADAY_DD_SOURCE', ['legacy', 'shadow', 'nl'] as const, 'shadow', problems),
    problems,
  };
}

/** One log line describing the flags in force. */
export function describeRollout(f: RolloutFlags): string {
  return `DRIFT_GATE=${f.driftGate} RISK_NAV_SOURCE=${f.riskNavSource} INTRADAY_DD_SOURCE=${f.intradayDdSource}`;
}
