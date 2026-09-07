/**
 * Where the model portfolio comes from, and when it must not be traded.
 *
 * Two jobs, both about the same failure. The model decides what the fund is
 * TRYING to hold; get it wrong and every downstream number — drift, the
 * rebalance gate, the deposit plan — is computed against a book nobody chose.
 * That failure is silent by nature, because a wrong model is still a
 * well-formed one.
 *
 *   1. Resolution order. A JSON targets file wins over the compiled private
 *      model, which wins over the sample. The file exists so weights can be
 *      published without a build: `local.ts` is TypeScript, the Pi cannot
 *      compile it, and that single fact is why changing weights needs a
 *      workstation deploy and why a deposit has to be bought BEFORE a reweight
 *      rather than sized against it.
 *
 *   2. Failing closed. The old loader was
 *      `loadLocalOverride() ?? SAMPLE_PORTFOLIO`, so a missing or corrupt
 *      local.js silently became the sample — different names, still summing to
 *      100, so validateTargets passed. The strategist would compute drift
 *      against a portfolio nobody holds and rebalance the real book into the
 *      template, sells included. Reachable from a fresh clone, since local.ts
 *      is gitignored and excluded from the deploy's rsync.
 *
 * Pure and injectable so the decision is testable without a filesystem: the
 * caller supplies the readers, this decides. Nothing here throws — a throw at
 * module load would take down every import site, including the public repo's
 * own tests. Problems are reported, and `validateTargets()` is what refuses.
 */
import type { HoldingTarget } from './types.js';

export type PortfolioSource = 'file' | 'local' | 'sample';

export interface ResolveOptions {
  /** Path to a JSON targets file. When set and readable, it wins. */
  filePath?: string | null;
  /** Reads the file; returns null when it does not exist. May throw on IO. */
  readFile?: (path: string) => string | null;
  /** The compiled private override, if the deployment has one. */
  loadLocal?: () => HoldingTarget[] | null;
  /** Last-resort template. Never traded when `requirePrivate` is set. */
  sample?: HoldingTarget[];
  /** The deployment asserts it has a real book — the sample must not trade. */
  requirePrivate?: boolean;
}

export interface ResolvedPortfolio {
  portfolio: HoldingTarget[];
  source: PortfolioSource;
  path?: string;
  /** Non-null when the resolved portfolio must NOT be traded. */
  problem: string | null;
}

const SLEEVES = new Set<HoldingTarget['sleeve']>([
  'tech_growth', 'industrials', 'healthcare', 'financials', 'defensive', 'hedge',
]);

/** Weights are floats; 33.33 x3 is a legitimate 100. */
const SUM_TOLERANCE = 0.01;

const SHAPE = 'each entry needs { symbol, name, pct, sleeve }';

/**
 * Validate raw JSON into a model portfolio, or throw saying exactly what is
 * wrong and where. Every rejection here is a trade that must not happen, so
 * this is deliberately strict: no coercion, no defaults, no repair.
 */
export function parseTargets(raw: unknown, where: string): HoldingTarget[] {
  const bad = (msg: string): never => {
    throw new Error(`${where}: ${msg}`);
  };

  if (!Array.isArray(raw)) {
    // The deposit targets file is a {symbol: pct} map and reaching for it here
    // is the obvious mistake; "not an array" would not help anyone.
    return bad(`expected an array of holdings — ${SHAPE}`);
  }
  if (raw.length === 0) return bad(`no holdings — ${SHAPE}`);

  const out: HoldingTarget[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const h = raw[i] as Record<string, unknown>;
    const at = `holding ${i + 1}`;
    if (h === null || typeof h !== 'object') bad(`${at}: not an object — ${SHAPE}`);

    const symbol = typeof h.symbol === 'string' ? h.symbol.trim() : '';
    if (!symbol) bad(`${at}: missing or blank symbol — ${SHAPE}`);
    if (seen.has(symbol)) bad(`${at}: duplicate symbol ${symbol}`);
    seen.add(symbol);

    if (typeof h.name !== 'string' || !h.name.trim()) {
      bad(`${at} (${symbol}): missing name — ${SHAPE}`);
    }
    if (typeof h.pct !== 'number' || !Number.isFinite(h.pct)) {
      bad(`${at} (${symbol}): pct must be a number — ${SHAPE}`);
    }
    if ((h.pct as number) <= 0) {
      bad(`${at} (${symbol}): pct must be greater than zero; drop the holding instead`);
    }
    if (typeof h.sleeve !== 'string' || !SLEEVES.has(h.sleeve as HoldingTarget['sleeve'])) {
      bad(`${at} (${symbol}): sleeve must be one of ${[...SLEEVES].join(', ')}`);
    }

    out.push({
      symbol,
      name: (h.name as string).trim(),
      pct: h.pct as number,
      sleeve: h.sleeve as HoldingTarget['sleeve'],
    });
  }

  const sum = out.reduce((s, t) => s + t.pct, 0);
  if (Math.abs(sum - 100) > SUM_TOLERANCE) {
    bad(`weights sum to ${sum}, expected 100`);
  }
  return out;
}

/**
 * Refuse to trade an unusable model. What `validateTargets()` delegates to.
 *
 * The message is passed through verbatim rather than summarised, because it
 * names the file and the holding that have to be fixed — and this throw is
 * likely to be read out of a log by someone who is not at their desk.
 */
export function assertTradable(r: ResolvedPortfolio): void {
  if (r.problem) throw new Error(`Model portfolio unusable: ${r.problem}`);
}

export function resolvePortfolio(o: ResolveOptions): ResolvedPortfolio {
  const sample = o.sample ?? [];
  const fallback = (problem: string): ResolvedPortfolio => ({
    // A usable array so import sites do not crash; `problem` is what stops the
    // trading, via validateTargets.
    portfolio: sample,
    source: 'sample',
    problem,
  });

  if (o.filePath) {
    let text: string | null = null;
    try {
      text = o.readFile ? o.readFile(o.filePath) : null;
    } catch (e) {
      // Unreadable is NOT absent. A permissions or IO error means the
      // operator's intended weights are unknown, which is a different thing
      // from "no file configured" and must not silently use older weights.
      return fallback(`${o.filePath}: could not be read (${(e as Error).message})`);
    }
    if (text !== null && text.trim() !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        return fallback(`${o.filePath}: not valid JSON (${(e as Error).message})`);
      }
      try {
        return {
          portfolio: parseTargets(parsed, o.filePath),
          source: 'file',
          path: o.filePath,
          problem: null,
        };
      } catch (e) {
        return fallback((e as Error).message);
      }
    }
    // Absent or empty: fall through. That is how a deployment that has not
    // adopted the file yet keeps working unchanged.
  }

  let local: HoldingTarget[] | null = null;
  try {
    local = o.loadLocal ? o.loadLocal() : null;
  } catch (e) {
    return fallback(`private model failed to load (${(e as Error).message})`);
  }
  if (local && local.length > 0) {
    // Validated like the file. local.ts is hand-edited TypeScript, and types
    // cannot catch a weight changed without changing another — that lands as
    // permanent drift the rebalancer chases every cycle but can never close.
    try {
      return {
        portfolio: parseTargets(local, 'src/portfolios/local.ts'),
        source: 'local',
        problem: null,
      };
    } catch (e) {
      return fallback((e as Error).message);
    }
  }

  return {
    portfolio: sample,
    source: 'sample',
    problem: o.requirePrivate
      ? 'no private model portfolio is loaded, and this deployment requires one '
        + '— refusing to trade the sample template'
      : null,
  };
}
