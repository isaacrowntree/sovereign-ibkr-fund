/**
 * A fake bezant-server, faithful to the parts of it the watchdog reads and
 * pokes. Same idea as relogin/test/fake-ibkr.mjs: the watchdog can bounce the
 * container under a live book, so its decisions are proven here rather than
 * on the Pi.
 *
 * What it reproduces:
 *
 *  - `/health` in every shape the watchdog has to tell apart: 200
 *    authenticated / not, a 401 `not_authenticated`, a 5xx, no answer at all
 *    (`down: true`), and the new `upstream_failing` state — which may
 *    arrive on a 5xx, and must not read as "dead".
 *  - `/events/_status` with `connected` and `last_message_at`.
 *  - `POST /events/_reconnect` gated by `X-Bezant-Debug-Token`, or a 404 to
 *    play an older bezant that does not have it.
 *  - `POST /v1/api/iserver/auth/ssodh/init` and `/iserver/reauthenticate`
 *    with settable status codes.
 *
 * Every POST is recorded, so a test asserts what the watchdog DID, not just
 * what it logged.
 *
 * In-process:   const fake = await startFakeBezant(); fake.set({...}); fake.posts
 * Standalone:   node fake-bezant.mjs [--port 8080]   (GET/POST /_test/state)
 */
import http from 'node:http';

export const DEFAULTS = {
  health: { status: 200, body: { authenticated: true, connected: true, competing: false, message: '' } },
  stream: { status: 200, body: { connected: true, last_message_at: null } },
  // Fresh stream by default: last message "now" at the moment of the request.
  streamFresh: true,
  ssodhInit: 401,
  reauthenticate: 200,
  reconnect: 'token', // 'token' = 200 with the right token else 401; or a number, e.g. 404
  debugToken: 'test-token',
  down: false, // true = drop every connection, like a hung or absent server
};

export async function startFakeBezant({ port = 0, host = '127.0.0.1' } = {}) {
  let cfg = structuredClone(DEFAULTS);
  const posts = [];

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (cfg.down && url.pathname !== '/_test/state') return req.socket.destroy();
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (url.pathname === '/_test/state') {
        if (req.method === 'POST') cfg = { ...cfg, ...JSON.parse(raw || '{}') };
        return send(res, 200, { cfg, posts });
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, cfg.health.status, cfg.health.body);
      }
      if (req.method === 'GET' && url.pathname === '/events/_status') {
        const body = { ...cfg.stream.body };
        if (cfg.streamFresh) body.last_message_at = new Date().toISOString();
        return send(res, cfg.stream.status, body);
      }
      if (req.method !== 'POST') return send(res, 404, { code: 'not_found' });

      posts.push({ path: url.pathname, token: req.headers['x-bezant-debug-token'] ?? null, body: raw });
      if (url.pathname === '/events/_reconnect') {
        if (typeof cfg.reconnect === 'number') return send(res, cfg.reconnect, {});
        return req.headers['x-bezant-debug-token'] === cfg.debugToken
          ? send(res, 200, { reconnecting: true })
          : send(res, 401, { code: 'debug_unauthorized' });
      }
      if (url.pathname === '/v1/api/iserver/auth/ssodh/init') return send(res, cfg.ssodhInit, {});
      if (url.pathname === '/v1/api/iserver/reauthenticate') return send(res, cfg.reauthenticate, {});
      return send(res, 404, { code: 'not_found' });
    });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const { port: bound } = server.address();
  return {
    url: `http://${host}:${bound}`,
    posts,
    /** Shallow-merge into the fake's behaviour. */
    set(patch) {
      cfg = { ...cfg, ...patch };
    },
    reset() {
      cfg = structuredClone(DEFAULTS);
      posts.length = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--port');
  const fake = await startFakeBezant({ port: i > 0 ? Number(process.argv[i + 1]) : 8080 });
  console.log(`fake bezant on ${fake.url}`);
}
