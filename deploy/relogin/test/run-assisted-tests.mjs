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
import net from 'node:net';
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
/**
 * A port pair the OS says is free, rather than a random guess.
 *
 * The first version picked `8100 + random`, which collides often enough to be
 * seen: one run in a handful died with a bind error mid-suite and reported a
 * crash instead of a result. A test harness that fails for its own reasons
 * teaches you to ignore its failures.
 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    // The fake gateway also binds port+1 for the cross-origin frame, so reserve
    // an even port and let the odd neighbour belong to it.
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port % 2 === 0 ? port : port + 1));
    });
  });
}

async function scenario({ mode = 'challenge', crossOrigin = false, respondWith = null, name }) {
  const port = await freePort();
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
      ASSISTED_WEB_URL: 'http://pi.lan/ibkr',
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
    // The hub writes this file (see pi:test/hub_ibkr_test.py); here we are the
    // hub's stand-in, exercising the contract rather than the page.
    await fs.mkdir(ioDir, { recursive: true });
    if (Array.isArray(respondWith)) {
      for (const code of respondWith) {
        await fs.writeFile(path.join(ioDir, 'response.txt'), `${code}\n`);
        await sleep(6_000);
      }
    } else {
      await fs.writeFile(path.join(ioDir, 'response.txt'), `${respondWith}\n`);
    }
    out += announced ? '\n[test] challenge was announced\n' : '\n[test] challenge was NOT announced\n';
  }

  const exit = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    setTimeout(() => { child.kill('SIGKILL'); resolve('killed'); }, 70_000);
  });

  const serverState = await fetch(`http://localhost:${port}/_test/state`).then((r) => r.json());
  const status = await fs.readFile(path.join(ioDir, 'status.json'), 'utf8')
    .then((t) => JSON.parse(t)).catch(() => null);
  const stateJson = JSON.parse(await fs.readFile(path.join(stateDir, 'state.json'), 'utf8'));
  const sentinel = await fs.access(path.join(stateDir, 'disabled')).then(() => 'present', () => 'gone');
  server.kill('SIGKILL');
  console.log(`\n${name}`);
  return { out, exit, serverState, stateJson, sentinel, status };
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

// ── 5. the status the operator's page renders ───────────────────────────────
// The page itself lives in the hub (pi repo). What this script owes it is an
// accurate, fresh status file — everything the page shows comes from here.
{
  const r = await scenario({
    name: 'status published for the hub page',
    crossOrigin: true,
    respondWith: '99887766',
  });
  want('publishes a final status', r.status?.status, 'authenticated');
  want('  ...having carried the challenge for the page to show', r.status?.challenge, '111 222');
  want('  ...and a timestamp, so a stale file can be spotted', typeof r.status?.updatedAt, 'string');
  want('  ...the code reached IBKR once', r.serverState.submissions.length, 1);
  want('  ...and the session came back', r.serverState.authenticated, true);
}

// ── 6. a typo must be correctable ───────────────────────────────────────────
// The original latch allowed exactly one submission per run, so a mistyped code
// ended the login: another push, another challenge, another 20 minutes.
{
  const r = await scenario({
    name: 'a mistyped code, then the right one',
    crossOrigin: true,
    respondWith: ['11112222', '99887766'],
  });
  want('sends both codes to IBKR', r.serverState.submissions.length, 2);
  want('  ...the wrong one first', r.serverState.submissions[0], '11112222');
  want('  ...then the correction', r.serverState.submissions[1], '99887766');
  want('  ...and the session comes back', r.serverState.authenticated, true);
  wantIncludes('  ...having told the operator it was rejected', r.out, 'rejected the submitted code');
}

// ── 7. junk in the response file never reaches IBKR ─────────────────────────
// The hub validates too, but this is the boundary that decides what a broker
// ever sees — including when the file is written by hand over SSH.
{
  const r = await scenario({
    name: 'malformed codes are refused at the boundary',
    crossOrigin: true,
    respondWith: ['<script>alert(1)</script>', 'not-a-code', '99887766'],
  });
  want('only the real code is sent to IBKR', r.serverState.submissions.length, 1);
  want('  ...and it is the valid one', r.serverState.submissions[0], '99887766');
  want('  ...the session comes back', r.serverState.authenticated, true);
}

// ── 8. the form is up, and the TAP wins ─────────────────────────────────────
// The regression that matters most: index.ts used to abandon the login the
// instant this form appeared. In production on 2026-09-02 that would have
// thrown away a session that arrived 8 seconds later, parked the fund and
// paged the operator. Nothing may treat the form as proof the push is dead.
{
  const r = await scenario({ name: 'challenge form shown, but the push completes it', mode: 'push-wins' });
  want('waits through the challenge and lets the tap win', r.serverState.authenticated, true);
  want('  ...without submitting any code', r.serverState.submissions.length, 0);
  want('  ...exit code 0', r.exit, 0);
  want('  ...and the sentinel is cleared', r.sentinel, 'gone');
  wantIncludes('  ...having still told the operator the challenge exists', r.out, 'CHALLENGE CODE');
  want('  ...and published it for the page', r.status?.challenge, '111 222');
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
