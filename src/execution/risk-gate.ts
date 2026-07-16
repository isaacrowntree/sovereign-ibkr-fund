/**
 * The risk gate — may execution trade right now?
 *
 * Pure and separately testable, because this is the single decision standing
 * between a garbled/absent risk assessment and real orders. It was previously
 * inline in execution-bot with no direct test.
 *
 * ## The staleness window, and why it is not tightened by default
 *
 * The gate blocks when risk data is older than `staleMs`. That tolerance
 * interacts with the risk-manager's cadence C:
 *
 *   staleMs > C   → one missed risk run still passes (you trade on the
 *                   PREVIOUS cycle's level for one round)
 *   staleMs < C   → a single missed run blocks, but a merely SLOW run can too
 *   staleMs << C  → normal operation blocks — the fund stops trading entirely
 *
 * The default (5h) is deliberately > the built-in scheduler's 4h, so it only
 * trips after risk-manager has missed roughly a full cycle. That means a single
 * risk-manager failure DOES trade one round on stale data — a real gap, but the
 * safe direction to be wrong in without knowing C.
 *
 * In production paperclip is the scheduler, so C is NOT the SCHEDULE array's
 * 4h and is not knowable from this repo. Tightening blind is dangerous in a way
 * loosening isn't: too tight halts all trading. So the value is env-tunable
 * (`RISK_STALE_HOURS`) rather than guessed — set it to roughly C/2 once C is
 * confirmed on the Pi.
 */

export type DrawdownLevel = 'normal' | 'warning' | 'derisking' | 'stopped';

export interface RiskGateInput {
  /** `state.drawdownLevel` — undefined when risk-manager has never run. */
  drawdownLevel?: string;
  /** `state.lastRiskAt` ISO timestamp — undefined when risk-manager has never run. */
  lastRiskAt?: string;
  /** Evaluation instant. */
  now: Date;
  /** Max age of risk data before it is refused. */
  staleMs: number;
}

export type RiskGateDecision =
  | { allowed: true; level: DrawdownLevel }
  | { allowed: false; reason: 'missing' | 'stale' | 'stopped'; detail: string; level?: string };

/**
 * FAIL SAFE: anything other than fresh, parseable, non-stopped risk data blocks.
 * Never infer "probably fine" — an unreadable timestamp is not evidence of safety.
 */
export function evaluateRiskGate(input: RiskGateInput): RiskGateDecision {
  const { drawdownLevel, lastRiskAt, now, staleMs } = input;

  if (!drawdownLevel) {
    return { allowed: false, reason: 'missing', detail: 'risk-manager has not produced a drawdown level' };
  }
  if (!lastRiskAt) {
    return { allowed: false, reason: 'missing', detail: 'no lastRiskAt timestamp', level: drawdownLevel };
  }

  const at = new Date(lastRiskAt).getTime();
  if (Number.isNaN(at)) {
    return { allowed: false, reason: 'stale', detail: `unparseable lastRiskAt (${lastRiskAt})`, level: drawdownLevel };
  }

  const ageMs = now.getTime() - at;
  // A FUTURE timestamp means a clock step or a corrupted write — not freshness.
  // The Pi has no RTC and steps on NTP sync, so this is reachable.
  if (ageMs < 0) {
    return {
      allowed: false,
      reason: 'stale',
      detail: `lastRiskAt is in the future (${lastRiskAt}) — clock step?`,
      level: drawdownLevel,
    };
  }
  if (ageMs > staleMs) {
    const hrs = (ageMs / 3_600_000).toFixed(1);
    return {
      allowed: false,
      reason: 'stale',
      detail: `risk assessment is ${hrs}h old (limit ${(staleMs / 3_600_000).toFixed(1)}h)`,
      level: drawdownLevel,
    };
  }

  if (drawdownLevel === 'stopped') {
    return { allowed: false, reason: 'stopped', detail: 'drawdown level is STOPPED', level: drawdownLevel };
  }

  return { allowed: true, level: drawdownLevel as DrawdownLevel };
}
