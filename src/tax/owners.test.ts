import { describe, it, expect } from 'vitest';
import { parseOwnerShares, ownersFromEnv, DEFAULT_OWNER_SHARES } from './owners';

describe('TAX_OWNER_SHARES', () => {
  it('defaults to a single beneficial owner at 100%', () => {
    expect(parseOwnerShares(undefined)).toEqual(DEFAULT_OWNER_SHARES);
    expect(ownersFromEnv({})).toEqual({ owners: DEFAULT_OWNER_SHARES, registration: 'individual' });
  });

  it('parses a split and requires 100% in total', () => {
    expect(parseOwnerShares('Owner A:60, Owner B:40')).toEqual([
      { name: 'Owner A', share: 0.6 }, { name: 'Owner B', share: 0.4 },
    ]);
    expect(() => parseOwnerShares('Owner A:60,Owner B:30')).toThrow(/sum to 90/);
    expect(() => parseOwnerShares('Owner A')).toThrow(/Name:percent/);
    expect(() => parseOwnerShares('A:50,A:50')).toThrow(/twice/);
  });

  it('drops a 0% owner (a joint holder with no beneficial interest)', () => {
    expect(parseOwnerShares('Owner A:100,Owner B:0')).toEqual([{ name: 'Owner A', share: 1 }]);
  });

  it('validates the registration', () => {
    expect(ownersFromEnv({ TAX_ACCOUNT_REGISTRATION: 'joint' }).registration).toBe('joint');
    expect(() => ownersFromEnv({ TAX_ACCOUNT_REGISTRATION: 'trust' })).toThrow();
  });
});
