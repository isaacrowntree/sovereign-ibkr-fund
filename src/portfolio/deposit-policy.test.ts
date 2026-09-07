import { describe, it, expect } from 'vitest';
import { parseDepositPolicy, decideDeposit, type DepositDecisionInput } from './deposit-policy';

const NOW = new Date('2026-09-10T12:00:00Z');
const RAW = {
  directed: ['NET', 'XLE', 'VST'],
  minDeployUsd: 1000,
  reserveUsd: 150,
  expiresAt: '2026-10-01T00:00:00Z',
};

function input(over: Partial<DepositDecisionInput> = {}): DepositDecisionInput {
  return {
    policy: parseDepositPolicy(RAW, 'deposit-policy.json'),
    settledCashUsd: 5402.97,
    cashThresholdUsd: 1000,
    now: NOW,
    ...over,
  };
}

describe('parseDepositPolicy', () => {
  it('accepts a well-formed policy', () => {
    const p = parseDepositPolicy(RAW, 'deposit-policy.json');
    expect(p.directed).toEqual(['NET', 'XLE', 'VST']);
    expect(p.reserveUsd).toBe(150);
  });

  it('accepts a policy with no directed names — greedy fill is still better', () => {
    expect(parseDepositPolicy({ ...RAW, directed: [] }, 'p.json').directed).toEqual([]);
  });

  it('defaults the reserve rather than spending every last dollar', () => {
    const p = parseDepositPolicy({ directed: [], expiresAt: RAW.expiresAt }, 'p.json');
    expect(p.reserveUsd).toBeGreaterThan(0);
  });

  // An expiry is REQUIRED. A standing instruction that never lapses is how a
  // deposit six months from now gets deployed against intentions from today.
  it('requires an expiry', () => {
    expect(() => parseDepositPolicy({ directed: ['NET'] }, 'p.json')).toThrow(/expiresAt/);
  });

  it('rejects an unparseable expiry rather than treating it as forever', () => {
    expect(() => parseDepositPolicy({ ...RAW, expiresAt: 'soon' }, 'p.json')).toThrow(/expiresAt/);
  });

  const bad: Array<[string, unknown]> = [
    ['a non-object', []],
    ['a null', null],
    ['non-array directed', { ...RAW, directed: 'NET' }],
    ['a blank directed name', { ...RAW, directed: ['NET', ' '] }],
    ['a non-string directed name', { ...RAW, directed: ['NET', 7] }],
    ['a duplicated directed name', { ...RAW, directed: ['NET', 'NET'] }],
    ['a negative reserve', { ...RAW, reserveUsd: -1 }],
    ['a negative floor', { ...RAW, minDeployUsd: -1 }],
  ];
  for (const [what, raw] of bad) {
    it(`rejects ${what}`, () => {
      expect(() => parseDepositPolicy(raw, 'deposit-policy.json')).toThrow();
    });
  }

  it('names the file in the error', () => {
    expect(() => parseDepositPolicy(null, '/fund-state/deposit-policy.json'))
      .toThrow(/deposit-policy\.json/);
  });

  it('uppercases and trims directed symbols so they match the model', () => {
    expect(parseDepositPolicy({ ...RAW, directed: [' net '] }, 'p.json').directed).toEqual(['NET']);
  });
});

describe('decideDeposit', () => {
  it('directs the deployment when there is settled cash and a live policy', () => {
    const d = decideDeposit(input());
    expect(d.directed).toBe(true);
    expect(d.deployableUsd).toBeCloseTo(5402.97 - 1000, 2);
    expect(d.reason).toMatch(/policy/i);
  });

  it('leaves the ordinary path alone when there is no policy', () => {
    const d = decideDeposit(input({ policy: null }));
    expect(d.directed).toBe(false);
    expect(d.reason).toMatch(/no deposit policy/i);
  });

  it('leaves the ordinary path alone once the policy has expired', () => {
    // Not an error: an expired standing instruction just stops standing.
    const d = decideDeposit(input({ now: new Date('2026-10-02T00:00:00Z') }));
    expect(d.directed).toBe(false);
    expect(d.reason).toMatch(/expired/i);
  });

  it('does nothing at all below the cash threshold', () => {
    const d = decideDeposit(input({ settledCashUsd: 400 }));
    expect(d.directed).toBe(false);
    expect(d.deployableUsd).toBe(0);
  });

  // THE POINT OF USING SETTLED CASH. An unsettled deposit is visible in
  // cashbalance but cannot fund a buy; deploying against it stages orders the
  // executor then defers, silently.
  it('waits for the deposit to settle', () => {
    const d = decideDeposit(input({ settledCashUsd: 1790.34 }));
    expect(d.deployableUsd).toBeCloseTo(790.34, 2);
  });

  it('holds off entirely when the plan would fall under the policy floor', () => {
    // minDeployUsd is the operator saying "this is not the deposit I meant".
    const d = decideDeposit(input({ settledCashUsd: 1500 }));
    expect(d.directed).toBe(false);
    expect(d.reason).toMatch(/floor|below/i);
  });

  it('never returns a negative deployable', () => {
    expect(decideDeposit(input({ settledCashUsd: 0 })).deployableUsd).toBe(0);
  });
});
