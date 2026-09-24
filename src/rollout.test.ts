import { describe, it, expect } from 'vitest';
import { readRolloutFlags, describeRollout } from './rollout.js';

describe('rollout flags', () => {
  it('defaults to what production did before the review (dark)', () => {
    const f = readRolloutFlags({});
    expect(f.driftGate).toBe('legacy');
    expect(f.riskNavSource).toBe('legacy');
    expect(f.intradayDdSource).toBe('shadow');
    expect(f.problems).toEqual([]);
  });

  it('reads explicit values, case- and whitespace-insensitive', () => {
    const f = readRolloutFlags({ DRIFT_GATE: ' Bands ', RISK_NAV_SOURCE: 'units', INTRADAY_DD_SOURCE: 'NL' });
    expect(f).toMatchObject({ driftGate: 'bands', riskNavSource: 'units', intradayDdSource: 'nl' });
  });

  it('a typo can never switch anything on: it falls back to the default and is reported', () => {
    const f = readRolloutFlags({ DRIFT_GATE: 'band', RISK_NAV_SOURCE: 'unit', INTRADAY_DD_SOURCE: 'nll' });
    expect(f.driftGate).toBe('legacy');
    expect(f.riskNavSource).toBe('legacy');
    expect(f.intradayDdSource).toBe('shadow');
    expect(f.problems).toHaveLength(3);
    expect(f.problems[0]).toContain("DRIFT_GATE='band'");
  });

  it('empty string is unset, not a problem', () => {
    expect(readRolloutFlags({ DRIFT_GATE: '' }).problems).toEqual([]);
  });

  it('describes itself in one line', () => {
    expect(describeRollout(readRolloutFlags({}))).toBe(
      'DRIFT_GATE=legacy RISK_NAV_SOURCE=legacy INTRADAY_DD_SOURCE=shadow',
    );
  });
});
