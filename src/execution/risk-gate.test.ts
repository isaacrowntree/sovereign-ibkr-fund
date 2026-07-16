import { describe, it, expect } from 'vitest';
import { evaluateRiskGate } from './risk-gate.js';

const NOW = new Date('2026-07-16T12:00:00Z');
const HOUR = 3_600_000;
const STALE = 5 * HOUR;

const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();

const gate = (over: Partial<Parameters<typeof evaluateRiskGate>[0]> = {}) =>
  evaluateRiskGate({ drawdownLevel: 'normal', lastRiskAt: at(0), now: NOW, staleMs: STALE, ...over });

describe('risk gate: allows trading', () => {
  it.each(['normal', 'warning', 'derisking'])('permits level=%s on fresh data', (level) => {
    const d = gate({ drawdownLevel: level });
    expect(d.allowed).toBe(true);
  });

  it('permits data right at the staleness boundary', () => {
    expect(gate({ lastRiskAt: at(5) }).allowed).toBe(true);
  });
});

describe('risk gate: fails safe', () => {
  it('blocks when risk-manager has never produced a level', () => {
    const d = gate({ drawdownLevel: undefined });
    expect(d).toMatchObject({ allowed: false, reason: 'missing' });
  });

  it('blocks when there is no timestamp', () => {
    expect(gate({ lastRiskAt: undefined })).toMatchObject({ allowed: false, reason: 'missing' });
  });

  it('blocks on an unparseable timestamp rather than assuming it is fine', () => {
    expect(gate({ lastRiskAt: 'garbage' })).toMatchObject({ allowed: false, reason: 'stale' });
  });

  it('blocks on a FUTURE timestamp — a clock step is not freshness', () => {
    // The Pi has no RTC and steps on NTP sync, so this is reachable.
    expect(gate({ lastRiskAt: at(-3) })).toMatchObject({ allowed: false, reason: 'stale' });
  });

  it('blocks just past the staleness boundary', () => {
    const d = gate({ lastRiskAt: at(5.1) });
    expect(d).toMatchObject({ allowed: false, reason: 'stale' });
    expect((d as { detail: string }).detail).toContain('5.1h old');
  });

  it('blocks on a hard stop even when the data is fresh', () => {
    expect(gate({ drawdownLevel: 'stopped' })).toMatchObject({ allowed: false, reason: 'stopped' });
  });

  it('reports stale BEFORE stopped — you cannot trust a stale level either way', () => {
    // Both conditions hold; the block reason should name the data problem,
    // because a 6h-old 'stopped' tells you nothing about the level right now.
    expect(gate({ drawdownLevel: 'stopped', lastRiskAt: at(6) })).toMatchObject({ reason: 'stale' });
  });

  it('carries the level through on a block, so the alert can report it', () => {
    expect(gate({ drawdownLevel: 'derisking', lastRiskAt: at(9) })).toMatchObject({ level: 'derisking' });
  });
});

/**
 * The tolerance boundary, stated explicitly rather than left implicit.
 *
 * These pin the CONSEQUENCE of staleMs vs the risk-manager cadence C, so the
 * trade-off is visible in the test output instead of buried in a constant.
 */
describe('risk gate: staleness tolerance vs agent cadence', () => {
  const C = 4 * HOUR; // built-in scheduler's cadence

  it('staleMs=5h with C=4h TOLERATES one missed risk run (trades on stale data)', () => {
    // risk ran at t-4h and then failed; execution runs now.
    const d = evaluateRiskGate({ drawdownLevel: 'normal', lastRiskAt: at(4), now: NOW, staleMs: STALE });
    expect(d.allowed, 'this is the known gap: one failure still trades').toBe(true);
  });

  it('staleMs=5h with C=4h blocks by the SECOND missed run', () => {
    const d = evaluateRiskGate({ drawdownLevel: 'normal', lastRiskAt: at(8), now: NOW, staleMs: STALE });
    expect(d.allowed).toBe(false);
  });

  it('staleMs below the cadence catches the FIRST missed run', () => {
    const d = evaluateRiskGate({ drawdownLevel: 'normal', lastRiskAt: at(4), now: NOW, staleMs: C / 2 });
    expect(d.allowed).toBe(false);
  });

  it('staleMs far below the cadence would block NORMAL operation — why we do not guess', () => {
    // Under paperclip the real cadence is unknown; if it were 6h, a 2h window
    // would halt the fund permanently. Loosening is survivable, tightening is not.
    const d = evaluateRiskGate({ drawdownLevel: 'normal', lastRiskAt: at(0.5), now: NOW, staleMs: 10 * 60_000 });
    expect(d.allowed, 'a too-tight window blocks even a healthy fund').toBe(false);
  });
});
