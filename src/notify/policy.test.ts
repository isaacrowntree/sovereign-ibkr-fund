/**
 * The 2026-09-24 paging policy, end to end through notify(): the three allowed
 * categories reach Slack, everything else reaches the ops feed and only the
 * ops feed — at the severity it was raised with.
 *
 * feed.ts reads PI_OPS_DIR at module load, so the env is set first and the
 * notifier is imported fresh.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { NotifyEvent } from './index.js';
import { PAGE_CATEGORIES as DEPLOY_CATEGORIES, mayPage as deployMayPage } from '../../deploy/lib/slack-policy.mjs';

const HOOK = 'https://hooks.slack.com/services/T/B/xxx';
const savedEnv = { ...process.env };
let dir: string;
let mod: typeof import('./index.js');
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
  process.env.PI_OPS_DIR = dir;
  vi.resetModules();
  mod = await import('./index.js');
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

beforeEach(() => {
  delete process.env.NOTIFIER;
  delete process.env.NOTIFY_OUTBOX;
  process.env.IBKR_FUND_ALERT_WEBHOOK = HOOK;
  process.env.ALERT_RETRY_DELAYS_MS = '0,0';
  fs.rmSync(path.join(dir, 'ops-feed.jsonl'), { force: true });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { status: 200 }));
});
afterEach(() => vi.restoreAllMocks());

const feedLines = (): Array<{ severity: string; title: string }> => {
  const f = path.join(dir, 'ops-feed.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

describe('the policy list', () => {
  it('is exactly the three categories', () => {
    expect([...mod.PAGE_CATEGORIES].sort()).toEqual(['db-upload', 'fund-disconnect', 'ip-disconnect']);
  });

  it('agrees with the host-side copy in deploy/lib/slack-policy.mjs', () => {
    expect([...DEPLOY_CATEGORIES].sort()).toEqual([...mod.PAGE_CATEGORIES].sort());
    for (const c of [...mod.PAGE_CATEGORIES, 'risk', '', undefined, 'FUND-DISCONNECT']) {
      expect(deployMayPage(c)).toBe(mod.mayPage(c));
    }
  });
});

describe('allowed categories page Slack (and are still recorded)', () => {
  it.each(['fund-disconnect', 'ip-disconnect', 'db-upload'] as const)('%s posts once', async (page) => {
    await mod.notify({ severity: 'critical', title: `t-${page}`, page });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(feedLines()).toEqual([expect.objectContaining({ severity: 'critical', title: `t-${page}` })]);
  });

  it('alert() with an allowed category posts', async () => {
    await mod.alert('gateway down', 'fund-disconnect');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('everything else is feed-only, at its own severity', () => {
  const demoted: NotifyEvent[] = [
    { severity: 'critical', title: 'Drawdown HARD STOP', agent: 'risk-manager' },
    { severity: 'warn', title: 'Portfolio drift 7%', agent: 'risk-manager' },
    { severity: 'info', title: 'Order filled: BUY 10 VTI', agent: 'execution-bot' },
    { severity: 'info', title: 'Trading day push', agent: 'portfolio-strategist' },
    { severity: 'warn', title: "Today's digest is stale", agent: 'daily-summary' },
    { severity: 'critical', title: 'Reconcile break', agent: 'reconciler' },
    { severity: 'warn', title: 'Order event stream not delivering', agent: 'observer' },
    { severity: 'recovery', title: 'Event stream healthy again after 3 min', agent: 'observer' },
  ];

  it.each(demoted.map((e) => [e.title, e] as const))('%s never touches Slack', async (_t, ev) => {
    await mod.notify(ev);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(feedLines()).toEqual([expect.objectContaining({ severity: ev.severity, title: ev.title })]);
  });

  it('an unknown category is not a way in', async () => {
    await mod.notify({ severity: 'critical', title: 'x', page: 'risk' as never });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('alert() with no category is recorded as a warn and not posted', async () => {
    await mod.alert('config warning');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(feedLines()).toEqual([expect.objectContaining({ severity: 'warn', title: 'config warning' })]);
  });
});
