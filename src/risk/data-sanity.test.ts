import { describe, it, expect } from 'vitest';
import { navSanityViolation, priceSanityViolations, orderCapViolation } from './data-sanity.js';

const navCfg = { minNavUsd: 1000, maxNavMovePct: 35 };

describe('navSanityViolation', () => {
  it('accepts a normal NAV', () => {
    expect(navSanityViolation(29156, 29000, navCfg)).toBeNull();
  });
  it('rejects a zeroed / non-positive NAV (the liquidation trigger)', () => {
    expect(navSanityViolation(0, 29000, navCfg)).toMatch(/non-positive/);
    expect(navSanityViolation(-5, 29000, navCfg)).toMatch(/non-positive/);
    expect(navSanityViolation(NaN, 29000, navCfg)).toMatch(/NaN/);
  });
  it('rejects NAV below the floor', () => {
    expect(navSanityViolation(500, 29000, navCfg)).toMatch(/below floor/);
  });
  it('rejects an implausible jump vs last NAV', () => {
    expect(navSanityViolation(15000, 29000, navCfg)).toMatch(/moved 48%/); // -48%
    expect(navSanityViolation(50000, 29000, navCfg)).toMatch(/moved/);     // +72%
  });
  it('allows a move within threshold, and any value on the first run', () => {
    expect(navSanityViolation(32000, 29000, navCfg)).toBeNull(); // +10%
    expect(navSanityViolation(29156, undefined, navCfg)).toBeNull();
  });
});

describe('priceSanityViolations', () => {
  const last = new Map([['NET', 242], ['TLT', 85.5], ['AVGO', 362]]);
  it('passes normal prices', () => {
    const cur = new Map([['NET', 243], ['TLT', 85.6], ['AVGO', 360]]);
    expect(priceSanityViolations(cur, last, 30)).toEqual([]);
  });
  it('flags a zero/missing price', () => {
    const cur = new Map([['NET', 0], ['TLT', 85.5]]);
    const bad = priceSanityViolations(cur, last, 30);
    expect(bad.map(b => b.symbol)).toEqual(['NET']);
  });
  it('flags the 100x-low tick (huge-qty trigger)', () => {
    const cur = new Map([['AVGO', 3.62]]); // 362 → 3.62
    const bad = priceSanityViolations(cur, last, 30);
    expect(bad[0].symbol).toBe('AVGO');
    expect(bad[0].reason).toMatch(/moved/);
  });
  it('does not flag a first-seen symbol with a positive price', () => {
    const cur = new Map([['NEW', 100]]);
    expect(priceSanityViolations(cur, last, 30)).toEqual([]);
  });
});

describe('orderCapViolation', () => {
  const caps = { maxOrderNotionalUsd: 15000, maxOrderPctNav: 50, maxRunNotionalUsd: 60000 };
  it('passes the real NET sell (~$10.9k, ~37% of $29k NAV)', () => {
    expect(orderCapViolation(10926, 29156, 0, caps)).toBeNull();
  });
  it('rejects an order over the absolute $ cap', () => {
    expect(orderCapViolation(20000, 29156, 0, caps)).toMatch(/> cap \$15000/);
  });
  it('rejects an order over the %-of-NAV cap', () => {
    expect(orderCapViolation(14000, 20000, 0, caps)).toMatch(/% of NAV/); // 70% of NAV
  });
  it('rejects when the running total would exceed the per-run cap', () => {
    expect(orderCapViolation(5000, 29156, 58000, caps)).toMatch(/would exceed/);
  });
});
