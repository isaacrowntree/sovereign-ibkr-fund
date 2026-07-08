import type { HoldingTarget } from './types.js';
import { SAMPLE_PORTFOLIO } from './sample.js';

export type { HoldingTarget } from './types.js';
export { SAMPLE_PORTFOLIO } from './sample.js';

/**
 * Optional private override. `src/portfolios/local.ts` (compiled to `./local.js`)
 * is gitignored and absent from the public repo — so this `require` simply fails
 * and we fall back to the sample. Private deployments add a `local.ts` exporting
 * `LOCAL_PORTFOLIO` (or a default export) with their real book. See
 * `local.example.ts`.
 */
function loadLocalOverride(): HoldingTarget[] | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./local.js') as {
      LOCAL_PORTFOLIO?: HoldingTarget[];
      default?: HoldingTarget[];
    };
    const p = mod.LOCAL_PORTFOLIO ?? mod.default;
    return Array.isArray(p) && p.length > 0 ? p : null;
  } catch {
    return null; // no override present — use the sample
  }
}

/** The active model portfolio: private override if present, else the sample. */
export const TARGET_PORTFOLIO: HoldingTarget[] = loadLocalOverride() ?? SAMPLE_PORTFOLIO;

/** True when a private `local.ts` override is in effect (not the sample). */
export const usingLocalPortfolio = TARGET_PORTFOLIO !== SAMPLE_PORTFOLIO;

/** Throw unless the active portfolio's weights sum to 100%. */
export function validateTargets(): void {
  const sum = TARGET_PORTFOLIO.reduce((s, t) => s + t.pct, 0);
  if (Math.abs(sum - 100) > 0.01) {
    throw new Error(`Target allocations sum to ${sum}%, expected 100%`);
  }
}
