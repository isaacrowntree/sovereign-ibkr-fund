/**
 * The watchdog's decisions, against a fake bezant (test/fake-bezant.mjs) and a
 * fake clock. The restart is a recorded callback, never docker.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — plain .mjs test helper, no types
import { startFakeBezant } from './test/fake-bezant.mjs';
import { tick, DEFAULT_THRESHOLDS, type WatchdogConfig, type RestartMode } from './watchdog.js';
import { acquire, currentHolder } from '../lib/session-lock.js';
import type { FeedEvent } from '../lib/ops-feed.js';

// 12:00 and 02:00 Sydney (AEST, +10) on 2026-09-24.
const DAY = '2026-09-24T02:00:00Z';
const NIGHT = '2026-09-24T16:00:00Z';

type Fake = {
  url: string;
  posts: { path: string; token: string | null }[];
  set(p: Record<string, unknown>): void;
  reset(): void;
  close(): Promise<void>;
};
let fake: Fake;
beforeAll(async () => {
  fake = await startFakeBezant();
});
afterAll(async () => fake.close());

let work: string;
let clock: number;
let restarts: string[];
let feedLog: FeedEvent[];
let alerts: string[];
let logs: string[];
let restartSeesLock: (string | undefined)[];

function cfg(mode: RestartMode = 'on', token: string | undefined = 'test-token'): WatchdogConfig {
  return {
    baseUrl: fake.url,
    debugToken: token,
    restartMode: mode,
    stateFile: path.join(work, 'watchdog', 'state.json'),
    reloginDisabledFile: path.join(work, 'relogin', 'disabled'),
    reloginStateFile: path.join(work, 'relogin', 'state.json'),
    lockDir: path.join(work, 'lock'),
    probeTimeoutMs: 1_000,
    postRestartProbes: 2,
    postRestartIntervalMs: 0,
    thresholds: DEFAULT_THRESHOLDS,
  };
}

const deps = (c: WatchdogConfig) => ({
  now: () => new Date(clock),
  restart: async () => {
    restarts.push(new Date(clock).toISOString());
    restartSeesLock.push(currentHolder(c.lockDir)?.owner);
    return true;
  },
  feed: (e: FeedEvent) => void feedLog.push(e),
  alert: async (t: string) => void alerts.push(t),
  log: (m: string) => void logs.push(m),
  sleep: async () => {},
});

/** Run `n` ticks `stepS` apart, starting at the current clock. */
async function ticks(n: number, c = cfg(), stepS = 60) {
  let s;
  for (let i = 0; i < n; i++) {
    s = await tick(c, deps(c));
    clock += stepS * 1000;
  }
  return s!;
}

const posted = (p: string) => fake.posts.filter((x) => x.path === p).length;
const park = () => path.join(work, 'relogin', 'disabled');
const parkIt = () => {
  fs.mkdirSync(path.dirname(park()), { recursive: true });
  fs.writeFileSync(park(), 'x');
};
const parked = () => fs.existsSync(park());

beforeEach(() => {
  fake.reset();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-test-'));
  clock = Date.parse(DAY);
  restarts = [];
  feedLog = [];
  alerts = [];
  logs = [];
  restartSeesLock = [];
});

describe('healthy', () => {
  it('does nothing and pokes nothing', async () => {
    await ticks(10);
    expect(restarts).toEqual([]);
    expect(fake.posts).toEqual([]);
    expect(alerts).toEqual([]);
  });
});

describe('dead gateway (5xx / unreachable)', () => {
  it('restarts once the outage has lasted 300 elapsed seconds, not before', async () => {
    fake.set({ health: { status: 502, body: { code: 'upstream_unreachable' } } });
    await ticks(5); // t = 0..240s
    expect(restarts).toEqual([]);
    await ticks(1); // t = 300s
    expect(restarts).toHaveLength(1);
  });

  it('treats no answer at all the same way', async () => {
    fake.set({ down: true });
    await ticks(6);
    expect(restarts).toHaveLength(1);
  });

  it('holds the session lock across its own restart, and releases it', async () => {
    fake.set({ down: true });
    await ticks(6);
    expect(restartSeesLock).toEqual(['watchdog-restart']);
    expect(currentHolder(cfg().lockDir)).toBeNull();
  });

  it('by day, clears the park when the restarted gateway answers', async () => {
    parkIt();
    fake.set({ health: { status: 503, body: {} } });
    await ticks(5);
    // Restart is recorded, then the post-restart probe finds it answering.
    const c = cfg();
    const d = deps(c);
    d.restart = async () => {
      restarts.push('x');
      fake.set({ health: { status: 401, body: { code: 'not_authenticated' } } });
      return true;
    };
    await tick(c, d);
    expect(restarts).toHaveLength(1);
    expect(parked()).toBe(false);
  });

  it('at night still restarts a dead gateway (D5) but never clears the park', async () => {
    clock = Date.parse(NIGHT);
    parkIt();
    fake.set({ health: { status: 503, body: {} } });
    await ticks(5);
    const c = cfg();
    const d = deps(c);
    d.restart = async () => {
      restarts.push('x');
      fake.set({ health: { status: 401, body: {} } });
      return true;
    };
    await tick(c, d);
    expect(restarts).toHaveLength(1);
    expect(parked()).toBe(true);
  });

  it('does not restart again inside the 2h cooldown', async () => {
    fake.set({ down: true });
    await ticks(6);
    await ticks(60);
    expect(restarts).toHaveLength(1);
  });

  it('a gap in observation restarts the streak (a Pi that was off is not an outage)', async () => {
    fake.set({ down: true });
    await ticks(1);
    clock += 400_000;
    await ticks(1);
    expect(restarts).toEqual([]);
  });

  it('a 3xx or 404 on /health is not a dead gateway', async () => {
    fake.set({ health: { status: 404, body: {} } });
    await ticks(10);
    expect(restarts).toEqual([]);
  });

  it('defers to whoever holds the session lock', async () => {
    const other = acquire('relogin', 3600, { dir: cfg().lockDir, inheritToken: '' });
    fake.set({ down: true });
    await ticks(10);
    expect(restarts).toEqual([]);
    expect(logs.some((l) => l.includes('session lock held by relogin'))).toBe(true);
    if (other.ok) other.release();
    await ticks(1);
    expect(restarts).toHaveLength(1);
  });
});

describe('WATCHDOG_RESTART=dry-run', () => {
  it('says what it would do and does none of it', async () => {
    parkIt();
    fake.set({ down: true });
    await ticks(10, cfg('dry-run'));
    expect(restarts).toEqual([]);
    expect(parked()).toBe(true);
    expect(logs.some((l) => l.startsWith('DRY-RUN — would restart bezant'))).toBe(true);
    expect(feedLog.filter((e) => e.title.startsWith('Dry run'))).toHaveLength(1);
  });
});

describe('upstream failing (gateway up, api.ibkr.com down)', () => {
  it('never restarts, even on a 5xx, and alerts once after the limit', async () => {
    fake.set({ health: { status: 503, body: { upstream_failing: true, code: 'upstream_failing' } } });
    await ticks(14); // up to 780s
    expect(alerts).toEqual([]);
    await ticks(60);
    expect(restarts).toEqual([]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('api.ibkr.com');
  });

  it('says so when it recovers', async () => {
    fake.set({ health: { status: 200, body: { authenticated: true, upstream_failing: true } } });
    await ticks(20);
    fake.reset();
    await ticks(1);
    expect(feedLog.some((e) => e.severity === 'recovery' && e.title.includes('answering again'))).toBe(true);
  });

  it('tolerates the field being absent (an older bezant)', async () => {
    fake.set({ health: { status: 200, body: { authenticated: true, connected: true } } });
    await ticks(3);
    expect(logs.some((l) => l.includes('upstream_failing'))).toBe(false);
  });
});

describe('silent event stream — never a restart', () => {
  const silent = { streamFresh: false, stream: { status: 200, body: { connected: true, last_message_at: '2026-01-01T00:00:00Z' } } };

  it('reconnects at 10 min, reauthenticates 5 min later, alerts at 30 min, never restarts', async () => {
    fake.set(silent);
    await ticks(10); // 0..540s
    expect(posted('/events/_reconnect')).toBe(0);
    await ticks(1); // 600s
    expect(posted('/events/_reconnect')).toBe(1);
    expect(fake.posts.find((p) => p.path === '/events/_reconnect')?.token).toBe('test-token');
    await ticks(4); // 660..840
    expect(posted('/v1/api/iserver/reauthenticate')).toBe(0);
    await ticks(1); // 900
    expect(posted('/v1/api/iserver/reauthenticate')).toBe(1);
    await ticks(15); // ..1800
    expect(alerts).toHaveLength(1);
    await ticks(120);
    expect(alerts).toHaveLength(1);
    expect(restarts).toEqual([]);
    expect(posted('/events/_reconnect')).toBe(1);
  });

  it('an older bezant (404 on _reconnect) goes straight to reauthenticate', async () => {
    fake.set({ ...silent, reconnect: 404 });
    await ticks(11);
    expect(posted('/events/_reconnect')).toBe(1);
    expect(posted('/v1/api/iserver/reauthenticate')).toBe(1);
  });

  it('no debug token → 401 → straight to reauthenticate', async () => {
    fake.set(silent);
    await ticks(11, cfg('on', ''));
    expect(posted('/v1/api/iserver/reauthenticate')).toBe(1);
  });

  it('in dry-run reconnects the stream but does not reauthenticate', async () => {
    fake.set(silent);
    await ticks(20, cfg('dry-run'));
    expect(posted('/events/_reconnect')).toBe(1);
    expect(posted('/v1/api/iserver/reauthenticate')).toBe(0);
  });

  it('a disconnected stream counts too, and recovery resets the ladder', async () => {
    fake.set({ stream: { status: 200, body: { connected: false } } });
    await ticks(35);
    expect(alerts).toHaveLength(1);
    fake.reset();
    await ticks(1);
    expect(feedLog.some((e) => e.severity === 'recovery' && e.title.includes('event stream'))).toBe(true);
    expect(restarts).toEqual([]);
  });

  it('an unreadable _status is not evidence of a wedge', async () => {
    fake.set({ stream: { status: 500, body: {} } });
    await ticks(40);
    expect(fake.posts).toEqual([]);
  });
});

describe('SSO bridge wedged while logged out', () => {
  const wedged = { health: { status: 401, body: { code: 'not_authenticated' } }, ssodhInit: 500 };

  it('by day, restarts after 300s — and does not clear the park', async () => {
    parkIt();
    fake.set(wedged);
    await ticks(6);
    expect(restarts).toHaveLength(1);
    expect(parked()).toBe(true);
  });

  it('in quiet hours, does not restart (D5)', async () => {
    clock = Date.parse(NIGHT);
    fake.set(wedged);
    await ticks(30);
    expect(restarts).toEqual([]);
  });

  it('a 401 bridge is healthy', async () => {
    fake.set({ ...wedged, ssodhInit: 401 });
    await ticks(30);
    expect(restarts).toEqual([]);
  });

  it('does not poke ssodh/init while a login holds the lock', async () => {
    acquire('assisted-login', 3600, { dir: cfg().lockDir, inheritToken: '' });
    fake.set(wedged);
    await ticks(10);
    expect(posted('/v1/api/iserver/auth/ssodh/init')).toBe(0);
    expect(restarts).toEqual([]);
  });
});

describe('state', () => {
  it('loads an old counter-based state file without tripping on it', async () => {
    const c = cfg();
    fs.mkdirSync(path.dirname(c.stateFile), { recursive: true });
    fs.writeFileSync(
      c.stateFile,
      JSON.stringify({ consecutiveServerErrors: 99, lastRestartAt: null, totalRestarts: 7 }),
    );
    fake.set({ down: true });
    const s = await ticks(1, c);
    expect(restarts).toEqual([]);
    expect(s.totalRestarts).toBe(7);
    expect((s as unknown as Record<string, unknown>).consecutiveServerErrors).toBeUndefined();
  });

  it('logged out 30 min with relogin parked lands on the feed, once per 6h', async () => {
    parkIt();
    fake.set({ health: { status: 401, body: {} } });
    await ticks(40);
    expect(feedLog.filter((e) => e.title.includes('auto-relogin is parked'))).toHaveLength(1);
  });
});

describe('index.ts wiring', () => {
  it('runs one real tick from env, in dry-run by default', async () => {
    // Async spawn: the fake bezant lives in THIS process, so a spawnSync would
    // block the very event loop that has to answer the child's probes.
    const { spawn } = await import('node:child_process');
    const here = path.dirname(new URL(import.meta.url).pathname);
    const child = spawn('npx', ['tsx', path.join(here, 'index.ts')], {
      cwd: work, // no .env here, so nothing real leaks in
      env: {
        ...process.env,
        BEZANT_HEALTH_URL: `${fake.url}/health`,
        BEZANT_WATCHDOG_STATE_DIR: path.join(work, 'wd'),
        BEZANT_RELOGIN_DISABLED_FILE: park(),
        BEZANT_RELOGIN_STATE_FILE: path.join(work, 'relogin', 'state.json'),
        IBKR_SESSION_LOCK_DIR: path.join(work, 'lock'),
        PI_OPS_DIR: path.join(work, 'ops'),
        IBKR_FUND_ALERT_WEBHOOK: '',
        BEZANT_RESTART_CMD: 'false',
        WATCHDOG_RESTART: '',
      },
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    const status = await new Promise((resolve) => child.on('close', resolve));
    const r = { status, stdout };
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('health=authenticated');
    expect(r.stdout).toContain('mode=dry-run');
  }, 40_000);
});
