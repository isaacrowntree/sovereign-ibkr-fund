/**
 * ibkr-fund-relogin
 *
 * Probes bezant-server's /health endpoint. If the IBKR Client Portal Gateway
 * session has expired, drives a Playwright login at https://localhost:5000.
 *
 * 2FA is handled out-of-band: when the script clicks "Sign In", IBKR pushes
 * an IB Key challenge to the user's phone. The script then polls
 * bezant-server's /health endpoint until it reports authenticated=true, or
 * times out after 2 minutes if the user doesn't tap "Approve".
 *
 * Recovery built in:
 *  - Dropped brokerage session, SSO still valid: recovered silently via
 *    /iserver/reauthenticate (then ssodh/init) with NO push. This is the
 *    common case — CPGateway keeps two sessions and only the iserver half
 *    drops, several times a day. See "silent recovery" below.
 *  - Wedged gateway (login stuck on /sso/Login, no 2FA push sent): auto
 *    `docker restart bezant` to clear it, then retry the login once. Sends no
 *    extra push. This is the exact manual fix for a ~2-week silent outage.
 *  - Genuine missed tap (push sent, not approved): after 1 failure, writes a
 *    `disabled` sentinel, fires an alert (IBKR_FUND_ALERT_WEBHOOK if set), and
 *    exits silently on later ticks (one push per expiry — see note below).
 *    Manual reset:
 *      rm ~/.local/state/bezant-relogin/disabled
 *      systemctl --user start ibkr-fund-relogin.service
 *
 * Flags:
 *  --force   Re-authenticate even when /health reports healthy. Used by a
 *            scheduled pre-market refresh to move the unavoidable IB Key tap
 *            to an hour the operator is awake, rather than waiting for the
 *            session to die unattended overnight. DESTRUCTIVE: it replaces a
 *            working session, so an untapped push logs the fund out.
 *
 * Run via: npx tsx index.ts [--force]
 */
import 'dotenv/config';
import fs from 'node:fs/promises';

/**
 * Re-authenticate even when /health is already healthy. Destructive by design;
 * see the note at the healthy early-exit below.
 */
const FORCE = process.argv.includes('--force');
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, type Browser } from 'playwright';
import { planRecovery } from './recovery-plan.js';
import { feed } from '../lib/ops-feed.js';
import {
  trySilentRecovery,
  SSODH_INIT_PATH,
  type SilentRecoveryDeps,
} from './silent-recovery.js';

const execAsync = promisify(exec);

/**
 * Outcome of one login() attempt:
 *  - authenticated:  /health flipped to authenticated=true (success)
 *  - push_timeout:   reached the 2FA prompt (a push WAS sent) but the user
 *                    didn't approve within the window — a genuine miss
 *  - wedged:         creds submitted but the page never advanced to the 2FA
 *                    prompt / stayed stuck on /sso/Login — CPGateway is
 *                    wedged and NO push was sent. Cleared by restarting bezant.
 *  - error:          unexpected exception during the flow
 */
type LoginOutcome = 'authenticated' | 'push_timeout' | 'challenge' | 'wedged' | 'error';

/**
 * The challenge digits IBKR displayed, if it fell back to challenge/response.
 * Module-level so finalizeFailure() can put them in the alert: they are the one
 * piece of the message the operator cannot get any other way, and they are only
 * discoverable while the browser that rendered them is still alive.
 */
let lastChallenge: string | null = null;

// ---------- config ----------

const HEALTH_URL = process.env.BEZANT_HEALTH_URL ?? 'http://localhost:8080/health';
const LOGIN_URL = process.env.BEZANT_LOGIN_URL ?? 'https://localhost:5000';
const USERNAME = process.env.IBKR_USERNAME;
const PASSWORD = process.env.IBKR_PASSWORD;
const POST_LOGIN_TIMEOUT_MS = 2 * 60 * 1000; // 2 min for IB Key tap
const HEALTH_POLL_INTERVAL_MS = 5_000;
// Silent recovery (no push) runs before any credential login. Each rung gets
// its own budget; when the SSO session really is dead both rungs fail fast and
// we've spent ~30s before falling back — cheap next to a phone buzz.
const SILENT_RECOVERY_BUDGET_MS = 15_000;
const SILENT_POLL_INTERVAL_MS = 2_500;
// One push per session-expiry, then disabled until manual reset.
//
// We tried 3 here originally on the assumption "user might miss the first
// push, give them a couple more chances within ~15 min". Empirically the
// failure mode this produced was strictly worse: when the user genuinely
// wasn't around (asleep, at the gym), 3 pushes per attempt × N watchdog
// cycles overnight = ~15 buzzes on the phone, in tight bursts. One per
// expiry-event is the right UX.
//
// Recovery: after a fail, the disabled sentinel is set and no further
// auto-attempts run. Manual reset via `ssh your-pi 'rm -f
// ~/.local/state/bezant-relogin/disabled && systemctl --user start
// ibkr-fund-relogin.service'` triggers a fresh push at a time of the user's
// choosing.
const MAX_CONSECUTIVE_FAILURES = 1;

// Container name for the bezant gateway (restarted to clear a wedged session).
const BEZANT_CONTAINER = process.env.BEZANT_CONTAINER ?? 'bezant';
// Optional Slack/Discord/ntfy-compatible `{"text": ...}` webhook. When set,
// we POST an alert if auto-relogin disables itself — so a logged-out fund
// can't sit silently for weeks. No-op when unset.
const ALERT_WEBHOOK = process.env.IBKR_FUND_ALERT_WEBHOOK;

const STATE_DIR = process.env.BEZANT_RELOGIN_STATE_DIR
  ?? path.join(os.homedir(), '.local', 'state', 'bezant-relogin');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const DISABLED_FILE = path.join(STATE_DIR, 'disabled');

// ---------- state ----------

interface KeepaliveState {
  consecutiveFailures: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
}

const DEFAULT_STATE: KeepaliveState = {
  consecutiveFailures: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
};

async function loadState(): Promise<KeepaliveState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

async function saveState(state: KeepaliveState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, STATE_FILE);
}

async function isDisabled(): Promise<boolean> {
  try {
    await fs.access(DISABLED_FILE);
    return true;
  } catch {
    return false;
  }
}

async function setDisabled(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(DISABLED_FILE, `${new Date().toISOString()}\n`);
}

// ---------- health probe ----------

interface HealthResponse {
  authenticated: boolean;
  connected: boolean;
  competing?: boolean;
  message?: string | null;
}

async function probeHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(10_000) });
    // bezant-server can respond in two shapes:
    //   200 OK    {"authenticated": bool, "connected": bool, ...}
    //   401       {"code": "not_authenticated", "message": "..."}
    // The 401 shape is a clean "not authenticated yet" signal, not a server
    // outage — treat it as the authenticated=false case.
    if (res.status === 401) {
      return { authenticated: false, connected: false };
    }
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

function gatewayBase(): string {
  return HEALTH_URL.replace(/\/health$/, '');
}

/**
 * Nudge CPGateway to bridge the SSO session into the iserver/CPAPI
 * session. After the user taps IB Key, IBKR validates the SSO half but
 * CPGateway doesn't auto-bridge to the typed-API session — the bridge
 * has to be triggered explicitly via this endpoint.
 *
 * Idempotent: 401 if no valid SSO session yet (user hasn't tapped),
 * 200 once they have. Called every poll cycle so it fires as soon as
 * the tap completes server-side, eliminating a manual `curl ...` step
 * after every relogin.
 */
async function nudgeSsoBridge(): Promise<void> {
  // Same endpoint the silent-recovery ladder uses as its second rung; the
  // difference is only when we call it (during the post-tap poll, vs before
  // ever sending a push).
  await postRecovery(SSODH_INIT_PATH);
}

// ---------- silent recovery (no push) ----------

/**
 * POST a recovery endpoint. Best-effort: a 401 (no live SSO session) or a
 * network error is not the verdict — the /health poll that follows is.
 */
async function postRecovery(pathname: string): Promise<void> {
  try {
    await fetch(`${gatewayBase()}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // ssodh/init wants a body; reauthenticate ignores one.
      body: JSON.stringify({ publish: true, compete: true }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Swallowed on purpose — see above.
  }
}

/** Wire the ladder (see silent-recovery.ts) to this script's effects. */
function silentRecoveryDeps(): SilentRecoveryDeps {
  return {
    probeHealth,
    post: postRecovery,
    sleep,
    log,
    budgetMs: SILENT_RECOVERY_BUDGET_MS,
    pollIntervalMs: SILENT_POLL_INTERVAL_MS,
  };
}

// ---------- login flow ----------

async function login(browser: Browser): Promise<LoginOutcome> {
  let reached2FA = false; // did we reach the 2FA device prompt? (i.e. a push was sent)
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    // Match a real browser fingerprint so IBKR doesn't shunt us into
    // extra-suspicious modes (challenge-response fallback, etc.)
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  // Network trace: log every navigation request + response status so we can
  // see what HTTP traffic happens during the 2-min approval wait. If the
  // browser is silent during that window, JS polling isn't working and we
  // need to reload the page manually.
  page.on('request', (req) => {
    if (req.resourceType() === 'document' || req.resourceType() === 'xhr' || req.resourceType() === 'fetch') {
      log(`HTTP ▶ ${req.method()} ${req.url()}`);
    }
  });
  page.on('response', (res) => {
    const t = res.request().resourceType();
    if (t === 'document' || t === 'xhr' || t === 'fetch') {
      log(`HTTP ◀ ${res.status()} ${res.url()}`);
    }
  });

  const debugDir = '/tmp/bezant-relogin';
  await fs.mkdir(debugDir, { recursive: true });
  try {
    log(`Opening ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    log(`Landed on: ${page.url()}`);
    await page.screenshot({ path: `${debugDir}/01-initial.png` });

    // Selectors track CPGateway's stable form. If IBKR redesigns the login
    // page these may need adjusting — confirm against the live page source.
    await page.fill('#user_name, input[name="username"]', USERNAME!);
    await page.fill('#password, input[name="password"]', PASSWORD!);
    await page.screenshot({ path: `${debugDir}/02-filled.png` });
    await page.click('#submitForm, button[type="submit"], input[type="submit"]');

    // Give the post-submit page time to render — useful for screenshot
    await page.waitForTimeout(3000);
    log(`Post-submit URL: ${page.url()}`);
    await page.screenshot({ path: `${debugDir}/03-post-submit.png` });

    // After submitting credentials, IBKR shows a "Select Second Factor Device"
    // dropdown with options like { "IB Key" => "5.2a", "Mobile Authenticator App" => "4" }.
    // Selecting an option triggers the actual push; the page itself doesn't
    // redirect until the user approves on the phone.
    const twoFactorSelect = page.locator('select').first();
    if (await twoFactorSelect.count() > 0 && await twoFactorSelect.isVisible()) {
      log('2FA device prompt detected — selecting IB Key (value=5.2a)');
      reached2FA = true; // from here on, a push has been (or is being) sent
      await twoFactorSelect.selectOption({ value: '5.2a' });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${debugDir}/03b-2fa-selected.png` });
      // Some IBKR flows render a Continue button only after a device is chosen;
      // try common patterns but treat absence as fine — selecting the option
      // is often enough to trigger the push on its own.
      const continueBtn = page.locator(
        'button:has-text("Continue"), input[value="Continue"], button:has-text("Submit"), input[type="submit"]',
      ).first();
      if (await continueBtn.count() > 0 && await continueBtn.isVisible()) {
        log('Clicking Continue/Submit after device selection');
        await continueBtn.click().catch(() => {
          /* non-fatal — selection alone may have already fired the push */
        });
        await page.waitForTimeout(1500);
      }
    }

    log('Submitted credentials + 2FA device. Tap "Approve" on IB Key — waiting up to 2 min...');
    log(`(debug: screenshots in ${debugDir}/, page title: ${await page.title()})`);

    // Use bezant-server's /health as the post-login signal of truth: when
    // CPGateway has minted its internal cookie jar, /health flips to
    // authenticated=true. This sidesteps any need to match a redirect URL.
    //
    // Do NOT reload the page during the wait — IBKR's 2FA flow keeps state
    // in client-side JS, and reloading boots us back to the login form,
    // invalidating any push the user is about to tap.
    const SNAPSHOT_INTERVAL_MS = 20_000;
    const start = Date.now();
    let lastSnapshot = Date.now();
    let snapshotCounter = 0;
    while (Date.now() - start < POST_LOGIN_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
      // Try to bridge SSO → iserver every cycle. Harmless before the
      // tap (returns 401), succeeds shortly after, flips /health to
      // authenticated which exits this loop on the next probe.
      await nudgeSsoBridge();
      const h = await probeHealth();
      if (h?.authenticated) {
        log('IB Key approved — /health.authenticated=true');
        await page.screenshot({ path: `${debugDir}/04-success.png` });
        return 'authenticated';
      }
      // The challenge/response form is an ALTERNATIVE to the push, not its
      // replacement. IBKR shows it within seconds of the device selection,
      // while the push is still live, and EITHER completes the login. Measured
      // on 2026-09-02: challenge visible at 23:34:19, authenticated at
      // 23:34:27 by a tap, no code ever entered.
      //
      // So seeing it means nothing on its own and must not end the wait. The
      // first version returned here the moment the box appeared — which, on
      // the sequence above, would have abandoned the login three seconds in,
      // parked the fund and paged the operator, eight seconds before it would
      // have succeeded by itself. Note the challenge, keep waiting for the tap,
      // and let the verdict be decided by whether a session appears.
      //
      // (Do NOT reach for page.evaluate here: tsx's esbuild transform injects a
      // `__name` helper into any named function it serialises, which does not
      // exist in the page, so every such call throws ReferenceError.
      // assisted-login.ts evaluates source strings for that reason.
      // Playwright's own locator API is unaffected.)
      if (lastChallenge === null) {
        for (const frame of page.frames()) {
          const responseBox = frame.locator(
            'input[placeholder*="Response" i], input[name*="response" i], input[name*="challenge" i], #chlginput',
          ).first();
          if (await responseBox.count() > 0 && await responseBox.isVisible().catch(() => false)) {
            const frameText = await frame.locator('body').innerText().catch(() => '');
            lastChallenge = frameText.match(/Challenge:?\s*([0-9][0-9 ]{4,})/i)?.[1].trim() ?? 'unparsed';
            log(`IBKR is also offering challenge/response (challenge: ${lastChallenge}) — ` +
                `still waiting for the push, which completes the login on its own`);
            await page.screenshot({ path: `${debugDir}/04-challenge.png` });
            break;
          }
        }
      }
      if (Date.now() - lastSnapshot >= SNAPSHOT_INTERVAL_MS) {
        snapshotCounter += 1;
        log(`Snapshot (URL: ${page.url()})`);
        try {
          await page.screenshot({ path: `${debugDir}/wait-${snapshotCounter}.png` });
        } catch {
          /* non-fatal */
        }
        lastSnapshot = Date.now();
      }
    }
    // If we reached the 2FA device prompt, a push WAS sent and the user simply
    // didn't approve in time — that is push_timeout regardless of the URL:
    // IBKR renders the 2FA prompt without leaving /sso/Login, so checking
    // "still on the login page" here misclassified every missed tap as
    // "wedged", which restarted bezant and fired a SECOND push before the
    // failure latch tripped (observed 2026-08-28, ~25h outage). Wedged means
    // exactly one thing: credentials submitted but the 2FA prompt never
    // appeared — only then does a bezant restart help.
    // Only now, with the window spent and no session, does the challenge
    // matter: it says WHY this failed and what can still fix it. A run that saw
    // a challenge cannot be recovered by another push — the operator has to
    // answer it — so it is reported as `challenge`, not `push_timeout`.
    const outcome: LoginOutcome = lastChallenge ? 'challenge' : reached2FA ? 'push_timeout' : 'wedged';
    log(`Timed out (final URL: ${page.url()}) — classified "${outcome}" (reached2FA=${reached2FA})`);
    await page.screenshot({ path: `${debugDir}/04-timeout.png` });
    return outcome;
  } catch (err) {
    log(`Login failed: ${(err as Error).message}`);
    try {
      await page.screenshot({ path: `${debugDir}/99-error.png` });
    } catch {}
    return 'error';
  } finally {
    await ctx.close();
  }
}

// ---------- main ----------

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [relogin] ${msg}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Best-effort alert to an optional webhook (Slack/Discord/ntfy `{"text"}`).
 * No-op when IBKR_FUND_ALERT_WEBHOOK is unset.
 */
async function alert(text: string): Promise<void> {
  if (!ALERT_WEBHOOK) return;
  try {
    await fetch(ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `:rotating_light: [ibkr-fund-relogin] ${text}` }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    log(`alert webhook failed: ${(err as Error).message}`);
  }
}

/**
 * Restart the bezant container to clear a wedged CPGateway session — the state
 * where the login page is stuck on /sso/Login and no 2FA push is ever sent.
 * This is the exact manual fix that recovered a ~2-week silent outage. Waits
 * for /health to respond again. Requires the runner to be in the `docker` group.
 */
async function restartBezant(): Promise<boolean> {
  log(`Restarting "${BEZANT_CONTAINER}" to clear a wedged gateway...`);
  try {
    await execAsync(`docker restart ${BEZANT_CONTAINER}`, { timeout: 60_000 });
  } catch (err) {
    log(`docker restart ${BEZANT_CONTAINER} FAILED: ${(err as Error).message}`);
    return false;
  }
  for (let i = 0; i < 12; i++) {
    await sleep(5_000);
    if ((await probeHealth()) !== null) {
      log(`"${BEZANT_CONTAINER}" responsive again after restart`);
      return true;
    }
  }
  log(`"${BEZANT_CONTAINER}" did not respond within 60s after restart`);
  return false;
}

// ---------- termination-safe finalisation ----------

/**
 * Self-imposed ceiling on a whole run, kept BELOW the unit's TimeoutStartSec
 * (420s) so we always finish on our own terms. When systemd is the one to call
 * time, it SIGTERMs mid-flight: Playwright's browser is torn down under the
 * login, the outcome is misrecorded as a generic `error`, and — because
 * MAX_CONSECUTIVE_FAILURES is 1 — the fund parks itself until a human taps a
 * push. That is exactly how 2026-08-20 turned a recoverable wedge into a
 * 3.5-day outage.
 */
const RUN_DEADLINE_MS = 380_000;

let finalized = false;
let activeState: KeepaliveState | null = null;

/**
 * Record a failed attempt and, at the threshold, disable + alert. Safe to call
 * from a signal handler: it is idempotent, and it awaits the webhook so the
 * alert actually leaves the process before we exit. systemd allows
 * TimeoutStopSec (90s by default) between SIGTERM and SIGKILL, which is ample
 * for alert()'s 8s budget.
 */
async function finalizeFailure(outcome: LoginOutcome | 'terminated', reason: string): Promise<void> {
  if (finalized) return;
  finalized = true;

  const state = activeState ?? (await loadState());
  state.consecutiveFailures += 1;

  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    await setDisabled();
    log(
      `Hit ${MAX_CONSECUTIVE_FAILURES} consecutive failure(s) (last outcome: ${outcome}) — ` +
        `disabling further automatic attempts. Manual reset required (see top-of-file comment).`,
    );
    // Both of these are the feed's, not Slack's. They read as emergencies, but
    // they are not ones you can act on from a notification: the fix is a login
    // you have to be present for, and pi.lan/ibkr shows this state whenever you
    // open it. Waking someone at 03:00 for a fund that will stay logged out
    // until they are awake anyway bought nothing but the habit of ignoring the
    // channel.
    //
    // A challenge still gets its own wording: clearing the sentinel and
    // re-running relogin cannot fix it, because relogin has no way to type a
    // response code. Saying "tap a push" here is what made this failure a
    // surprise twice.
    if (outcome === 'challenge') {
      feed({
        source: 'relogin',
        severity: 'critical',
        title: 'IBKR asked for a challenge code, not a push — the fund is logged out',
        detail:
          `Automatic re-login cannot answer a challenge.${lastChallenge ? ` Challenge shown: ${lastChallenge} (now expired).` : ''} ` +
          `Start a login from pi.lan/ibkr and answer it there — the page shows the challenge ` +
          `and takes the response code from the phone that generated it.`,
      });
    } else {
      feed({
        source: 'relogin',
        severity: 'critical',
        title: `Re-login failed (${outcome}) — auto-relogin is parked and the fund is logged out`,
        detail: `${reason}. Start a login from pi.lan/ibkr when you can tap an IB Key push; the nightly pre-market re-key will also unpark and try once.`,
      });
    }
  }

  await saveState(state);
}

async function finalizeSuccess(): Promise<void> {
  if (finalized) return;
  // The other half of the announcement above: a push that is never mentioned
  // again leaves the operator unsure whether their tap actually landed. That
  // still matters — but only while you are looking, and by then you are on
  // pi.lan/ibkr, which says it live. As a notification it was the single
  // noisiest thing on the channel: four of them one night, none actionable.
  feed({
    source: 'relogin',
    severity: 'recovery',
    title: 'IBKR session is back — the fund is trading again',
  });
  finalized = true;

  const state = activeState ?? (await loadState());
  state.consecutiveFailures = 0;
  state.lastSuccessAt = new Date().toISOString();
  await saveState(state);
}

/** Bail out cleanly on a signal or our own deadline, with state + alert flushed. */
function installTerminationHandlers(): void {
  const bail = (reason: string) => {
    log(`Run cut short (${reason}) — recording the attempt before exiting.`);
    void finalizeFailure('terminated', reason).finally(() => process.exit(1));
  };

  process.on('SIGTERM', () => bail('SIGTERM — likely systemd TimeoutStartSec'));
  process.on('SIGINT', () => bail('SIGINT'));
  setTimeout(() => bail(`self-imposed ${RUN_DEADLINE_MS / 1000}s run deadline`), RUN_DEADLINE_MS).unref();
}

async function main(): Promise<void> {
  if (!USERNAME || !PASSWORD) {
    log('FATAL: IBKR_USERNAME or IBKR_PASSWORD not set in .env');
    process.exit(2);
  }

  installTerminationHandlers();

  if (await isDisabled()) {
    log('disabled sentinel present — exiting. Reset with: rm ~/.local/state/bezant-relogin/disabled');
    process.exit(0);
  }

  const health = await probeHealth();
  if (!health) {
    log(`Could not reach ${HEALTH_URL} — bezant-server may be down. Skipping login attempt.`);
    process.exit(0);
  }

  // The decision itself lives in recovery-plan.ts, where it is unit-testable.
  // It used to be inline here, which is how --force shipped as a silent no-op.
  const plan = planRecovery(health, FORCE);

  if (plan.action === 'nothing-to-do') {
    log('IBKR session healthy — nothing to do');
    process.exit(0);
  }

  if (plan.action === 'credential-only') {
    log('--force given — going straight to a credential login; only a new SSO session will do');
    if (health.authenticated && health.connected) {
      // Replacing a session that currently works: IBKR ends the old one the
      // moment this login starts, so an untapped push leaves the fund logged
      // OUT when it was logged in. ibkr-fund-preflight only asks for this once
      // the session is old enough to be likely to die unattended anyway, and
      // only while the US market is shut.
      log('WARNING: the current session ends now; an untapped push leaves the fund logged out');
    }
  } else {
    log(`Session unhealthy (authenticated=${health.authenticated} connected=${health.connected})`);
  }

  const state = await loadState();
  state.lastAttemptAt = new Date().toISOString();
  activeState = state;

  // Most "unhealthy" ticks are a dropped iserver session with a live SSO
  // session behind it — recoverable in place, with no push. Only escalate to
  // a credential login (and a phone buzz) once that has actually failed.
  // Skipped entirely under 'credential-only' — see recovery-plan.ts for why the
  // silent rungs cannot satisfy a forced refresh.
  if (plan.action === 'silent-then-credential' && (await trySilentRecovery(silentRecoveryDeps()))) {
    await finalizeSuccess();
    process.exit(0);
  }

  log('Starting credential login — an IB Key push is about to be sent');
  // Say so on Slack, before the phone buzzes. Until now the only messages this
  // sent were failures, so an IB Key prompt arriving out of nowhere gave the
  // operator no way to tell an expected re-login from someone else trying to
  // get into the account — and "was that me?" is not a question you want to be
  // guessing at while a 2-minute approval window runs down.
  // Suppressed when the caller has already said it. preflight sends a richer
  // heads-up (hours parked, minutes to the US open) and then invokes this
  // script, so without the guard the operator gets two near-identical messages
  // seconds apart — the fastest way to train someone to ignore both.
  if (process.env.RELOGIN_PUSH_ALERT === 'already-sent') {
    log('push notice suppressed — the caller has already announced it');
  } else await alert(
    `:key: *IBKR session expired — logging in now.* An IB Key push is on its way; ` +
      `*tap Approve*. (Automatic re-login, triggered by ${process.env.INVOCATION_ID ? 'the relogin timer' : 'a manual run'} ` +
      `at ${new Date().toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney' })}.) ` +
      `If you did NOT expect this, do not approve it.`,
  );

  const browser = await chromium.launch({ headless: true });
  let outcome: LoginOutcome = 'error';
  try {
    outcome = await login(browser);

    // Wedged gateway (no push was sent): restart bezant to clear the wedge and
    // retry the login once on a fresh gateway. This auto-performs the exact
    // manual fix for the failure mode that silently took the fund down for ~2
    // weeks — and it sends no extra push (the wedge produced none). A genuine
    // missed tap (push_timeout) is NOT retried here, to avoid push spam.
    if (outcome === 'wedged') {
      log('Wedged gateway detected (no 2FA push sent) — restarting bezant and retrying once.');
      if (await restartBezant()) {
        const h = await probeHealth();
        outcome = h?.authenticated ? 'authenticated' : await login(browser);
      }
    }
  } finally {
    await browser.close();
  }

  const success = outcome === 'authenticated';
  if (success) {
    await finalizeSuccess();
  } else {
    await finalizeFailure(outcome, 'login did not reach an authenticated session');
  }

  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  log(`Fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
