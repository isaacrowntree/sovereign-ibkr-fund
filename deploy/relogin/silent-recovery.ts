/**
 * Silent recovery — restore the IBKR brokerage session without a 2FA push.
 *
 * CPGateway holds two sessions:
 *
 *   - the SSO/web session, kept alive by bezant's 60s tickle
 *   - the iserver/brokerage session, which drops on its own several times
 *     a day while SSO stays perfectly valid
 *
 * The gateway logs both facts in the same second: `"authenticated":false`
 * next to a healthy `ssoExpires` and `sso ping {"result":"true"}`.
 *
 * relogin used to treat every such drop as a total loss and go straight to
 * a credential login — i.e. an IB Key push to the phone, several times a
 * day, and far more than that whenever the 5-minute timer re-ran the flow
 * against a session that stayed down.
 *
 * Two endpoints fix it in place, no credentials involved:
 *
 *   1. POST /v1/api/iserver/reauthenticate     rebuild iserver from live SSO
 *   2. POST /v1/api/iserver/auth/ssodh/init    bridge SSO -> iserver
 *
 * Both are 401 when there is no live SSO session to build on (a genuine SSO
 * expiry, or a freshly restarted container). That is the signal to fall back
 * to the credential login, which is the only thing that can recover from it.
 *
 * This module is deliberately dependency-free — every effect is injected —
 * so the ladder can be tested without a gateway, a browser, or a clock.
 */

export const REAUTHENTICATE_PATH = '/v1/api/iserver/reauthenticate';
export const SSODH_INIT_PATH = '/v1/api/iserver/auth/ssodh/init';

/** The subset of bezant-server's /health we make decisions on. */
export interface SessionHealth {
  authenticated: boolean;
  connected: boolean;
}

export interface SilentRecoveryDeps {
  /** Probe /health. Null means the probe itself failed (server unreachable). */
  probeHealth: () => Promise<SessionHealth | null>;
  /**
   * POST one of the recovery paths. A rejection is tolerated: a 401 (no live
   * SSO session) or a network blip is not the verdict — the /health poll that
   * follows is.
   */
  post: (path: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  /** Time allowed for each rung to take effect. */
  budgetMs?: number;
  /** Gap between /health polls within a rung. */
  pollIntervalMs?: number;
}

export const DEFAULT_BUDGET_MS = 15_000;
export const DEFAULT_POLL_INTERVAL_MS = 2_500;

/**
 * Healthy means BOTH halves are up. `authenticated` alone is not enough:
 * that is exactly the half-recovered state this module exists to finish,
 * and main() gates on the same pair.
 */
export function isHealthy(h: SessionHealth | null): boolean {
  return h !== null && h.authenticated && h.connected;
}

/**
 * Poll /health until healthy or the budget runs out.
 *
 * The budget is spent as a fixed number of polls rather than wall-clock, so
 * a slow probe can't silently halve the number of attempts — and so tests
 * can drive it with a no-op sleep and still exercise the real bounds.
 */
async function waitForHealthy(
  deps: SilentRecoveryDeps,
  budgetMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const polls = Math.max(1, Math.ceil(budgetMs / pollIntervalMs));
  for (let i = 0; i < polls; i++) {
    await deps.sleep(pollIntervalMs);
    if (isHealthy(await deps.probeHealth())) return true;
  }
  return false;
}

/**
 * Walk the ladder. Returns true if the session came back with no push.
 *
 * False means the SSO session really is gone and only a credential login
 * can recover it — the caller should escalate.
 */
export async function trySilentRecovery(deps: SilentRecoveryDeps): Promise<boolean> {
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const rungs: Array<{ path: string; label: string }> = [
    { path: REAUTHENTICATE_PATH, label: '/iserver/reauthenticate' },
    { path: SSODH_INIT_PATH, label: 'the SSO->iserver bridge (ssodh/init)' },
  ];

  for (const [i, rung] of rungs.entries()) {
    deps.log(
      i === 0
        ? `Attempting silent recovery (no push): ${rung.label}`
        : `Still unhealthy — trying ${rung.label}`,
    );
    try {
      await deps.post(rung.path);
    } catch {
      // Not fatal, and not a reason to skip the poll: the gateway may well
      // have acted on the request before the connection died.
    }
    if (await waitForHealthy(deps, budgetMs, pollIntervalMs)) {
      deps.log(`Silent recovery succeeded via ${rung.label} — no push needed`);
      return true;
    }
  }

  deps.log('Silent recovery failed — SSO session is gone, falling back to credential login');
  return false;
}
