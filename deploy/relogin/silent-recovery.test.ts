import { describe, it, expect } from 'vitest';
import {
  trySilentRecovery,
  isHealthy,
  REAUTHENTICATE_PATH,
  SSODH_INIT_PATH,
  DEFAULT_BUDGET_MS,
  DEFAULT_POLL_INTERVAL_MS,
  type SessionHealth,
  type SilentRecoveryDeps,
} from './silent-recovery.js';

const UP: SessionHealth = { authenticated: true, connected: true };
const DOWN: SessionHealth = { authenticated: false, connected: false };

/**
 * Test rig. `healthAfter` maps a recovery path to the health the gateway
 * starts reporting once that path has been POSTed — i.e. which rung of the
 * ladder actually fixes this particular outage. Paths absent from the map
 * never help, which is how we model a dead SSO session.
 */
function rig(opts: {
  healthAfter?: Record<string, SessionHealth>;
  initialHealth?: SessionHealth | null;
  postThrows?: boolean;
} = {}) {
  const posts: string[] = [];
  const logs: string[] = [];
  let probes = 0;
  let sleeps = 0;
  let current: SessionHealth | null = opts.initialHealth ?? DOWN;

  const deps: SilentRecoveryDeps = {
    probeHealth: async () => {
      probes++;
      return current;
    },
    post: async (path) => {
      posts.push(path);
      if (opts.postThrows) throw new Error('network down');
      const next = opts.healthAfter?.[path];
      if (next) current = next;
    },
    sleep: async (ms) => {
      sleeps++;
      expect(ms).toBe(DEFAULT_POLL_INTERVAL_MS);
    },
    log: (m) => logs.push(m),
  };

  return { deps, posts, logs, probeCount: () => probes, sleepCount: () => sleeps };
}

describe('isHealthy', () => {
  it('requires both halves of the session', () => {
    expect(isHealthy(UP)).toBe(true);
    expect(isHealthy(DOWN)).toBe(false);
    // The half-recovered state this module exists to finish: SSO is back but
    // the brokerage session has not been bridged yet. Calling that "healthy"
    // would hand a logged-out gateway to the fund.
    expect(isHealthy({ authenticated: true, connected: false })).toBe(false);
    // A failed probe is not evidence of health.
    expect(isHealthy(null)).toBe(false);
  });
});

describe('trySilentRecovery', () => {
  it('recovers on the first rung without touching the second', async () => {
    const { deps, posts, logs } = rig({ healthAfter: { [REAUTHENTICATE_PATH]: UP } });

    await expect(trySilentRecovery(deps)).resolves.toBe(true);

    // The whole point: ssodh/init is never reached, and no credential login
    // is signalled to the caller, so no IB Key push is sent.
    expect(posts).toEqual([REAUTHENTICATE_PATH]);
    expect(logs.some((l) => l.includes('no push needed'))).toBe(true);
  });

  it('falls through to the SSO bridge when reauthenticate does not take', async () => {
    const { deps, posts } = rig({ healthAfter: { [SSODH_INIT_PATH]: UP } });

    await expect(trySilentRecovery(deps)).resolves.toBe(true);

    // Order matters: the cheap rebuild is always tried before the bridge.
    expect(posts).toEqual([REAUTHENTICATE_PATH, SSODH_INIT_PATH]);
  });

  it('gives up and escalates when the SSO session is genuinely gone', async () => {
    const { deps, posts, logs } = rig({ healthAfter: {} });

    await expect(trySilentRecovery(deps)).resolves.toBe(false);

    expect(posts).toEqual([REAUTHENTICATE_PATH, SSODH_INIT_PATH]);
    expect(logs.at(-1)).toContain('falling back to credential login');
  });

  it('bounds each rung so a dead gateway cannot stall the systemd unit', async () => {
    const { deps, probeCount, sleepCount } = rig({ healthAfter: {} });

    await trySilentRecovery(deps);

    // Two rungs, each capped at budget/interval polls. The unit's
    // TimeoutStartSec is sized against this bound, so it has to hold.
    const perRung = Math.ceil(DEFAULT_BUDGET_MS / DEFAULT_POLL_INTERVAL_MS);
    expect(probeCount()).toBe(perRung * 2);
    expect(sleepCount()).toBe(perRung * 2);
  });

  it('treats an unreachable gateway as not-recovered rather than recovered', async () => {
    const { deps, posts } = rig({ initialHealth: null, healthAfter: {} });

    await expect(trySilentRecovery(deps)).resolves.toBe(false);
    expect(posts).toEqual([REAUTHENTICATE_PATH, SSODH_INIT_PATH]);
  });

  it('keeps walking the ladder when a POST itself fails', async () => {
    // A 401/network error on the POST is expected when there is no SSO
    // session; the /health poll is the verdict, not the POST's fate.
    const { deps, posts } = rig({ postThrows: true });

    await expect(trySilentRecovery(deps)).resolves.toBe(false);
    expect(posts).toEqual([REAUTHENTICATE_PATH, SSODH_INIT_PATH]);
  });

  it('honours injected budgets', async () => {
    const { deps, probeCount } = rig({ healthAfter: {} });

    await trySilentRecovery({ ...deps, budgetMs: 10, pollIntervalMs: 10, sleep: async () => {} });

    expect(probeCount()).toBe(2); // one poll per rung
  });
});
