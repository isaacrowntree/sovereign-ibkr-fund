import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDepositPolicy, resetDepositPolicyCache } from './deposit-policy-file';

const DIR = mkdtempSync(join(tmpdir(), 'deposit-policy-'));
const FILE = join(DIR, 'deposit-policy.json');
const VALID = {
  directed: ['NET', 'XLE'],
  minDeployUsd: 1000,
  reserveUsd: 150,
  expiresAt: '2099-01-01T00:00:00Z',
};

function write(body: string): void {
  writeFileSync(FILE, body);
  process.env.DEPOSIT_POLICY_FILE = FILE;
  resetDepositPolicyCache();
}

beforeEach(() => {
  delete process.env.DEPOSIT_POLICY_FILE;
  resetDepositPolicyCache();
});
afterEach(() => {
  delete process.env.DEPOSIT_POLICY_FILE;
  resetDepositPolicyCache();
});

describe('loadDepositPolicy', () => {
  it('returns null when no policy file is configured', () => {
    expect(loadDepositPolicy()).toBeNull();
  });

  it('returns null when the configured file does not exist', () => {
    // Absent is simply "no instruction" — the ordinary cash-flow path, which
    // is what every existing deployment gets.
    process.env.DEPOSIT_POLICY_FILE = join(DIR, 'nope.json');
    expect(loadDepositPolicy()).toBeNull();
  });

  it('returns null for an empty file', () => {
    write('');
    expect(loadDepositPolicy()).toBeNull();
  });

  it('loads a valid policy', () => {
    write(JSON.stringify(VALID));
    expect(loadDepositPolicy()?.directed).toEqual(['NET', 'XLE']);
  });

  // Fails CLOSED. Falling through to the ordinary path would deploy the money
  // pro-rata while the operator believes their directed instruction is in
  // force — the cash moves, into the wrong names, and nothing says so.
  it('throws rather than silently ignoring a malformed policy', () => {
    write('{ not json');
    expect(() => loadDepositPolicy()).toThrow(/not valid JSON/);
  });

  it('throws rather than silently ignoring an invalid policy', () => {
    write(JSON.stringify({ directed: ['NET'] }));   // no expiresAt
    expect(() => loadDepositPolicy()).toThrow(/expiresAt/);
  });

  it('names the file in the error, because that is what has to be fixed', () => {
    write('{ not json');
    expect(() => loadDepositPolicy()).toThrow(new RegExp(FILE.replace(/[/\\]/g, '.')));
  });

  it('caches so a strategist run does not re-read it per call', () => {
    write(JSON.stringify(VALID));
    const a = loadDepositPolicy();
    writeFileSync(FILE, '{ not json');
    expect(loadDepositPolicy()).toBe(a);
  });
});
