/**
 * Operator-assisted IBKR login, for the case the unattended relogin cannot win:
 * IBKR's **challenge/response** fallback.
 *
 * Observed 2026-09-01. index.ts submits credentials, selects IB Key, and waits
 * two minutes for the push to be approved. If it is not approved inside that
 * window, IBKR does not simply fail — the page switches to:
 *
 *     Enter the challenge code below into the IBKR Mobile app to generate a
 *     response code.   Challenge: 416 346   [ Enter Response Code ]  [Login]
 *
 * There is no push to tap any more; the login can only be completed by a human
 * reading a code out of IBKR Mobile and typing it back. index.ts had already
 * torn the browser down by then and classified the run `push_timeout`, so three
 * attempts in a row "sent a push" that had, by the time anyone looked, become a
 * form nobody was filling in.
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
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

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
// it. Relaying six digits through SSH — or through a third party reading them
// off a screenshot — is the slowest and most error-prone part of this flow, and
// it is the part that burned two valid codes on 2026-09-02. So the run serves a
// one-page form on the LAN for as long as it is waiting, and nothing longer:
// the server dies with the process, and there is no listener between logins.
const WEB_PORT = Number(process.env.ASSISTED_WEB_PORT ?? 8777);
const WEB_HOST = process.env.ASSISTED_WEB_HOST ?? 'pi.lan';
const WEB_URL = `http://${WEB_HOST}:${WEB_PORT}`;

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
async function nudgeSsoBridge(): Promise<void> {
  try {
    await fetch(`${HEALTH_URL.replace(/\/health$/, '')}${SSODH_INIT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publish: true, compete: true }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* see above */
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

const submitJs = (code: string) => `(() => {
  var inputs = [];
  var buttons = [];
  var walk = function (root) {
    root.querySelectorAll('input').forEach(function (el) { inputs.push(el); });
    root.querySelectorAll('button, input[type="submit"]').forEach(function (el) { buttons.push(el); });
    root.querySelectorAll('*').forEach(function (el) { if (el.shadowRoot) walk(el.shadowRoot); });
  };
  if (!document.body) return false;
  walk(document.body);
  var box = inputs.filter(function (i) {
    return /response|challenge/i.test((i.placeholder || '') + ' ' + (i.name || '') + ' ' + (i.id || ''));
  })[0] || inputs.filter(function (i) { return i.type === 'text' && i.offsetParent !== null; })[0];
  if (!box) return false;
  box.focus();
  box.value = ${JSON.stringify(code)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.dispatchEvent(new Event('change', { bubbles: true }));
  var login = buttons.filter(function (b) {
    return /login|submit|continue/i.test(b.textContent || b.value || '');
  })[0];
  if (login) login.click();
  else if (box.form && box.form.requestSubmit) box.form.requestSubmit();
  return true;
})()`;

async function frameText(frame: Frame): Promise<string> {
  return frame.evaluate(DEEP_TEXT_JS) as Promise<string>;
}

/**
 * Type the response code into the box and submit it, in whichever frame holds
 * it. Sets `.value` and dispatches input/change by hand, because a framework
 * rendering the form is usually not listening for anything else.
 */
async function submitResponse(page: Page, code: string): Promise<boolean> {
  for (const frame of page.frames()) {
    const done = await frame.evaluate(submitJs(code)).catch((e) => {
      lastReadError = `${frame.url()}: ${String((e as Error).message ?? e).split('\n')[0]}`;
      return false;
    });
    if (done) return true;
  }
  return false;
}

/**
 * Everything the page needs to know, kept in one place so the HTTP handler and
 * the browser loop cannot disagree about what is happening.
 */
const ui = {
  challenge: null as string | null,
  status: 'waiting' as 'waiting' | 'challenge' | 'submitting' | 'rejected' | 'authenticated' | 'failed',
  lastCode: null as string | null,
  note: null as string | null,
  attemptsLeft: 0,
};

/**
 * A response code is digits. Rejecting anything else at the door means a stray
 * or malicious POST from the LAN costs nothing: it never reaches IBKR, so it
 * cannot spend one of the few wrong answers an account tolerates.
 */
const CODE_RE = /^[0-9]{4,12}$/;

/**
 * How many codes one run will send to IBKR. More than one because a typo must
 * be correctable — see the retry loop in run() — and not many, because wrong
 * answers are not free with a broker.
 */
const MAX_SUBMISSIONS = 3;

/**
 * Everything interpolated into the page is escaped. `lastCode` and `note` come
 * from a POST body, so a LAN device could otherwise inject script into a page
 * the operator opens on their phone while logging into a brokerage account.
 */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

const page_css = `
  body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#f6f7f9;color:#111}
  .card{max-width:420px;margin:8vh auto;background:#fff;border-radius:14px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
  h1{font-size:17px;margin:0 0 4px} p{color:#555;font-size:14px;line-height:1.45}
  .challenge{font-size:40px;font-weight:600;letter-spacing:3px;text-align:center;margin:18px 0;font-variant-numeric:tabular-nums}
  input{width:100%;box-sizing:border-box;font-size:26px;padding:14px;border:2px solid #cbd2d9;border-radius:10px;text-align:center;letter-spacing:2px}
  button{width:100%;margin-top:14px;padding:15px;font-size:17px;border:0;border-radius:10px;background:#0b5fff;color:#fff;font-weight:600}
  .ok{color:#0a7a3d;font-weight:600} .wait{color:#8a6d00;font-weight:600} .bad{color:#b00020;font-weight:600}
`;

function form(buttonLabel: string): string {
  return `<form method="POST" action="/">
      <input name="code" inputmode="numeric" autocomplete="one-time-code" autofocus placeholder="response code">
      <button type="submit">${buttonLabel}</button>
    </form>
    <p>${ui.attemptsLeft} attempt${ui.attemptsLeft === 1 ? '' : 's'} left this login.</p>`;
}

function renderPage(): string {
  const note = ui.note ? `<p class="bad">${esc(ui.note)}</p>` : '';
  const challenge = ui.challenge
    ? `<p>In IBKR Mobile: <b>Avatar → Two-Factor Authentication</b>, enter this challenge:</p>
       <div class="challenge">${esc(ui.challenge)}</div>`
    : '';

  switch (ui.status) {
    case 'authenticated':
      return html('Logged in', '<p class="ok">✅ Session restored — the fund is trading again. You can close this.</p>');
    case 'failed':
      // A terminal page, not a dead socket: the run is over and the phone must
      // be told, or the last thing it ever said is "waiting for IBKR".
      return html('Login did not complete', `<p class="bad">❌ This login has ended without a session.</p>${note}
        <p>Start another from the Pi:<br><code>npx tsx assisted-login.ts</code></p>`);
    case 'submitting':
      return html('Submitting…', `<p class="wait">Sent <b>${esc(ui.lastCode ?? '')}</b> — waiting for IBKR.</p>
        <p>This page refreshes itself.</p>`);
    case 'rejected':
      return html('IBKR rejected that code', `${note}
        <p>Response codes are single-use — generate a <b>new</b> one for the challenge below.</p>
        ${challenge}${ui.attemptsLeft > 0 ? form('Try again') : '<p class="bad">No attempts left this login.</p>'}`);
    case 'challenge':
      return html('Enter response code', `${note}${challenge}${form('Submit')}`);
    default:
      return html('Waiting for IBKR', `${note}<p class="wait">Login started. Approve the IB Key push if it arrives.</p>
        <p>If IBKR asks for a challenge code instead, it will appear here automatically.</p>`);
  }
}

// A refresh keeps the page honest without a websocket: the states it moves
// between are seconds apart and it is one form on a phone, not an app.
function html(title: string, body: string): string {
  const settled = ui.status === 'authenticated' || ui.status === 'failed';
  const refresh = settled ? '' : '<meta http-equiv="refresh" content="3">';
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">${refresh}
    <title>IBKR login</title><style>${page_css}</style></head>
    <body><div class="card"><h1>${esc(title)}</h1>${body}</div></body></html>`;
}

/**
 * Serves the form for the life of the run. Bound to every interface because the
 * point is to reach it from the phone; it exposes one challenge and accepts
 * response codes, never credentials, and only while a login this host started
 * is already in flight.
 */
function startWebServer(onCode: (code: string) => void): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      let aborted = false;
      req.on('data', (c) => {
        body += c;
        // A form field is a few bytes. Anything larger is not an operator, and
        // an unbounded string on a listening socket is a way to exhaust the
        // memory of the process holding the login open.
        if (body.length > 4096 && !aborted) {
          aborted = true;
          res.writeHead(413).end();
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        const code = (new URLSearchParams(body).get('code') ?? '').replace(/\s+/g, '');
        if (!CODE_RE.test(code)) {
          ui.note = code ? 'That does not look like a response code — it should be 6 to 8 digits.' : 'Enter the code from IBKR Mobile.';
          log(`Rejected a malformed submission from the form (${code.length} chars) — not sent to IBKR`);
        } else {
          ui.note = null;
          ui.lastCode = code;
          ui.status = 'submitting';
          onCode(code);
          log(`Response code received from ${WEB_URL} (${code.length} chars)`);
        }
        res.writeHead(303, { Location: '/' });
        res.end();
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage());
  });
  server.listen(WEB_PORT, '0.0.0.0', () => log(`Response form: ${WEB_URL}`));
  // Never let an idle socket hold the process open past the login it serves.
  server.unref();
  return server;
}

/**
 * Let a phone mid-refresh see the terminal page before the socket goes away.
 * Without this the last thing the operator sees is a connection error, which
 * reads as "the Pi broke" rather than "the login ended".
 */
async function settle(server: http.Server, status: 'authenticated' | 'failed', note?: string): Promise<void> {
  ui.status = status;
  if (note) ui.note = note;
  ui.attemptsLeft = 0;
  await sleep(4_000);
  server.close();
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

  // The web form writes to the SAME file the SSH route uses, so there is one
  // path into the login and one place to look when asking what was submitted.
  const server = startWebServer((code) => {
    void fs.writeFile(RESPONSE_FILE, `${code}\n`).catch((e) => log(`could not save response code: ${e}`));
  });

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
  ui.attemptsLeft = MAX_SUBMISSIONS;
  // Codes already sent to IBKR. A SET, not a boolean: the old latch stopped the
  // same single-use code being submitted twice (right) and also stopped a
  // CORRECTED code being submitted after a rejection (wrong) — one typo ended
  // the run, costing another push, another challenge and 20 more minutes.
  const sentToIbkr = new Set<string>();
  let announcedChallenge: string | null = null;
  let shot = 0;

  while (Date.now() - started < TOTAL_BUDGET_MS) {
    await sleep(POLL_MS);
    await nudgeSsoBridge();
    const health = await probeHealth();
    if (health?.authenticated) {
      log('Authenticated — /health.authenticated=true');
      await alert(':white_check_mark: *IBKR session is back* — assisted login succeeded, the fund is trading again.');
      await page.screenshot({ path: `${DEBUG_DIR}/success.png` }).catch(() => {});
      await settle(server, 'authenticated');
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

    // IBKR rejects a code on the page, not over the API, so the page text is
    // the only place this is visible. Seeing it matters: it is what turns a
    // silent 20-minute wait into "generate another one".
    if (/authentication failed|invalid|incorrect/i.test(text) && ui.status === 'submitting') {
      ui.status = 'rejected';
      ui.note = 'IBKR rejected that code. Generate a new one — codes are single-use.';
      log('IBKR rejected the submitted code — waiting for another');
    }

    // Announce each DISTINCT challenge once. Re-announcing the same digits every
    // poll would race the operator; never re-announcing means a challenge that
    // IBKR rotates after a rejection is one the operator can no longer answer.
    if (challenge && challenge !== announcedChallenge) {
      await page.screenshot({ path: `${DEBUG_DIR}/challenge.png` }).catch(() => {});
      await fs.writeFile(CHALLENGE_FILE, `${challenge}\n`);
      ui.challenge = challenge;
      if (ui.status === 'waiting' || ui.status === 'rejected') ui.status = 'challenge';
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
          typed = true;
        }
        sentToIbkr.add(code);
        ui.attemptsLeft = MAX_SUBMISSIONS - sentToIbkr.size;
        ui.lastCode = code;
        ui.status = 'submitting';
        await page.waitForTimeout(3_000);
        await page.screenshot({ path: `${DEBUG_DIR}/post-response.png` }).catch(() => {});
        log(`Submitted (box found: ${typed}). Post-submit URL: ${page.url()}`);
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
  await alert(
    ':x: *IBKR assisted login ended without a session* — the push was not approved and no working ' +
      'response code arrived. The fund is still logged out.',
  );
  await settle(server, 'failed', 'The login timed out before a session was established.');
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
    process.exit(1);
  } finally {
    await browser.close().catch(() => {});
  }
}

void main();
