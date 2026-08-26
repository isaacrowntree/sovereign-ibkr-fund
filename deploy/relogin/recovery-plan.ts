/**
 * What a relogin run should do, given the gateway's health and whether the
 * caller forced a refresh.
 *
 * Split out of index.ts so it can be tested without a browser, a gateway or a
 * process exit — the --force regression below shipped precisely because this
 * decision was buried in main() where nothing could reach it.
 */

export interface SessionHealth {
  authenticated: boolean;
  connected: boolean;
}

export type RecoveryPlan =
  /** Session is fine and nobody asked for more. */
  | { action: 'nothing-to-do' }
  /** Try the no-push rungs first; fall back to a credential login if they fail. */
  | { action: 'silent-then-credential' }
  /** Go straight to a credential login — only a new SSO session will do. */
  | { action: 'credential-only'; reason: 'force' };

/**
 * The rule that matters: **--force never goes near the silent ladder.**
 *
 * The silent rungs (/iserver/reauthenticate, then ssodh/init) re-arm the
 * iserver session from the SSO session already behind it. They cannot mint a
 * new SSO session. Run them against a session that is already healthy and the
 * health poll succeeds on the first rung without anything having happened —
 * the run exits 0 logging "no push needed" while the SSO session is exactly as
 * old as it was, and the caller records a green refresh that refreshed nothing.
 *
 * That is the whole point of the flag, so the rule is unconditional rather than
 * "skip the ladder when healthy": a caller asking to replace a session must not
 * get a silent no-op just because the gateway happened to be down at the time.
 */
export function planRecovery(health: SessionHealth, force: boolean): RecoveryPlan {
  if (force) return { action: 'credential-only', reason: 'force' };
  const healthy = health.authenticated && health.connected;
  return healthy ? { action: 'nothing-to-do' } : { action: 'silent-then-credential' };
}
