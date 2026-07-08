import type { HoldingTarget } from './types.js';

/**
 * PRIVATE PORTFOLIO OVERRIDE — template.
 *
 * To run your own allocation instead of the sample:
 *   1. Copy this file to `local.ts` (which is gitignored — it never leaves your
 *      machine and is never published).
 *   2. Replace the holdings below with your real book. Weights must sum to 100.
 *   3. `npm run build` — the loader picks up `local.ts` automatically.
 *
 * This `.example` file is NOT loaded; only `local.ts` is.
 */
export const LOCAL_PORTFOLIO: HoldingTarget[] = [
  { symbol: 'VTI', name: 'Vanguard Total US Market', pct: 60, sleeve: 'tech_growth' },
  { symbol: 'BND', name: 'Vanguard Total Bond',      pct: 40, sleeve: 'hedge' },
];
