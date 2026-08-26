import { describe, it, expect } from 'vitest';
import { planRecovery, type SessionHealth } from './recovery-plan.js';

const UP: SessionHealth = { authenticated: true, connected: true };
const DOWN: SessionHealth = { authenticated: false, connected: false };
const HALF: SessionHealth = { authenticated: true, connected: false };

describe('planRecovery', () => {
  it('does nothing when the session is healthy and nothing was forced', () => {
    expect(planRecovery(UP, false)).toEqual({ action: 'nothing-to-do' });
  });

  it('tries the silent ladder first when the session is merely unhealthy', () => {
    // The common case, several times a day: the iserver half dropped and the
    // SSO session behind it is alive. Recoverable with no push.
    expect(planRecovery(DOWN, false)).toEqual({ action: 'silent-then-credential' });
  });

  it('treats authenticated-but-disconnected as unhealthy', () => {
    expect(planRecovery(HALF, false)).toEqual({ action: 'silent-then-credential' });
  });

  // ── the regression this file exists for ────────────────────────────────────
  //
  // --force on a HEALTHY session must go straight to the credential login.
  // The silent rungs re-arm iserver from the EXISTING SSO session and cannot
  // mint a new one, so running them against a healthy session returns success
  // immediately without refreshing anything — and the caller records a green
  // run while the session stays exactly as old as it was.
  it('NEVER attempts silent recovery when forced on a healthy session', () => {
    const plan = planRecovery(UP, true);
    expect(plan.action).not.toBe('silent-then-credential');
    expect(plan.action).not.toBe('nothing-to-do');
    expect(plan).toEqual({ action: 'credential-only', reason: 'force' });
  });

  it('skips the silent ladder when forced even if the session is down', () => {
    // --force means "mint a new SSO session". One rule, both directions, so
    // the flag cannot quietly degrade into a no-op depending on gateway state.
    expect(planRecovery(DOWN, true)).toEqual({ action: 'credential-only', reason: 'force' });
  });

  it('only ever returns a plan that can actually replace an SSO session when forced', () => {
    for (const health of [UP, DOWN, HALF]) {
      expect(planRecovery(health, true).action).toBe('credential-only');
    }
  });
});
