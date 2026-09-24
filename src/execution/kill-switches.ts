/**
 * Kill switches the execution path reads. Pure: env and state are passed in,
 * so each one is testable and the defaults are pinned in one place.
 *
 *   EXECUTION_ENABLED   env, and `executionEnabled` in state (the hub toggle).
 *                       Either one off stops placement — at run start, and
 *                       before every order so a toggle mid-run takes effect
 *                       at the next placement. Default on.
 *   RUN_BUDGET_SEC      wall-clock budget for one run, default 240 s, 0 = off.
 *                       The orchestrator kills a run that overstays, and a
 *                       kill between placing and confirming is the worst
 *                       moment to die, so a run stops placing once the budget
 *                       left cannot cover the next order's fill wait.
 */

const OFF = new Set(['0', 'false', 'off', 'no']);

/** Why execution is switched off, or null when it is on. */
export function executionDisabledReason(
  env: NodeJS.ProcessEnv,
  stateFlag: unknown,
): string | null {
  const v = (env.EXECUTION_ENABLED ?? '').trim().toLowerCase();
  if (OFF.has(v)) return 'execution disabled (EXECUTION_ENABLED=0)';
  // Only an explicit false switches it off: a missing key is the default (on).
  if (stateFlag === false) return 'execution paused (executionEnabled=false in state)';
  return null;
}

/** RUN_BUDGET_SEC in ms; 0 means no budget. */
export function runBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RUN_BUDGET_SEC;
  if (raw === undefined || raw.trim() === '') return 240_000;
  const s = parseFloat(raw);
  return Number.isFinite(s) && s > 0 ? s * 1000 : 0;
}

/** Margin kept free after an order's fill wait, before the budget runs out. */
export const RUN_BUDGET_MARGIN_MS = 15_000;
