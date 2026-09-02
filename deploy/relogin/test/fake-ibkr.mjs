/**
 * A fake IBKR Client Portal Gateway, faithful to the parts that kept breaking
 * assisted-login.ts against the real one.
 *
 * Built after a night of debugging against production, where every iteration
 * cost an IB Key push, an operator's attention, and a single-use response code.
 * Three detectors shipped and failed there. None of them could have shipped if
 * this existed first.
 *
 * What it reproduces, and why each part is here:
 *
 *  - **The challenge form lives in an iframe.** The live page reports
 *    `frames=2` with `document.body` empty — which is why main-frame CSS
 *    queries, an innerText scan and a shadow-piercing DOM walk all read nothing
 *    while the screenshot showed the form plainly. `--cross-origin` serves that
 *    iframe from a second port, so a detector that only works same-origin fails
 *    here instead of in production.
 *  - **The response code is single-use.** A second submission is rejected
 *    whatever the first one did. That is what turned a correct code into
 *    "Authentication failed" on 2026-09-02: the fallback pressed Enter *and*
 *    clicked Login.
 *  - **The challenge is optional.** Per the operator: approve the push and
 *    IBKR *sometimes* follows with a challenge, sometimes just logs you in.
 *    `--mode` picks which.
 *  - **The form's geometry.** The response box and Login button sit where they
 *    sit on the real page in a 1280x720 viewport, so the pixel fallback is
 *    exercised for real rather than against a convenient layout.
 *
 * Usage:
 *   node fake-ibkr.mjs [--port 8099] [--mode challenge|push-only|wrong-code]
 *                      [--cross-origin] [--approve-after-ms 1500]
 *
 * State is exposed at GET /_test/state for assertions (submission count etc).
 */
import http from 'node:http';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const PORT = Number(opt('port', 8099));
const FRAME_PORT = PORT + 1;
const MODE = opt('mode', 'challenge'); // challenge | push-only | wrong-code
const CROSS_ORIGIN = flag('cross-origin');
const APPROVE_AFTER_MS = Number(opt('approve-after-ms', 1500));

const EXPECTED_CODE = '99887766';
const CHALLENGE = '111 222';

const state = {
  credentialsSeen: false,
  deviceSelected: false,
  pushApprovedAt: null,
  challengeShown: false,
  submissions: [],      // every response code the page received, in order
  authenticated: false,
};

const send = (res, code, body, type = 'text/html') => {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
};

/** True once enough time has passed that the operator would have tapped. */
const approved = () => state.pushApprovedAt !== null && Date.now() >= state.pushApprovedAt;

const loginPage = `<!doctype html><html><body style="font-family:sans-serif">
  <h3>Log In</h3>
  <form method="POST" action="/sso/Login">
    <input id="user_name" name="username">
    <input id="password" name="password" type="password">
    <button id="submitForm" type="submit">Login</button>
  </form>
</body></html>`;

const devicePage = `<!doctype html><html><body style="font-family:sans-serif">
  <h3>Select Second Factor Device</h3>
  <form method="POST" action="/sso/Device">
    <select name="device"><option value="">--</option><option value="5.2a">IB Key</option></select>
    <button type="submit">Continue</button>
  </form>
  <script>document.querySelector('select').addEventListener('change', () => document.forms[0].submit());</script>
</body></html>`;

// Polls with fetch and navigates ONCE, rather than reloading on a timer. A
// reload loop tears down the page's execution context every second, so
// `frame.evaluate` throws at random and the caller sees an empty page — which
// is a bug in the fake, not in the thing under test, and it cost a debugging
// round to tell them apart.
const pushPage = `<!doctype html><html><body style="font-family:sans-serif;text-align:center">
  <h3>Open the IBKR notification on your phone</h3>
  <p>IBKR sent you a notification. Tap the notification to complete two-factor authentication.</p>
  <script>
    setInterval(async () => {
      const r = await fetch('/_test/approved').then((x) => x.json()).catch(() => ({ approved: false }));
      if (r.approved) location.href = '/';
    }, 500);
  </script>
</body></html>`;

/**
 * The page the automation actually has to beat: an EMPTY top-level document
 * whose only content is an iframe. Nothing here is readable from the main
 * frame's DOM, exactly as observed in production.
 */
const challengeShell = (frameOrigin) => `<!doctype html><html><body style="margin:0">
  <iframe src="${frameOrigin}/challenge-frame" style="border:0;width:1280px;height:720px"></iframe>
</body></html>`;

/** Geometry matches the real form in a 1280x720 viewport. */
const challengeFrame = (error) => `<!doctype html><html><body style="margin:0;font-family:sans-serif;text-align:center">
  <div style="padding-top:140px">
    <p>Enter the challenge code below into the IBKR Mobile app to generate a response code.</p>
    <p>Challenge: ${CHALLENGE}</p>
    <form method="POST" action="/challenge-frame" style="margin:0">
      <input name="response" placeholder="Enter Response Code"
             style="display:block;margin:0 auto;width:414px;height:46px;position:absolute;top:307px;left:433px;font-size:18px">
      <button type="submit"
             style="position:absolute;top:410px;left:433px;width:414px;height:46px;font-size:18px">Login</button>
    </form>
    ${error ? '<div style="position:absolute;top:470px;left:433px;width:414px;color:#b00">Authentication failed</div>' : ''}
  </div>
</body></html>`;

function route(req, res, isFramePort) {
  const url = new URL(req.url, `http://localhost:${isFramePort ? FRAME_PORT : PORT}`);
  const frameOrigin = CROSS_ORIGIN ? `http://127.0.0.1:${FRAME_PORT}` : '';

  if (url.pathname === '/health') {
    return send(res, 200, JSON.stringify({
      authenticated: state.authenticated,
      connected: state.authenticated,
      competing: false,
      message: '',
    }), 'application/json');
  }
  if (url.pathname === '/_test/approved') {
    return send(res, 200, JSON.stringify({ approved: approved() }), 'application/json');
  }
  if (url.pathname === '/_test/state') {
    return send(res, 200, JSON.stringify(state, null, 1), 'application/json');
  }
  if (url.pathname.startsWith('/v1/api/')) {
    return send(res, 200, JSON.stringify({ wait: true }), 'application/json');
  }

  // ── the login flow ─────────────────────────────────────────────────────────
  if (url.pathname === '/sso/Login' && req.method === 'POST') {
    state.credentialsSeen = true;
    return send(res, 200, devicePage);
  }
  if (url.pathname === '/sso/Device' && req.method === 'POST') {
    state.deviceSelected = true;
    // The push is "approved" on the operator's phone a moment later.
    state.pushApprovedAt = Date.now() + APPROVE_AFTER_MS;
    return send(res, 200, pushPage);
  }
  if (url.pathname === '/challenge-frame') {
    if (req.method === 'POST') {
      return readBody(req, (body) => {
        const code = new URLSearchParams(body).get('response') ?? '';
        state.submissions.push(code);
        // Single-use: only the FIRST submission can ever succeed.
        // Single-use: a code already seen can never succeed again. But a NEW
        // code still can — which is what makes a typo recoverable, and what the
        // old "one submission per run" latch made impossible.
        const fresh = state.submissions.filter((c) => c === code).length === 1;
        if (fresh && code === EXPECTED_CODE && MODE !== 'wrong-code') {
          state.authenticated = true;
          return send(res, 200, '<html><body>Welcome</body></html>');
        }
        return send(res, 200, challengeFrame(true));
      });
    }
    return send(res, 200, challengeFrame(false));
  }

  // Root: whichever screen the flow is currently on.
  if (state.deviceSelected && approved()) {
    if (MODE === 'push-only') {
      state.authenticated = true;
      return send(res, 200, '<html><body>Welcome</body></html>');
    }
    state.challengeShown = true;
    return send(res, 200, challengeShell(frameOrigin));
  }
  if (state.deviceSelected) return send(res, 200, pushPage);
  if (state.credentialsSeen) return send(res, 200, devicePage);
  return send(res, 200, loginPage);
}

function readBody(req, done) {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => done(body));
}

http.createServer((req, res) => route(req, res, false)).listen(PORT, () => {
  console.log(`[fake-ibkr] gateway on http://localhost:${PORT} (mode=${MODE}, crossOrigin=${CROSS_ORIGIN})`);
});
// The iframe's origin. Same process, different port — that is all "cross-origin"
// means to a browser, and it is enough to break a same-origin-only detector.
http.createServer((req, res) => route(req, res, true)).listen(FRAME_PORT, () => {
  console.log(`[fake-ibkr] frame origin on http://127.0.0.1:${FRAME_PORT}`);
});
