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
 * Run via: npx tsx index.ts
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, type Browser } from 'playwright';

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
type LoginOutcome = 'authenticated' | 'push_timeout' | 'wedged' | 'error';

// ---------- config ----------

const HEALTH_URL = process.env.BEZANT_HEALTH_URL ?? 'http://localhost:8080/health';
const LOGIN_URL = process.env.BEZANT_LOGIN_URL ?? 'https://localhost:5000';
const USERNAME = process.env.IBKR_USERNAME;
const PASSWORD = process.env.IBKR_PASSWORD;
const POST_LOGIN_TIMEOUT_MS = 2 * 60 * 1000; // 2 min for IB Key tap
const HEALTH_POLL_INTERVAL_MS = 5_000;
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
  try {
    const base = HEALTH_URL.replace(/\/health$/, '');
    await fetch(`${base}/v1/api/iserver/auth/ssodh/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publish: true, compete: true }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Best-effort; the next poll will retry. Failures here are expected
    // when there's no SSO session yet (CPGateway returns 401).
  }
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
    // If we never reached the 2FA prompt (no push), or we're still stuck on the
    // login page, the gateway is wedged — a bezant restart clears it. If we DID
    // reach 2FA, a push was sent and the user simply didn't approve in time.
    const stuckOnLogin = /\/sso\/Login/i.test(page.url());
    const outcome: LoginOutcome = reached2FA && !stuckOnLogin ? 'push_timeout' : 'wedged';
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

async function main(): Promise<void> {
  if (!USERNAME || !PASSWORD) {
    log('FATAL: IBKR_USERNAME or IBKR_PASSWORD not set in .env');
    process.exit(2);
  }

  if (await isDisabled()) {
    log('disabled sentinel present — exiting. Reset with: rm ~/.local/state/bezant-relogin/disabled');
    process.exit(0);
  }

  const health = await probeHealth();
  if (!health) {
    log(`Could not reach ${HEALTH_URL} — bezant-server may be down. Skipping login attempt.`);
    process.exit(0);
  }

  if (health.authenticated && health.connected) {
    log('IBKR session healthy — nothing to do');
    process.exit(0);
  }

  log(`Session unhealthy (authenticated=${health.authenticated} connected=${health.connected}) — starting login`);

  const state = await loadState();
  state.lastAttemptAt = new Date().toISOString();

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
    state.consecutiveFailures = 0;
    state.lastSuccessAt = new Date().toISOString();
  } else {
    state.consecutiveFailures += 1;
  }

  if (!success && state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    await setDisabled();
    log(
      `Hit ${MAX_CONSECUTIVE_FAILURES} consecutive failure(s) (last outcome: ${outcome}) — ` +
        `disabling further automatic attempts. Manual reset required (see top-of-file comment).`,
    );
    await alert(
      `IBKR re-login failed (${outcome}) — auto-relogin is now DISABLED and the fund is logged out. ` +
        `Reset when you can tap an IB Key push:\n` +
        `ssh your-pi 'rm -f ~/.local/state/bezant-relogin/disabled && systemctl --user start ibkr-fund-relogin.service'`,
    );
  }

  await saveState(state);
  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  log(`Fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
