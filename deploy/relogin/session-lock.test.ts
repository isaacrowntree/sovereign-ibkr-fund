/**
 * relogin under the shared session lock, run for real against the watchdog's
 * fake bezant. Skipped where relogin's own dependencies (Playwright) are not
 * installed — index.ts imports it at the top.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
// @ts-expect-error — plain .mjs test helper, no types
import { startFakeBezant } from '../watchdog/test/fake-bezant.mjs';
import { acquire } from '../lib/session-lock.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
let hasPlaywright = true;
try {
  createRequire(path.join(HERE, 'index.ts')).resolve('playwright');
} catch {
  hasPlaywright = false;
}

type Fake = { url: string; posts: { path: string }[]; set(p: object): void; close(): Promise<void> };
let fake: Fake;
beforeAll(async () => {
  fake = await startFakeBezant();
  fake.set({ health: { status: 401, body: { code: 'not_authenticated' } } });
});
afterAll(async () => fake?.close());

function run(work: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  const child = spawn('npx', ['tsx', path.join(HERE, 'index.ts')], {
    cwd: work,
    env: {
      ...process.env,
      IBKR_USERNAME: 'tester',
      IBKR_PASSWORD: 'x',
      IBKR_FUND_ALERT_WEBHOOK: '',
      BEZANT_HEALTH_URL: `${fake.url}/health`,
      BEZANT_RELOGIN_STATE_DIR: path.join(work, 'state'),
      IBKR_SESSION_LOCK_DIR: path.join(work, 'lock'),
      PI_OPS_DIR: path.join(work, 'ops'),
      ...env,
    },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
}

describe.skipIf(!hasPlaywright)('relogin and the session lock', () => {
  it('stands aside with exit 75 while someone else holds it, recording nothing', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-lock-'));
    const held = acquire('assisted-login', 600, { dir: path.join(work, 'lock'), inheritToken: '' });
    expect(held.ok).toBe(true);
    const r = await run(work);
    expect(r.code).toBe(75);
    expect(r.out).toContain('session lock held by assisted-login');
    // No attempt was made: no state written, no park, no ssodh/init poked.
    expect(fs.existsSync(path.join(work, 'state', 'state.json'))).toBe(false);
    expect(fs.existsSync(path.join(work, 'state', 'disabled'))).toBe(false);
    expect(fake.posts.length).toBe(0);
  }, 60_000);

  it('runs under a parent\'s lock when handed its token (preflight → relogin)', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-lock-'));
    const parent = acquire('preflight', 600, { dir: path.join(work, 'lock'), inheritToken: '' });
    if (!parent.ok) throw new Error('could not take the parent lock');
    // Unreachable login URL: the run gets past the lock, fails fast, and exits.
    const r = await run(work, {
      IBKR_SESSION_LOCK_TOKEN: parent.token,
      BEZANT_LOGIN_URL: 'http://127.0.0.1:9/',
      RELOGIN_PUSH_ALERT: 'already-sent',
    });
    expect(r.out).toContain("running under the caller's session lock");
    expect(r.code).not.toBe(75);
    // The parent's lock survives the child.
    expect(JSON.parse(fs.readFileSync(path.join(work, 'lock', 'holder.json'), 'utf8')).owner).toBe('preflight');
  }, 120_000);
});
