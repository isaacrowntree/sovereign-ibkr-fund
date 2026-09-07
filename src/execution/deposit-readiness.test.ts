import { describe, it, expect } from 'vitest';
import { evaluateReadiness, type ReadinessInput } from './deposit-readiness';

function ok(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    authenticated: true,
    usdCash: 5392,
    audCash: 14.06,
    audToUsdRate: 0.72,
    minDeployUsd: 5000,
    plannedDeployUsd: 5204,
    pendingOrderCount: 0,
    maxDriftPct: 4.55,
    driftThresholdPct: 10,
    missingPrices: [],
    executionWindowOpen: true,
    snapshotAgeMinutes: 3,
    ...over,
  };
}
const codes = (i: ReadinessInput) => evaluateReadiness(i).blockers.map(b => b.code);

describe('evaluateReadiness', () => {
  it('passes when everything lines up', () => {
    const r = evaluateReadiness(ok());
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it('blocks when the gateway is not authenticated', () => {
    expect(codes(ok({ authenticated: false }))).toContain('not_authenticated');
  });

  it('blocks when idle AUD is large enough to be the unconverted deposit', () => {
    // The whole point: AUD sits in its own ledger bucket and funds nothing.
    const r = evaluateReadiness(ok({ audCash: 5014, usdCash: 1790, plannedDeployUsd: 1605 }));
    expect(r.blockers.map(b => b.code)).toContain('unconverted_aud');
    expect(r.ready).toBe(false);
  });

  it('does not flag trivial AUD residue as an unconverted deposit', () => {
    expect(codes(ok({ audCash: 14.06 }))).not.toContain('unconverted_aud');
  });

  it('blocks when the plan falls short of the deploy floor', () => {
    expect(codes(ok({ plannedDeployUsd: 1605 }))).toContain('under_deploy');
  });

  it('treats an absent floor as no floor', () => {
    expect(codes(ok({ minDeployUsd: null, plannedDeployUsd: 12 }))).not.toContain('under_deploy');
  });

  it('blocks when a queue already exists — never stack orders', () => {
    expect(codes(ok({ pendingOrderCount: 3 }))).toContain('orders_queued');
  });

  it('blocks when drift is at or over the rebalance threshold', () => {
    // At/over threshold the gate leaves within-threshold: sells, or a blocked
    // cooldown. Either way this is not the quiet path the plan assumes.
    expect(codes(ok({ maxDriftPct: 10 }))).toContain('drift_gate');
    expect(codes(ok({ maxDriftPct: 12 }))).toContain('drift_gate');
    expect(codes(ok({ maxDriftPct: 9.9 }))).not.toContain('drift_gate');
  });

  it('blocks when a target name has no resolvable price', () => {
    const r = evaluateReadiness(ok({ missingPrices: ['XLE'] }));
    expect(r.blockers.map(b => b.code)).toContain('missing_prices');
    expect(r.blockers.find(b => b.code === 'missing_prices')!.detail).toContain('XLE');
  });

  it('blocks outside the execution window', () => {
    expect(codes(ok({ executionWindowOpen: false }))).toContain('market_closed');
  });

  it('blocks on a stale snapshot — the plan is sized from it', () => {
    expect(codes(ok({ snapshotAgeMinutes: 240 }))).toContain('stale_snapshot');
    expect(codes(ok({ snapshotAgeMinutes: 10 }))).not.toContain('stale_snapshot');
  });

  it('reports every blocker at once, not just the first', () => {
    const r = evaluateReadiness(ok({
      authenticated: false, pendingOrderCount: 2, executionWindowOpen: false,
    }));
    expect(r.blockers.length).toBeGreaterThanOrEqual(3);
    expect(r.ready).toBe(false);
  });

  it('every blocker carries a human-readable fix', () => {
    const r = evaluateReadiness(ok({
      authenticated: false, audCash: 5014, pendingOrderCount: 1,
      executionWindowOpen: false, missingPrices: ['VST'], snapshotAgeMinutes: 999,
      plannedDeployUsd: 10, maxDriftPct: 15,
    }));
    for (const b of r.blockers) {
      expect(b.fix.length).toBeGreaterThan(10);
      expect(b.message.length).toBeGreaterThan(10);
    }
  });
});
