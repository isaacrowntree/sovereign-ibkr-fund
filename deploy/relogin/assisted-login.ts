/**
 * Operator-assisted IBKR login, for the half of the second factor that no
 * unattended script can answer.
 *
 * IBKR offers TWO routes through 2FA, at the same time:
 *
 *   - the IB Key push, tapped on the phone; and
 *   - a challenge/response form, shown on the page within seconds of the
 *     device selection:
 *
 *     Enter the challenge code below into the IBKR Mobile app to generate a
 *     response code.   Challenge: 111 222   [ Enter Response Code ]  [Login]
 *
 * EITHER completes the login. Measured 2026-09-02: the form appeared at
 * 23:34:19 and a tap authenticated the session at 23:34:27, no code entered.
 * The form appearing is therefore NOT evidence that the push has died, and is
 * not a reason to stop waiting — an earlier version of index.ts treated it as
 * both, and would have abandoned that login three seconds before it succeeded.
 *
 * What an unattended run cannot do is ANSWER the form; that needs a person with
 * IBKR Mobile. When nobody taps in time the run ends with the form on screen
 * and no way to use it — four runs on 2026-09-01/02 ended exactly that way.
 * This script is the other half: it holds the page open long enough for a human
 * to take either route.
 *
 * This script keeps the browser alive and hands that step to the operator over
 * two files, so it works fine over SSH with no TTY:
 *
 *   1. It logs in and waits. If the push IS approved in time, it finishes there
 *      and never asks for anything — same happy path as index.ts.
 *   2. If the challenge screen appears, it writes the challenge digits to
 *      $STATE/challenge.txt and polls $STATE/response.txt.
 *   3. The operator generates the response code (IBKR Mobile → Avatar →
 *      Two-Factor Authentication → enter challenge) and writes it to that file.
 *   4. It types the code, submits, and waits for /health to flip.
 *
 * On success it also repairs the state the rest of the system reads: clears the
 * `disabled` sentinel and resets state.json, so relogin, preflight and the
 * 09:00 check all see an honest "last successful login" rather than a session
 * that appeared from nowhere.
 *
 * Deliberately manual: it is never run by a timer, and it sends exactly one
 * push per invocation, so it cannot spam a phone the way a retry loop would.
 *
 *   npx tsx assisted-login.ts
 */
import 'dotenv/config';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { feed } from '../lib/ops-feed.js';

const HEALTH_URL = process.env.BEZANT_HEALTH_URL ?? 'http://localhost:8080/health';
const LOGIN_URL = process.env.BEZANT_LOGIN_URL ?? 'https://localhost:5000';
const USERNAME = process.env.IBKR_USERNAME;
const PASSWORD = process.env.IBKR_PASSWORD;

const STATE_DIR = process.env.BEZANT_RELOGIN_STATE_DIR
  ?? path.join(os.homedir(), '.local', 'state', 'bezant-relogin');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const DISABLED_FILE = path.join(STATE_DIR, 'disabled');

// Where the two halves of the conversation live. Under /tmp on purpose: this is
// per-run scratch, and a stale challenge from an old run must never be mistaken
// for a live one — hence the wipe in main().
const IO_DIR = process.env.ASSISTED_IO_DIR ?? '/tmp/bezant-assisted';
const CHALLENGE_FILE = path.join(IO_DIR, 'challenge.txt');
const RESPONSE_FILE = path.join(IO_DIR, 'response.txt');
// Read by the hub to render the page; see publishStatus().
const STATUS_FILE = path.join(IO_DIR, 'status.json');
const DEBUG_DIR = process.env.ASSISTED_DEBUG_DIR ?? '/tmp/bezant-assisted-shots';

// Generous by design. The whole point is that a human is in the loop, and the
// 2-minute budget that suits an unattended run is exactly what turned a
// successful approval into a timeout.
const TOTAL_BUDGET_MS = Number(process.env.ASSISTED_BUDGET_MS ?? 20 * 60 * 1000);
const POLL_MS = 3_000;
// Pixel coordinates of the challenge form in the default 1280x720 viewport,
// measured off the run's own screenshots. Used only when the DOM cannot be
// reached at all — see the fallback in run().
const RESPONSE_BOX_XY = { x: 640, y: 330 };
const LOGIN_BUTTON_XY = { x: 640, y: 433 };
const SSODH_INIT_PATH = '/v1/api/iserver/auth/ssodh/init';

const ALERT_WEBHOOK = process.env.IBKR_FUND_ALERT_WEBHOOK;

// The phone that generates the response code should be the phone that enters
// it: relaying six digits through SSH is the slowest and most error-prone part
// of this flow, and it burned two valid codes on 2026-09-02. That page is the
// hub's `/ibkr`, not this script's — see AssistedStatus below. This URL is only
// for telling the operator where to go.
const WEB_URL = process.env.ASSISTED_WEB_URL ?? 'http://pi.lan/ibkr';

const log = (m: string) => console.log(`[${new Date().toISOString()}] [assisted] ${m}`);

/**
 * The caller may have already told the operator a push is coming — preflight
 * does, with more context than this script has (hours parked, minutes to the
 * open). Two near-identical messages seconds apart teach people to ignore both.
 */
const PUSH_ALREADY_ANNOUNCED = process.env.RELOGIN_PUSH_ALERT === 'already-sent';

/**
 * Slack/ntfy-compatible `{"text": ...}` webhook, no-op when unset.
 *
 * This script exists because a challenge appears where a push was expected, and
 * the challenge is only visible to whoever is watching the Pi. Putting it on the
 * phone that has to answer it is the difference between a two-minute fix and an
 * outage that waits for someone to go looking.
 */
async function announcePush(text: string): Promise<void> {
  if (PUSH_ALREADY_ANNOUNCED) {
    log('push notice suppressed — the caller has already announced it');
    return;
  }
  await alert(text);
}

async function alert(text: string): Promise<void> {
  if (!ALERT_WEBHOOK) return;
  try {
    await fetch(ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    /* an undelivered alert must never fail the login it is describing */
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probeHealth(): Promise<{ authenticated: boolean; connected: boolean } | null> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 401) return { authenticated: false, connected: false };
    return (await res.json()) as { authenticated: boolean; connected: boolean };
  } catch {
    return null;
  }
}

/**
 * CPGateway validates the SSO half on approval but does not bridge it to the
 * typed-API session on its own; index.ts nudges this on every poll for the same
 * reason. Failures are swallowed — the /health probe is the verdict, not this.
 */
/**
 * Poke the SSO bridge, and REPORT WHAT IT SAID.
 *
 * This used to swallow the answer entirely, and that silence cost an operator
 * a whole evening on 2026-09-03: every one of these returned HTTP 500, so a
 * completed 2FA could never become an authenticated session, and the failure
 * surfaced only as "your login timed out". Three correct response codes and
 * several taps were spent on what was never a 2FA problem.
 *
 * 401 is the healthy answer before a login lands — the bridge is there and
 * saying "not yet". 5xx is the wedged Client Portal Gateway inside the
 * container: bezant relays upstream status verbatim, so a 500 here is the
 * GATEWAY's, and it persists until the container is restarted.
 *
 * Returns the HTTP status, or 0 when the request itself failed.
 */
async function nudgeSsoBridge(): Promise<number> {
  try {
    const res = await fetch(`${HEALTH_URL.replace(/\/health$/, '')}${SSODH_INIT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publish: true, compete: true }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.status;
  } catch {
    return 0;
  }
}

// Read and driven through a shadow-piercing DOM walk rather than Playwright
// locators. Two detectors failed on the live page before this one: `page`-only
// CSS (2026-09-01, challenge 111 222) and then a frame-by-frame `innerText`
// scan (challenge 111 222). Both times the screenshot showed the form plainly.
// `innerText` does not cross a shadow root and neither does a plain CSS query,
// so the walk below descends into every `shadowRoot` it finds. It is more code
// than a selector, and it is the only thing observed to actually work.
const CHALLENGE_RE = /Challenge:?\s*([0-9][0-9 ]{4,})/i;

/**
 * IBKR's "now tap the push" screen.
 *
 * This is the step that made the whole flow look broken. A correct response
 * code does NOT finish the login — IBKR answers it by sending an IB Key push
 * and showing "Tap the notification to complete two-factor authentication".
 * The operator, watching a page that only ever spoke about challenges, saw the
 * next challenge appear instead and assumed their code had been rejected. They
 * then generated another response, and another, each one rotating the
 * challenge and burning an attempt, while the notification they actually
 * needed to tap sat unread on their phone.
 *
 * Matching it does two things: it stops the rejection heuristic below from
 * mislabelling this screen, and it lets the page say the one thing that
 * actually moves the login forward.
 */
const PUSH_WAIT_RE = /tap the notification|open the ibkr notification|sent you a notification/i;

/** Consecutive 5xx from the SSO bridge before we call it wedged (~3 polls). */
const SSO_FAULT_THRESHOLD = 3;



/**
 * Every text node on the page: main frame, child frames, shadow roots.
 *
 * The frame half is what production needed. The live page reports `frames=2`
 * with an empty top-level body — the challenge form is inside an iframe — so a
 * walk of `document` alone returns 0 characters and the detector concludes
 * there is nothing on screen while the screenshot shows the form plainly.
 */
async function deepText(page: Page): Promise<string> {
  // Retried once because a frame that is mid-navigation destroys its execution
  // context and `evaluate` throws — a transient that must not be reported as
  // "the page is empty", which is exactly how a broken read looks.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const texts = await Promise.all(page.frames().map((f) => frameText(f).catch((e) => {
      // Never swallow this silently: an unreadable frame and an empty frame look
      // identical downstream, and telling them apart is most of the debugging.
      lastReadError = `${f.url()}: ${String((e as Error).message ?? e).split('\n')[0]}`;
      return '';
    })));
    const joined = texts.join(' ').trim();
    if (joined) return joined;
    await sleep(250);
  }
  return '';
}

let lastReadError: string | null = null;

/**
 * Both browser-side routines are evaluated as SOURCE STRINGS, not as functions.
 *
 * This is the bug that cost a night of production debugging. tsx compiles with
 * esbuild's `keepNames`, which rewrites every named function — including the
 * arrow functions inside an `evaluate()` callback — into `__name(fn, "fn")`.
 * `__name` is a Node-side helper that does not exist in the page, so each call
 * threw `ReferenceError: __name is not defined` the instant it ran. The error
 * was caught and turned into "" by the caller, so a working page read as an
 * empty one, and three successive "detectors" were written to fix a DOM problem
 * that never existed: main-frame CSS, a frame innerText scan, and a
 * shadow-piercing walk all failed for this single reason.
 *
 * A string is opaque to the compiler, so what runs in the page is what is
 * written here. Nothing inside these strings may rely on TypeScript.
 */
const DEEP_TEXT_JS = `(() => {
  var out = [];
  var walk = function (root) {
    out.push(root.textContent || '');
    root.querySelectorAll('*').forEach(function (el) {
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  };
  if (document.body) walk(document.body);
  return out.join(' ');
})()`;

/**
 * `strict` picks ONLY a box that identifies itself as the response field.
 * The loose pass — any visible text input — is a last resort and is dangerous
 * on this page: the SSO login form has a username box, and typing a response
 * code into that submits gibberish as a username, which fails in a way that
 * looks exactly like a rejected code. So the two passes are separated and
 * every frame gets the strict one before any frame gets the loose one.
 *
 * Returns a description of the field it used, or '' — so the log can say WHERE
 * the code went. It reports the field's identity, never the code itself.
 */
const submitJs = (code: string, strict: boolean) => `(() => {
  var inputs = [];
  var buttons = [];
  var walk = function (root) {
    root.querySelectorAll('input').forEach(function (el) { inputs.push(el); });
    root.querySelectorAll('button, input[type="submit"]').forEach(function (el) { buttons.push(el); });
    root.querySelectorAll('*').forEach(function (el) { if (el.shadowRoot) walk(el.shadowRoot); });
  };
  if (!document.body) return '';
  walk(document.body);
  var ident = function (i) {
    return (i.placeholder || '') + ' ' + (i.name || '') + ' ' + (i.id || '');
  };
  var box = inputs.filter(function (i) { return /response|challenge/i.test(ident(i)); })[0];
  ${'' /* the loose pass is opt-in */}
  if (!box && ${strict ? 'false' : 'true'}) {
    box = inputs.filter(function (i) {
      // never the credential fields, whatever else happens
      return i.type === 'text' && i.offsetParent !== null && !/user|login|email/i.test(ident(i));
    })[0];
  }
  if (!box) return '';
  box.focus();
  box.value = ${JSON.stringify(code)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.dispatchEvent(new Event('change', { bubbles: true }));
  // Read it back. If the field did not take the value — a framework that
  // controls it, a readonly box — clicking Login submits nothing or worse,
  // something stale, and the operator is told their correct code failed.
  if (box.value !== ${JSON.stringify(code)}) return '';
  var login = buttons.filter(function (b) {
    return /login|submit|continue/i.test(b.textContent || b.value || '');
  })[0];
  if (login) login.click();
  else if (box.form && box.form.requestSubmit) box.form.requestSubmit();
  return (ident(box).trim() || 'unnamed input') + ' @ ' + location.host;
})()`;

async function frameText(frame: Frame): Promise<string> {
  return frame.evaluate(DEEP_TEXT_JS) as Promise<string>;
}

/**
 * Type the response code into the box and submit it, in whichever frame holds
 * it. Sets `.value` and dispatches input/change by hand, because a framework
 * rendering the form is usually not listening for anything else.
 */
async function submitResponse(page: Page, code: string): Promise<string> {
  // Strict across every frame first, loose across every frame only after.
  for (const strict of [true, false]) {
    for (const frame of page.frames()) {
      const where = await frame.evaluate(submitJs(code, strict)).catch((e) => {
        lastReadError = `${frame.url()}: ${String((e as Error).message ?? e).split('\n')[0]}`;
        return '';
      });
      if (where) return `${where}${strict ? '' : ' (loose match)'}`;
    }
  }
  return '';
}

/**
 * The state the operator's page renders, published as a file.
 *
 * This used to be an HTTP server and hand-written HTML inside this script,
 * which meant a second web surface on the Pi: its own port, its own CSS, its
 * own HTML escaping, no nav, and no existence except during a login. The Pi
 * already has a web framework — the hub on :80, Jinja2 templates with
 * autoescape, one shared layout — so the page belongs there and this script
 * publishes state for it to render. The file is the whole contract: this repo
 * knows nothing about the hub, and the hub knows nothing about Playwright.
 */
interface AssistedStatus {
  status: 'waiting' | 'challenge' | 'submitting' | 'pushwait' | 'rejected' | 'authenticated' | 'failed';
  challenge: string | null;
  attemptsLeft: number;
  note: string | null;
  updatedAt: string;
  /**
   * The three timestamps the operator's page needs to say something useful
   * rather than just display digits.
   *
   * A challenge is not valid forever — IBKR rotates it, and a response
   * generated against a rotated one is rejected. A run is not open-ended
   * either: it ends at `expiresAt`, after which typing a code achieves
   * nothing. Without these the page can only show a number and hope, which is
   * how someone ends up carefully entering a code that expired minutes ago.
   */
  startedAt: string | null;
  expiresAt: string | null;
  challengeAt: string | null;
}

const ui: AssistedStatus = {
  status: 'waiting',
  challenge: null,
  startedAt: null,
  expiresAt: null,
  challengeAt: null,
  attemptsLeft: 0,
  note: null,
  updatedAt: new Date().toISOString(),
};

/**
 * A response code is digits. Checked here as well as in the page that collects
 * it: the page is the convenience, this is the boundary that decides what is
 * ever sent to IBKR, and wrong answers are not free with a broker.
 */
const CODE_RE = /^[0-9]{4,12}$/;

/**
 * How many codes one run will send to IBKR. More than one because a typo must
 * be correctable; few, for the reason above.
 */
const MAX_SUBMISSIONS = 3;

/**
 * Written on every state change AND once per poll as a heartbeat, then read by
 * the hub. `updatedAt` is what marks a login as still in progress, so the
 * heartbeat is not decoration — it is the whole contract.
 *
 * It was missing, and the failure was ugly: this loop's quietest moment is
 * exactly when a human is squinting at a phone typing a response code, so a
 * login published nothing for minutes precisely when it was most alive. The
 * hub's staleness check then concluded it was dead and took away the form the
 * operator was mid-way through using. Called with no patch, this merges
 * nothing and only refreshes the timestamp.
 */
async function publishStatus(patch: Partial<AssistedStatus> = {}): Promise<void> {
  Object.assign(ui, patch, { updatedAt: new Date().toISOString() });
  await fs.mkdir(IO_DIR, { recursive: true });
  await fs.writeFile(STATUS_FILE, `${JSON.stringify(ui, null, 2)}\n`).catch((e) => {
    log(`could not publish status: ${e}`);
  });
}

async function markSuccess(): Promise<void> {
  const now = new Date().toISOString();
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    /* first run, or unreadable — a fresh object is the right answer either way */
  }
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(
    STATE_FILE,
    `${JSON.stringify({ ...state, consecutiveFailures: 0, lastAttemptAt: now, lastSuccessAt: now }, null, 2)}\n`,
  );
  await fs.rm(DISABLED_FILE, { force: true });
  log('state.json updated and the disabled sentinel cleared — automation is armed again');
}

async function run(browser: Browser): Promise<boolean> {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await fs.mkdir(DEBUG_DIR, { recursive: true });

  await publishStatus({ status: 'waiting' });

  log(`Opening ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.fill('#user_name, input[name="username"]', USERNAME!);
  await page.fill('#password, input[name="password"]', PASSWORD!);
  await page.click('#submitForm, button[type="submit"], input[type="submit"]');
  await page.waitForTimeout(3_000);

  const deviceSelect = page.locator('select').first();
  if (await deviceSelect.count() > 0 && await deviceSelect.isVisible()) {
    log('2FA device prompt — selecting IB Key (value=5.2a); a push is being sent');
    await announcePush(
      ':key: *IBKR assisted login started* — an IB Key push is on its way; *tap Approve*. ' +
        `If IBKR asks for a challenge code instead, it will appear at ${WEB_URL} and here. ` +
        'If you did NOT expect this, do not approve it.',
    );
    await deviceSelect.selectOption({ value: '5.2a' });
    await page.waitForTimeout(2_000);
    const cont = page.locator('button:has-text("Continue"), input[value="Continue"], button:has-text("Submit")').first();
    if (await cont.count() > 0 && await cont.isVisible()) await cont.click().catch(() => {});
  }
  // The real flow, per the operator who has answered these all week: the push
  // lands immediately, and once approved IBKR SOMETIMES follows it with a
  // challenge screen and sometimes just logs in. So this waits on both outcomes
  // continuously rather than treating the challenge as a two-minute timeout
  // fallback — the earlier framing, which described a wait that does not exist.
  log('Waiting: approve the push. IBKR may then ask for a challenge/response code — watching for both.');

  const started = Date.now();
  await publishStatus({
    attemptsLeft: MAX_SUBMISSIONS,
    startedAt: new Date(started).toISOString(),
    expiresAt: new Date(started + TOTAL_BUDGET_MS).toISOString(),
  });
  // Codes already sent to IBKR. A SET, not a boolean: the old latch stopped the
  // same single-use code being submitted twice (right) and also stopped a
  // CORRECTED code being submitted after a rejection (wrong) — one typo ended
  // the run, costing another push, another challenge and 20 more minutes.
  const sentToIbkr = new Set<string>();
  // Consecutive 5xx from the SSO bridge. A single one is noise; a run of them
  // is the gateway telling you it cannot finish any login at all.
  let ssoFaults = 0;
  // The challenge that was on screen when we last submitted. A push wait
  // belongs to THAT challenge; the moment IBKR shows a different one it has
  // moved on and the operator needs to answer the new one.
  let challengeAtSubmit: string | null = null;
  let announcedChallenge: string | null = null;
  let shot = 0;

  while (Date.now() - started < TOTAL_BUDGET_MS) {
    await sleep(POLL_MS);
    // Heartbeat first, before any of the work below can throw or hang. A login
    // that is waiting on a human is still a live login, and the hub has no
    // other way to know that.
    await publishStatus();

    const ssoStatus = await nudgeSsoBridge();
    if (ssoStatus >= 500) ssoFaults += 1;
    else if (ssoStatus > 0) ssoFaults = 0;
    // Announced ONCE, and loudly. There is no point asking for another code
    // against a gateway that cannot complete the handshake — say so plainly
    // rather than letting it look like the operator's codes are wrong.
    if (ssoFaults === SSO_FAULT_THRESHOLD) {
      const note = `The gateway's SSO bridge is failing (HTTP ${ssoStatus}). This is a GATEWAY fault, `
        + 'not a 2FA problem — a code entered now cannot complete the login. '
        + 'Restart the bezant container, then start a new login.';
      log(`SSO BRIDGE WEDGED — ${SSODH_INIT_PATH} returned ${ssoStatus} ${ssoFaults}x in a row. ${note}`);
      await publishStatus({ note });
      feed({
        source: 'relogin',
        severity: 'critical',
        title: `IBKR gateway SSO bridge is wedged (HTTP ${ssoStatus})`,
        detail: note,
      });
    }
    const health = await probeHealth();
    if (health?.authenticated) {
      log('Authenticated — /health.authenticated=true');
      // Feed, not Slack: this run only ever happens because a human started it
      // and is watching the page, which says "Session restored" the moment
      // this does. A push telling you what the screen in your hand already
      // says is the definition of the noise this channel was drowning in.
      feed({
        source: 'relogin',
        severity: 'recovery',
        title: 'IBKR session is back — assisted login succeeded',
      });
      await page.screenshot({ path: `${DEBUG_DIR}/success.png` }).catch(() => {});
      await publishStatus({ status: 'authenticated', attemptsLeft: 0, note: null });
      return true;
    }

    const text = await deepText(page);
    if (!announcedChallenge && text.length < 40) {
      // One line per poll would be noise; this fires only while the page is
      // opaque to us, which is exactly when we want to know about it.
      log(`(diag: deepText=${text.length} chars, frames=${page.frames().length}, url=${page.url()}` +
          `${lastReadError ? `, lastReadError=${lastReadError}` : ''})`);
    }
    const challenge = text.match(CHALLENGE_RE)?.[1].trim() ?? null;

    // The push screen is checked FIRST and short-circuits the rejection test
    // below. Both can look similar in page text, and calling a push wait a
    // rejection is the error that sent the operator round the loop.
    // TWO different push waits, and conflating them broke the login.
    //
    // IBKR shows push wording at the START of every run — it sends a push the
    // moment IB Key is selected, before any code exists — and again AFTER a
    // response code is accepted. Only the second one means "your code worked,
    // go tap". Suppressing the challenge on the first one hid the challenge
    // form completely: observed 2026-09-03, a run sat for nine minutes with a
    // challenge plainly on screen and nothing published for the operator.
    // A push wait ends when IBKR asks something new. Bounding it by a clock
    // instead was a guess about how long a tap "should" take; the gateway
    // moving to different digits is the gateway telling us directly.
    const rotated = challenge !== null && challengeAtSubmit !== null
      && challenge !== challengeAtSubmit;
    // Say it out loud. This transition is the difference between an operator
    // tapping a notification and an operator typing a code, and leaving it
    // implicit is what made the stuck-in-pushwait bug so hard to see from the
    // outside — the page simply stopped changing.
    if (rotated && ui.status === 'pushwait') {
      log('IBKR rotated the challenge — push wait is over, asking for a new code');
    }
    const awaitingPush = PUSH_WAIT_RE.test(text);
    const postSubmitPush = awaitingPush
      && (ui.status === 'submitting' || ui.status === 'pushwait')
      && !rotated;
    if (postSubmitPush) {
      if (ui.status !== 'pushwait') {
        await publishStatus({
          status: 'pushwait',
          note: 'Your response code was accepted. IBKR has sent an IB Key push — tap it on your phone to finish.',
        });
        log('Response accepted — IBKR is now waiting for an IB Key push to be tapped');
      }
    }

    // IBKR rejects a code on the page, not over the API, so the page text is
    // the only place this is visible. Seeing it matters: it is what turns a
    // silent 20-minute wait into "generate another one".
    else if (/authentication failed|invalid|incorrect/i.test(text) && ui.status === 'submitting') {
      await publishStatus({
        status: 'rejected',
        note: 'IBKR rejected that code. Generate a new one — codes are single-use.',
      });
      log('IBKR rejected the submitted code — waiting for another');
    }

    // Announce each DISTINCT challenge once. Re-announcing the same digits every
    // poll would race the operator; never re-announcing means a challenge that
    // IBKR rotates after a rejection is one the operator can no longer answer.
    if (challenge && challenge !== announcedChallenge && !postSubmitPush) {
      await page.screenshot({ path: `${DEBUG_DIR}/challenge.png` }).catch(() => {});
      await fs.writeFile(CHALLENGE_FILE, `${challenge}\n`);
      await publishStatus({
        challenge,
        challengeAt: new Date().toISOString(),
        status: ui.status === 'submitting' ? ui.status : 'challenge',
      });
      log(`CHALLENGE CODE: ${challenge}`);
      await alert(
        `:1234: *IBKR wants a challenge/response code.* Challenge: *${challenge}*\n` +
          `IBKR Mobile -> Avatar -> Two-Factor Authentication -> enter that, then type the response at ` +
          `${WEB_URL} (open it on your phone).\n` +
          `Or, from a terminal: ssh your-pi 'echo <RESPONSE> > ${RESPONSE_FILE}'\n` +
          `This login is holding the page open for it.`,
      );
      log('Enter it in IBKR Mobile (Avatar -> Two-Factor Authentication) and write the');
      log(`response code to: ${RESPONSE_FILE}`);
      announcedChallenge = challenge;
    }

    // Submission does NOT wait for the challenge to be recognised. Detection has
    // failed twice on a page that was plainly showing the form; a response code
    // the operator has already generated must not be held hostage to it.
    if (sentToIbkr.size < MAX_SUBMISSIONS) {
      const code = await fs.readFile(RESPONSE_FILE, 'utf8').then((c) => c.trim()).catch(() => '');
      // Skip codes already sent: re-submitting a single-use code is guaranteed
      // to fail and spends one of the few wrong answers IBKR tolerates.
      if (code && CODE_RE.test(code) && !sentToIbkr.has(code)) {
        log(`Response code received (${code.length} chars) — submitting`);
        let typed = await submitResponse(page, code);
        if (!typed) {
          // Every DOM route has failed on this page: main-frame CSS, a
          // frame-by-frame innerText scan, and the shadow-piercing walk above,
          // all while page.screenshot() showed the form perfectly. Whatever
          // renders it is not reachable from the main execution context — so
          // stop asking the DOM and use the pixels, which are the one thing
          // demonstrably right. The response box sits mid-form and the Login
          // button below it in a 1280x720 viewport; a click focuses it however
          // it is implemented.
          log('DOM submission found no box — falling back to mouse + keyboard');
          await page.mouse.click(RESPONSE_BOX_XY.x, RESPONSE_BOX_XY.y);
          await page.keyboard.type(code, { delay: 40 });
          await page.screenshot({ path: `${DEBUG_DIR}/typed.png` }).catch(() => {});
          // EXACTLY ONE submission. The first version pressed Enter and then
          // clicked Login, which submits a single-use response code twice: the
          // second attempt is rejected no matter what the first did, and the
          // page ends on "Authentication failed" over a code that may well have
          // been right. Observed 2026-09-02 with challenge 111 222.
          await page.mouse.click(LOGIN_BUTTON_XY.x, LOGIN_BUTTON_XY.y);
          typed = `pixel fallback @ ${RESPONSE_BOX_XY.x},${RESPONSE_BOX_XY.y}`;
        }
        sentToIbkr.add(code);
        challengeAtSubmit = ui.challenge;
        await publishStatus({
          status: 'submitting',
          attemptsLeft: MAX_SUBMISSIONS - sentToIbkr.size,
          note: null,
        });
        await page.waitForTimeout(3_000);
        await page.screenshot({ path: `${DEBUG_DIR}/post-response.png` }).catch(() => {});
        // WHICH field took the code, by name — so "are you sure it went in the
        // right box?" is answerable from the log instead of by inference. The
        // code itself is never logged; only its length, above.
        log(`Submitted into [${typed}]. Post-submit URL: ${page.url()}`);
      }
    }

    // Cheap, and the only reliable view of this page: overwritten every poll so
    // there is always a current one to look at.
    await page.screenshot({ path: `${DEBUG_DIR}/latest.png` }).catch(() => {});

    if ((Date.now() - started) / 20_000 > shot) {
      shot += 1;
      await page.screenshot({ path: `${DEBUG_DIR}/wait-${shot}.png` }).catch(() => {});
    }
  }

  log('Budget exhausted without an authenticated session');
  await page.screenshot({ path: `${DEBUG_DIR}/timeout.png` }).catch(() => {});
  // This one stays a notification. It can only follow a login you started
  // yourself, so it is bounded by your own actions rather than by the Pi's
  // clock — and it is the message that tells you to walk back to the page,
  // which you have by then almost certainly closed.
  await alert(
    ':x: *IBKR assisted login ended without a session* — the push was not approved and no working ' +
      'response code arrived. The fund is still logged out.',
  );
  feed({
    source: 'relogin',
    severity: 'critical',
    title: 'Assisted login ended without a session',
    detail: 'The push was not approved and no working response code arrived. The fund is still logged out.',
  });
  await publishStatus({
    status: 'failed',
    attemptsLeft: 0,
    note: 'The login timed out before a session was established.',
  });
  return false;
}

async function main(): Promise<void> {
  if (!USERNAME || !PASSWORD) {
    log('FATAL: IBKR_USERNAME / IBKR_PASSWORD not set (expected in deploy/relogin/.env)');
    process.exit(1);
  }
  const health = await probeHealth();
  if (health?.authenticated) {
    log('Already authenticated — nothing to do, and no push sent');
    process.exit(0);
  }
  if (!health) {
    log(`FATAL: ${HEALTH_URL} did not answer — fix the gateway before spending a login`);
    process.exit(1);
  }

  // A challenge left over from an earlier run is worse than none: the operator
  // would type digits IBKR has already forgotten, and the stale response file
  // would be submitted the instant this run's box appeared.
  await fs.rm(IO_DIR, { recursive: true, force: true });
  await fs.mkdir(IO_DIR, { recursive: true });

  // The harness points this at whatever browser build the machine already has.
  // On the Pi it is unset and Playwright picks its own, which is the only
  // behaviour production ever sees.
  const executablePath = process.env.ASSISTED_BROWSER_PATH || undefined;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const ok = await run(browser);
    if (ok) await markSuccess();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    // Anything thrown before or during the loop — a gateway that stops
    // answering mid-navigation, a page that never renders — used to exit
    // silently. The operator is by definition waiting on a phone at this point.
    const why = String((e as Error).stack ?? e).split('\n')[0];
    log(`FATAL: ${why}`);
    await alert(`:x: *IBKR assisted login crashed* — \`${why}\`. The fund is still logged out.`);
    feed({
      source: 'relogin',
      severity: 'critical',
      title: 'Assisted login crashed',
      detail: `${why}. The fund is still logged out.`,
    });
    process.exit(1);
  } finally {
    await browser.close().catch(() => {});
  }
}

void main();
