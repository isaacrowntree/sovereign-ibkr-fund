import { readFileSync } from 'node:fs';
import type { HoldingTarget } from './types.js';
import { SAMPLE_PORTFOLIO } from './sample.js';
import { resolvePortfolio, assertTradable, type PortfolioSource } from './resolve.js';

export type { HoldingTarget } from './types.js';
export { SAMPLE_PORTFOLIO } from './sample.js';
export { parseTargets, type PortfolioSource } from './resolve.js';

/**
 * Optional private override. `src/portfolios/local.ts` (compiled to `./local.js`)
 * is gitignored and absent from the public repo — so this `require` simply fails
 * and we fall back to the sample. Private deployments add a `local.ts` exporting
 * `LOCAL_PORTFOLIO` (or a default export) with their real book. See
 * `local.example.ts`.
 *
 * A MISSING module is a legitimate state (the public repo). A module that
 * exists and fails to load is not, so that error is re-thrown for
 * resolvePortfolio to turn into a refusal — swallowing it is how a corrupt
 * build used to become the sample portfolio silently.
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
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return null;
    throw e;
  }
}

/** ENOENT is "not configured"; anything else is a real failure to read. */
function readTargetsFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * PORTFOLIO_TARGETS_FILE lets the model be DATA rather than code.
 *
 * `local.ts` is TypeScript, and the Pi cannot compile it — that one fact is why
 * changing a weight needs a workstation build and a deploy, and therefore why a
 * deposit has to be bought before a reweight instead of being sized against it.
 * Point this at a JSON file on the state volume and weights can be published
 * without a build.
 *
 * REQUIRE_PRIVATE_PORTFOLIO asserts that this deployment has a real book, so
 * the sample template can never be traded by accident.
 */
const resolved = resolvePortfolio({
  filePath: process.env.PORTFOLIO_TARGETS_FILE || null,
  readFile: readTargetsFile,
  loadLocal: loadLocalOverride,
  sample: SAMPLE_PORTFOLIO,
  requirePrivate: process.env.REQUIRE_PRIVATE_PORTFOLIO === 'true',
});

/** The active model portfolio: targets file, else private override, else sample. */
export const TARGET_PORTFOLIO: HoldingTarget[] = resolved.portfolio;

/** Where it came from — surfaced by the status server so this is never a guess. */
export const portfolioSource: PortfolioSource = resolved.source;

/** Path of the targets file in effect, when one is. */
export const portfolioPath: string | undefined = resolved.path;

/** Non-null when the model must NOT be traded. `validateTargets()` enforces it. */
export const portfolioProblem: string | null = resolved.problem;

/** True when a private model is in effect (not the sample template). */
export const usingLocalPortfolio = resolved.source !== 'sample';

/**
 * Throw unless the active model portfolio is safe to trade.
 *
 * Every agent that can generate an order calls this before doing so. It used to
 * check only that weights sum to 100 — which the sample template also does, so
 * it passed in exactly the case that mattered.
 */
export function validateTargets(): void {
  assertTradable(resolved);
}
