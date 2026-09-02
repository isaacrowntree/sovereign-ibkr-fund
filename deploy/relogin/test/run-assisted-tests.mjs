/**
 * Tests for assisted-login.ts against the fake gateway in fake-ibkr.mjs.
 *
 * These exist because the alternative was testing in production: every
 * iteration on 2026-09-01/02 cost an IB Key push, the operator's attention and
 * a single-use response code, and three broken detectors still reached the Pi.
 *
 *   node test/run-assisted-tests.mjs
 *
 * Named `run-assisted-tests` rather than `*.test.mjs` on purpose: vitest's
 * default glob would otherwise collect it, run it as a vitest file without the
 * environment it needs, and report a repo-wide failure for a suite that passes.
 *
 * No framework: the script under test is a standalone process driven by files,
 * so the natural harness is a process and some files.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELOGIN_DIR = path.dirname(HERE);
let PASS = 0;
let FAIL = 0;

const ok = (name) => { PASS += 1; console.log(`  ok   ${name}`); };
const no = (name, detail) => { FAIL += 1; console.log(`  FAIL ${name}\n     ${detail}`); };
const want = (name, actual, expected) =>
  (String(actual) === String(expected) ? ok(name) : no(name, `expected ${expected}, got ${actual}`));
const wantIncludes = (name, haystack, needle) =>
  (String(haystack).includes(needle) ? ok(name) : no(name, `expected to contain: ${needle}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(predicate, budgetMs, label) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    if (await predicate()) return true;
    await sleep(250);
  }
  console.log(`     (timed out waiting for ${label} after ${budgetMs}ms)`);
  return false;
}

/**
 * Run one scenario end to end: fake gateway + the real script + a fixture state
 * dir, with the operator's half of the conversation supplied by `respondWith`.
 */
async function scenario({ mode = 'challenge', crossOrigin = false, respondWith = null, viaWeb = false, name }) {
  const port = 8100 + Math.floor(Math.random() * 800) * 2;
  const webPort = port + 1000;
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'assisted-test-'));
  const stateDir = path.join(work, 'state');
  const ioDir = path.join(work, 'io');
  await fs.mkdir(stateDir, { recursive: true });
  // A sentinel and a stale failure count, so the success path's repair of them
  // is actually observable rather than vacuously true.
  await fs.writeFile(path.join(stateDir, 'disabled'), '');
  await fs.writeFile(
    path.join(stateDir, 'state.json'),
    JSON.stringify({ consecutiveFailures: 4, lastSuccessAt: '2026-08-30T21:09:47.375Z' }),
  );

  const server = spawn('node', [
    path.join(HERE, 'fake-ibkr.mjs'),
    '--port', String(port),
    '--mode', mode,
    ...(crossOrigin ? ['--cross-origin'] : []),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  await until(async () => {
    try {
      await fetch(`http://localhost:${port}/health`);
      return true;
    } catch { return false; }
  }, 5_000, 'the fake gateway');

  const child = spawn('npx', ['tsx', 'assisted-login.ts'], {
    cwd: RELOGIN_DIR,
    env: {
      ...process.env,
      BEZANT_HEALTH_URL: `http://localhost:${port}/health`,
      BEZANT_LOGIN_URL: `http://localhost:${port}/`,
      IBKR_USERNAME: 'tester',
      IBKR_PASSWORD: 'pa$$word',
      IBKR_FUND_ALERT_WEBHOOK: '',
      BEZANT_RELOGIN_STATE_DIR: stateDir,
      ASSISTED_IO_DIR: ioDir,
      ASSISTED_DEBUG_DIR: path.join(work, 'shots'),
      ASSISTED_BUDGET_MS: '45000',
      ASSISTED_WEB_PORT: String(webPort),
      ASSISTED_WEB_HOST: '127.0.0.1',
      // Use whatever chromium build this machine already has: the pinned
      // download is a 150MB detour that tells us nothing about the script.
      ASSISTED_BROWSER_PATH: process.env.ASSISTED_BROWSER_PATH ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  if (respondWith) {
    // Answer as the operator would: wait for the challenge to be announced,
    // then write the code. If it is never announced, write it anyway after a
    // grace period — submission must not depend on detection.
    const announced = await until(
      () => fs.access(path.join(ioDir, 'challenge.txt')).then(() => true, () => false),
      25_000,
      'the challenge announcement',
    );
    if (viaWeb) {
      // Exactly what a phone does: GET the page, then POST the form.
      const shown = await fetch(`http://127.0.0.1:${webPort}/`).then((r) => r.text()).catch(() => '');
      out += `\n[test] page showed: ${shown.includes('111 222') ? 'the challenge' : 'NO challenge'}\n`;
      const posted = await fetch(`http://127.0.0.1:${webPort}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: respondWith }).toString(),
        redirect: 'follow',
      }).then((r) => r.status).catch((e) => `error ${e}`);
      out += `[test] form POST status: ${posted}\n`;
    } else {
      await fs.mkdir(ioDir, { recursive: true });
      await fs.writeFile(path.join(ioDir, 'response.txt'), `${respondWith}\n`);
    }
    out += announced ? '\n[test] challenge was announced\n' : '\n[test] challenge was NOT announced\n';
  }

  const exit = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    setTimeout(() => { child.kill('SIGKILL'); resolve('killed'); }, 70_000);
  });

  const serverState = await fetch(`http://localhost:${port}/_test/state`).then((r) => r.json());
  const stateJson = JSON.parse(await fs.readFile(path.join(stateDir, 'state.json'), 'utf8'));
  const sentinel = await fs.access(path.join(stateDir, 'disabled')).then(() => 'present', () => 'gone');
  server.kill('SIGKILL');
  console.log(`\n${name}`);
  return { out, exit, serverState, stateJson, sentinel, challengeFile: path.join(ioDir, 'challenge.txt') };
}

// ── 1. the challenge path, cross-origin iframe (what production actually is) ──
{
  const r = await scenario({
    name: 'challenge in a cross-origin iframe (the production shape)',
    crossOrigin: true,
    respondWith: '99887766',
  });
  wantIncludes('reads the challenge out of the iframe', r.out, 'CHALLENGE CODE: 111 222');
  wantIncludes('  ...and announces it to the operator', r.out, '[test] challenge was announced');
  want('submits the response exactly ONCE', r.serverState.submissions.length, 1);
  want('  ...with the code it was given', r.serverState.submissions[0], '99887766');
  want('  ...and the gateway ends authenticated', r.serverState.authenticated, true);
  want('  ...exit code 0', r.exit, 0);
  want('  ...the sentinel is cleared', r.sentinel, 'gone');
  want('  ...and the failure count is reset', r.stateJson.consecutiveFailures, 0);
}

// ── 2. same-origin iframe: the detector must not depend on the origin ────────
{
  const r = await scenario({
    name: 'challenge in a same-origin iframe',
    crossOrigin: false,
    respondWith: '99887766',
  });
  wantIncludes('reads the challenge', r.out, 'CHALLENGE CODE: 111 222');
  want('submits once', r.serverState.submissions.length, 1);
  want('  ...and authenticates', r.serverState.authenticated, true);
}

// ── 3. no challenge at all — approving the push is enough ────────────────────
{
  const r = await scenario({ name: 'push approved, no challenge follows', mode: 'push-only' });
  want('authenticates without asking for anything', r.serverState.authenticated, true);
  want('  ...and never announces a challenge', r.serverState.submissions.length, 0);
  wantIncludes('  ...reporting success', r.out, 'Authenticated');
  want('  ...exit code 0', r.exit, 0);
}

// ── 4. a wrong code fails honestly, and is not retried ───────────────────────
{
  const r = await scenario({
    name: 'a rejected response code',
    mode: 'wrong-code',
    respondWith: '00000000',
  });
  want('submits the bad code once and stops', r.serverState.submissions.length, 1);
  want('  ...leaves the gateway unauthenticated', r.serverState.authenticated, false);
  want('  ...exits non-zero', r.exit, 1);
  want('  ...and leaves the sentinel alone', r.sentinel, 'present');
  want('  ...without falsely recording a success', r.stateJson.consecutiveFailures, 4);
}

// ── 5. the response code arrives from the phone, not from a file ────────────
{
  const r = await scenario({
    name: 'response code entered on the LAN page',
    crossOrigin: true,
    respondWith: '99887766',
    viaWeb: true,
  });
  wantIncludes('the page shows the challenge to the phone', r.out, '[test] page showed: the challenge');
  wantIncludes('  ...and accepts the posted code', r.out, '[test] form POST status: 200');
  want('  ...submitting it to IBKR exactly once', r.serverState.submissions.length, 1);
  want('  ...with the code the phone sent', r.serverState.submissions[0], '99887766');
  want('  ...and the session comes back', r.serverState.authenticated, true);
  want('  ...with the sentinel cleared', r.sentinel, 'gone');
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
