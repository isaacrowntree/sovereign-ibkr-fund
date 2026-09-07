import { describe, it, expect } from 'vitest';
import { parseTargets, resolvePortfolio, assertTradable, type ResolveOptions } from './resolve';
import type { HoldingTarget } from './types';

const LOCAL: HoldingTarget[] = [
  { symbol: 'AAA', name: 'Alpha', pct: 60, sleeve: 'tech_growth' },
  { symbol: 'BBB', name: 'Beta', pct: 40, sleeve: 'defensive' },
];
const SAMPLE: HoldingTarget[] = [
  { symbol: 'QQQ', name: 'Invesco QQQ', pct: 100, sleeve: 'tech_growth' },
];
const FILE: HoldingTarget[] = [
  { symbol: 'CCC', name: 'Gamma', pct: 70, sleeve: 'industrials' },
  { symbol: 'DDD', name: 'Delta', pct: 30, sleeve: 'hedge' },
];

function opts(over: Partial<ResolveOptions> = {}): ResolveOptions {
  return {
    filePath: null,
    readFile: () => null,
    loadLocal: () => LOCAL,
    sample: SAMPLE,
    requirePrivate: false,
    ...over,
  };
}

describe('parseTargets', () => {
  it('accepts a well-formed model', () => {
    expect(parseTargets(FILE, 'test')).toEqual(FILE);
  });

  it('trims whitespace around symbols rather than trading a padded one', () => {
    const p = parseTargets([{ ...FILE[0], symbol: ' CCC ' }, FILE[1]], 'test');
    expect(p[0].symbol).toBe('CCC');
  });

  // Every rejection below is a trade that must not happen. This file decides
  // what the fund's target book IS, so a malformed one is not a formatting
  // problem — it is a rebalance towards weights nobody chose.
  const bad: Array<[string, unknown]> = [
    ['not an array', { AAA: 60, BBB: 40 }],
    ['an empty array', []],
    ['a null', null],
    ['a missing symbol', [{ name: 'x', pct: 100, sleeve: 'hedge' }]],
    ['a blank symbol', [{ symbol: '  ', name: 'x', pct: 100, sleeve: 'hedge' }]],
    ['a non-string symbol', [{ symbol: 7, name: 'x', pct: 100, sleeve: 'hedge' }]],
    ['a missing name', [{ symbol: 'AAA', pct: 100, sleeve: 'hedge' }]],
    ['a missing pct', [{ symbol: 'AAA', name: 'x', sleeve: 'hedge' }]],
    ['a non-numeric pct', [{ symbol: 'AAA', name: 'x', pct: '100', sleeve: 'hedge' }]],
    ['a NaN pct', [{ symbol: 'AAA', name: 'x', pct: Number.NaN, sleeve: 'hedge' }]],
    ['a zero pct', [
      { symbol: 'AAA', name: 'x', pct: 0, sleeve: 'hedge' },
      { symbol: 'BBB', name: 'y', pct: 100, sleeve: 'hedge' },
    ]],
    ['a negative pct', [
      { symbol: 'AAA', name: 'x', pct: -10, sleeve: 'hedge' },
      { symbol: 'BBB', name: 'y', pct: 110, sleeve: 'hedge' },
    ]],
    ['an unknown sleeve', [{ symbol: 'AAA', name: 'x', pct: 100, sleeve: 'crypto' }]],
    ['weights that do not sum to 100', [
      { symbol: 'AAA', name: 'x', pct: 60, sleeve: 'hedge' },
      { symbol: 'BBB', name: 'y', pct: 30, sleeve: 'hedge' },
    ]],
    ['a duplicated symbol', [
      { symbol: 'AAA', name: 'x', pct: 50, sleeve: 'hedge' },
      { symbol: 'AAA', name: 'x again', pct: 50, sleeve: 'hedge' },
    ]],
  ];
  for (const [what, raw] of bad) {
    it(`rejects ${what}`, () => {
      expect(() => parseTargets(raw, 'targets.json')).toThrow();
    });
  }

  it('names the file in the error, because that is what has to be fixed', () => {
    expect(() => parseTargets([], '/fund-state/targets.json'))
      .toThrow(/fund-state\/targets\.json/);
  });

  it('points a symbol:pct map at the shape it actually wants', () => {
    // The deposit targets file uses that shape, and reaching for it here is
    // the obvious mistake. Saying "not an array" would not help.
    expect(() => parseTargets({ AAA: 60, BBB: 40 }, 'targets.json'))
      .toThrow(/symbol.*name.*pct.*sleeve/s);
  });

  it('tolerates float noise around 100', () => {
    expect(() => parseTargets([
      { symbol: 'AAA', name: 'x', pct: 33.33, sleeve: 'hedge' },
      { symbol: 'BBB', name: 'y', pct: 33.33, sleeve: 'hedge' },
      { symbol: 'CCC', name: 'z', pct: 33.34, sleeve: 'hedge' },
    ], 'targets.json')).not.toThrow();
  });
});

describe('resolvePortfolio precedence', () => {
  it('prefers the targets file, so weights can change without a deploy', () => {
    const r = resolvePortfolio(opts({
      filePath: '/fund-state/targets.json',
      readFile: () => JSON.stringify(FILE),
    }));
    expect(r.source).toBe('file');
    expect(r.portfolio).toEqual(FILE);
    expect(r.problem).toBeNull();
  });

  it('falls to the compiled private model when no file is configured', () => {
    const r = resolvePortfolio(opts());
    expect(r.source).toBe('local');
    expect(r.portfolio).toEqual(LOCAL);
    expect(r.problem).toBeNull();
  });

  it('falls to the private model when the file is configured but absent', () => {
    // Absent is not an error: it is how a deployment that has not adopted the
    // file yet keeps working.
    const r = resolvePortfolio(opts({ filePath: '/fund-state/targets.json' }));
    expect(r.source).toBe('local');
    expect(r.problem).toBeNull();
  });

  it('falls to the sample when there is no private model at all', () => {
    const r = resolvePortfolio(opts({ loadLocal: () => null }));
    expect(r.source).toBe('sample');
    expect(r.portfolio).toEqual(SAMPLE);
  });
});

describe('resolvePortfolio fails closed', () => {
  // THE LANDMINE. `TARGET_PORTFOLIO = loadLocalOverride() ?? SAMPLE_PORTFOLIO`
  // meant a missing or corrupt local.js silently became the sample — a book of
  // entirely different names that still sums to 100, so validateTargets passed.
  // The strategist would then compute drift against a portfolio nobody holds
  // and generate a full rebalance out of the real book into the template, with
  // sells. Nothing throws. It is reachable from a fresh clone, because local.ts
  // is gitignored and excluded from the deploy's rsync.
  it('refuses the sample when the deployment says it has a private book', () => {
    const r = resolvePortfolio(opts({ loadLocal: () => null, requirePrivate: true }));
    expect(r.source).toBe('sample');
    expect(r.problem).toMatch(/private/i);
  });

  it('says nothing is wrong with the sample when it is genuinely wanted', () => {
    const r = resolvePortfolio(opts({ loadLocal: () => null, requirePrivate: false }));
    expect(r.problem).toBeNull();
  });

  it('refuses an unparseable targets file rather than falling back', () => {
    // Falling back here would be the same silent divergence in a new place:
    // the operator edited the file to change the book, and a typo would leave
    // the fund trading the OLD weights while the file says otherwise.
    const r = resolvePortfolio(opts({
      filePath: '/fund-state/targets.json',
      readFile: () => '{ not json',
    }));
    expect(r.problem).toMatch(/targets\.json/);
  });

  it('refuses an invalid targets file rather than falling back', () => {
    const r = resolvePortfolio(opts({
      filePath: '/fund-state/targets.json',
      readFile: () => JSON.stringify([{ symbol: 'AAA', name: 'x', pct: 55, sleeve: 'hedge' }]),
    }));
    expect(r.problem).toMatch(/100/);
  });

  it('refuses when the targets file cannot be read at all', () => {
    // Unreadable is not absent. A permissions or IO error means the operator's
    // intended weights are unknown, which is not the same as "not configured".
    const r = resolvePortfolio(opts({
      filePath: '/fund-state/targets.json',
      readFile: () => { throw new Error('EACCES'); },
    }));
    expect(r.problem).toMatch(/EACCES|read/i);
  });

  it('refuses when the private model itself fails to load', () => {
    const r = resolvePortfolio(opts({
      loadLocal: () => { throw new Error('boom'); },
      requirePrivate: true,
    }));
    expect(r.problem).not.toBeNull();
  });

  it('refuses a private model whose weights do not sum to 100', () => {
    // local.ts is hand-edited TypeScript. Types cannot catch a weight that was
    // changed without changing another, and that lands as permanent drift the
    // rebalancer chases but can never close.
    const r = resolvePortfolio(opts({
      loadLocal: () => [{ symbol: 'AAA', name: 'x', pct: 55, sleeve: 'hedge' }],
    }));
    expect(r.problem).toMatch(/100/);
  });

  it('still reports a usable portfolio alongside a problem', () => {
    // Callers that only read weights must not crash on import; the refusal is
    // enforced by validateTargets, which every trading agent calls first.
    const r = resolvePortfolio(opts({
      filePath: '/fund-state/targets.json',
      readFile: () => '{ not json',
    }));
    expect(r.portfolio.length).toBeGreaterThan(0);
  });
});

describe('assertTradable', () => {
  // What validateTargets delegates to, so the refusal itself is tested without
  // needing an environment, a filesystem, or a module reload.
  it('passes a clean resolution', () => {
    expect(() => assertTradable(resolvePortfolio(opts()))).not.toThrow();
  });

  it('throws the problem verbatim, because it names the file to fix', () => {
    const r = resolvePortfolio(opts({
      filePath: '/fund-state/targets.json',
      readFile: () => '{ not json',
    }));
    expect(() => assertTradable(r)).toThrow(/targets\.json/);
  });

  it('throws for the sample when a private book was required', () => {
    const r = resolvePortfolio(opts({ loadLocal: () => null, requirePrivate: true }));
    expect(() => assertTradable(r)).toThrow(/private/i);
  });
});
