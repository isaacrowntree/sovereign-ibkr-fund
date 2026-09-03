import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  alert,
  notify,
  getNotifier,
  webhookNotifier,
  noopNotifier,
  type DedupeHooks,
  type NotifyEvent,
} from './index.js';

/**
 * The notifier had no tests at all, while `alert()` sits on the drawdown
 * hard-stop path (risk-manager). Its never-throws guarantee, the getNotifier
 * precedence table, and the payload shape were all unverified.
 *
 * Uses vi.spyOn for fetch, NOT direct assignment: vi.restoreAllMocks() does not
 * undo an assignment, which would leave later tests — and the FIRST test in the
 * file, before any assignment — talking to the real network.
 */

const HOOK = 'https://hooks.slack.com/services/T/B/xxx';

let fetchSpy: ReturnType<typeof vi.spyOn>;
const savedEnv = { ...process.env };

/** Queue of responses; each fetch call shifts one. */
let responses: Array<Response | Error>;

function respond(...rs: Array<Response | Error>) {
  responses = rs;
}
const ok = () => new Response('ok', { status: 200 });
const status = (s: number, body = '') => new Response(body, { status: s });

beforeEach(() => {
  // Env hygiene. A parent env can inject the real webhook into every worker
  // (`dr npm test` via doppler does exactly this), and webhookNotifier reads
  // process.env directly — so an un-stubbed fetch would POST to real Slack.
  delete process.env.IBKR_FUND_ALERT_WEBHOOK;
  delete process.env.NOTIFIER;
  delete process.env.TRADING_MODE;

  responses = [];
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const r = responses.shift() ?? ok();
    if (r instanceof Error) throw r;
    return r;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
});

/** Parsed bodies of every fetch call made. */
function bodies(): unknown[] {
  return fetchSpy.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
}

describe('the webhook is never contacted by accident', () => {
  it('has no webhook configured at the start of the very first test', () => {
    expect(process.env.IBKR_FUND_ALERT_WEBHOOK).toBeUndefined();
  });
});

describe('a malformed webhook URL must not leak the credential into logs', () => {
  // fetch('hooks.slack.com/...') throws "Failed to parse URL from <full secret>",
  // and that message goes to logError → the systemd journal. Verified: this is
  // the ONLY failure path that leaks (a DNS failure is just "fetch failed").
  const SECRET_PATH = 'hooks.slack.com/services/T01ABCDEF/B02GHIJKL/SuperSecretTokenXYZ';

  it.each([
    ['scheme-less', SECRET_PATH],
    ['garbage', 'not a url at all'],
    ['unsupported scheme', 'ftp://hooks.slack.com/services/T01/B02/SuperSecretTokenXYZ'],
  ])('refuses to send to a %s URL rather than letting fetch throw with it', async (_label, url) => {
    process.env.IBKR_FUND_ALERT_WEBHOOK = url;
    await expect(alert('x')).resolves.toBeUndefined();
    expect(fetchSpy, 'never hand an unparseable URL to fetch').not.toHaveBeenCalled();
  });

  it('accepts a well-formed https webhook', async () => {
    process.env.IBKR_FUND_ALERT_WEBHOOK = HOOK;
    await alert('x');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('getNotifier precedence', () => {
  const cases: Array<[string | undefined, boolean, 'webhook' | 'noop']> = [
    ['noop', true, 'noop'],
    ['noop', false, 'noop'],
    ['NOOP', true, 'noop'], // toLowerCase
    ['webhook', true, 'webhook'],
    ['webhook', false, 'webhook'], // explicit override wins even with no URL
    [undefined, true, 'webhook'],
    [undefined, false, 'noop'],
    ['garbage', true, 'webhook'], // falls through to the URL check
    ['garbage', false, 'noop'],
  ];

  it.each(cases)('NOTIFIER=%s webhookSet=%s → %s', (notifier, hasHook, expected) => {
    if (notifier) process.env.NOTIFIER = notifier;
    if (hasHook) process.env.IBKR_FUND_ALERT_WEBHOOK = HOOK;
    expect(getNotifier()).toBe(expected === 'noop' ? noopNotifier : webhookNotifier);
  });

  it('webhook selected but URL unset → logs suppressed and posts NOTHING', async () => {
    process.env.NOTIFIER = 'webhook';
    await alert('hi');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('alert() posts exactly {text}, exactly once', () => {
  beforeEach(() => { process.env.IBKR_FUND_ALERT_WEBHOOK = HOOK; });

  it('sends the bare {text} shape — no blocks, no attachments', async () => {
    await alert('🚨 IBKR fund HARD STOP');
    expect(bodies()).toEqual([{ text: '🚨 IBKR fund HARD STOP' }]);
  });

  it('sets content-type and an abort signal', async () => {
    await alert('x');
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.signal).toBeDefined();
  });

  // The regression guard that matters: alert() must NOT inherit notify()'s
  // 400 fallback. Asserting the body shape alone cannot catch it — both POSTs
  // would carry {text} — so assert the CALL COUNT.
  it.each([400, 403, 404, 410, 429, 500, 503])('does not retry on %i — exactly one POST', async (s) => {
    respond(status(s, 'err'));
    await alert('x');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('alert() never throws — it is on the hard-stop path', () => {
  beforeEach(() => { process.env.IBKR_FUND_ALERT_WEBHOOK = HOOK; });

  it('resolves on a 500', async () => {
    respond(status(500, 'boom'));
    await expect(alert('x')).resolves.toBeUndefined();
  });

  it('resolves when fetch rejects', async () => {
    respond(new Error('ECONNREFUSED'));
    await expect(alert('x')).resolves.toBeUndefined();
  });

  it('resolves on an abort (the 10s timeout)', async () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    respond(e);
    await expect(alert('x')).resolves.toBeUndefined();
  });

  it('resolves when the error body itself fails to read', async () => {
    const bad = { status: 500, ok: false, text: () => Promise.reject(new Error('stream broke')) };
    fetchSpy.mockImplementation(async () => bad as unknown as Response);
    await expect(alert('x')).resolves.toBeUndefined();
  });
});

describe('notify() HTTP handling', () => {
  const ev: NotifyEvent = { severity: 'critical', title: 'HARD STOP' };
  beforeEach(() => { process.env.IBKR_FUND_ALERT_WEBHOOK = HOOK; });

  it('sends text + attachments and reports delivered', async () => {
    respond(ok());
    await expect(webhookNotifier.notify(ev)).resolves.toBe(true);
    const b = bodies()[0] as Record<string, unknown>;
    expect(b.text).toBeTruthy();
    expect(b.attachments).toHaveLength(1);
  });

  it('400 → retries once as plain text, and that counts as delivered', async () => {
    respond(status(400, 'invalid_attachments'), ok());
    await expect(webhookNotifier.notify(ev)).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const second = bodies()[1] as Record<string, unknown>;
    expect(Object.keys(second)).toEqual(['text']); // fallback carries no blocks
  });

  it('400 → 400 stops at two calls (no recursion)', async () => {
    respond(status(400, 'a'), status(400, 'b'));
    await expect(webhookNotifier.notify(ev)).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // A 429 is a 4xx. Retrying it doubles our rate exactly when Slack said stop.
  it('429 → exactly one call, no text fallback, not delivered', async () => {
    respond(status(429, 'rate_limited'));
    await expect(webhookNotifier.notify(ev)).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404, 410, 500, 503])('%i → exactly one call, not delivered', async (s) => {
    respond(status(s));
    await expect(webhookNotifier.notify(ev)).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('transport failure → not delivered, does not throw', async () => {
    respond(new Error('network down'));
    await expect(webhookNotifier.notify(ev)).resolves.toBe(false);
  });
});

describe('noop notifier', () => {
  it('never touches the network', async () => {
    process.env.NOTIFIER = 'noop';
    await alert('x');
    await notify({ severity: 'info', title: 'y' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports not-delivered, so a claim would be released rather than stuck', async () => {
    await expect(noopNotifier.notify({ severity: 'info', title: 'y' })).resolves.toBe(false);
  });
});

describe('notify() never throws', () => {
  beforeEach(() => { process.env.IBKR_FUND_ALERT_WEBHOOK = HOOK; });

  // blocks.ts being "pure" is not a guarantee it cannot throw, and notify()
  // will sit on the hard-stop path. This is the test whose absence would have
  // let a renderer bug take down a trading agent.
  it('resolves when the RENDERER throws', async () => {
    const hostile = {
      severity: 'critical',
      get title(): string { throw new Error('renderer boom'); },
    } as unknown as NotifyEvent;
    await expect(notify(hostile)).resolves.toBeUndefined();
  });

  it('resolves when the dedupe store throws, and still sends (fail open)', async () => {
    const hooks: DedupeHooks = {
      claim: () => { throw new Error('db locked'); },
      release: () => {},
    };
    respond(ok());
    await expect(
      notify({ severity: 'critical', title: 'HARD STOP', dedupe: { key: 'k' } }, hooks),
    ).resolves.toBeUndefined();
    expect(fetchSpy, 'a dedupe failure must never be why you did not hear').toHaveBeenCalledTimes(1);
  });

  it('resolves when release throws after a failed send', async () => {
    const hooks: DedupeHooks = {
      claim: () => true,
      release: () => { throw new Error('db locked'); },
    };
    respond(status(500));
    await expect(notify({ severity: 'info', title: 'x', dedupe: { key: 'k' } }, hooks)).resolves.toBeUndefined();
  });
});

describe('notify() claim lifecycle', () => {
  beforeEach(() => { process.env.IBKR_FUND_ALERT_WEBHOOK = HOOK; });

  function spyHooks(claimReturns = true) {
    const released: string[] = [];
    const claimed: Array<[string, string, number]> = [];
    const hooks: DedupeHooks = {
      claim: (k, f, t) => { claimed.push([k, f, t]); return claimReturns; },
      release: (k) => { released.push(k); },
    };
    return { hooks, released, claimed };
  }

  it("channel:'ops' records the event but sends nothing", async () => {
    const { hooks } = spyHooks();
    await notify({ severity: 'info', title: 'digest', channel: 'ops', dedupe: { key: 'k' } }, hooks);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("channel:'ops' STILL claims its dedupe key", async () => {
    // Not a detail. The daily digest is the only 'ops' event with a dedupe
    // policy, and its claim row (`digest:<date>`) is what the nightly backup
    // reads to prove the digest agent ran. An early return above the claim
    // would leave that row unwritten and the backup would report a dead digest
    // every night — which is the exact false alarm it was fixed for once
    // already.
    const { hooks, claimed } = spyHooks();
    await notify({ severity: 'info', title: 'digest', channel: 'ops',
                   dedupe: { key: 'digest:2026-09-02' } }, hooks);
    expect(claimed.map((c) => c[0])).toEqual(['digest:2026-09-02']);
  });

  it("channel:'ops' respects a suppressed claim", async () => {
    const { hooks } = spyHooks(false);
    await notify({ severity: 'info', title: 'digest', channel: 'ops', dedupe: { key: 'k' } }, hooks);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('suppressed claim → no POST at all', async () => {
    const { hooks } = spyHooks(false);
    await notify({ severity: 'info', title: 'x', dedupe: { key: 'k' } }, hooks);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('successful send keeps the claim', async () => {
    const { hooks, released } = spyHooks();
    respond(ok());
    await notify({ severity: 'info', title: 'x', dedupe: { key: 'k' } }, hooks);
    expect(released).toEqual([]);
  });

  // Without this, one transient 5xx permanently loses a once-ever alert.
  it.each([500, 503, 429, 404])('failed send (%i) RELEASES the claim so it retries', async (s) => {
    const { hooks, released } = spyHooks();
    respond(status(s));
    await notify({ severity: 'info', title: 'x', dedupe: { key: 'k' } }, hooks);
    expect(released).toEqual(['k']);
  });

  it('transport failure releases the claim', async () => {
    const { hooks, released } = spyHooks();
    respond(new Error('down'));
    await notify({ severity: 'info', title: 'x', dedupe: { key: 'k' } }, hooks);
    expect(released).toEqual(['k']);
  });

  it('400-then-fallback-ok keeps the claim (it was delivered)', async () => {
    const { hooks, released } = spyHooks();
    respond(status(400), ok());
    await notify({ severity: 'info', title: 'x', dedupe: { key: 'k' } }, hooks);
    expect(released).toEqual([]);
  });

  it('no hooks → always sends, never dedupes', async () => {
    respond(ok(), ok());
    await notify({ severity: 'info', title: 'x', dedupe: { key: 'k' } });
    await notify({ severity: 'info', title: 'x', dedupe: { key: 'k' } });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('applies a severity default ttl, and an explicit ttl overrides it', async () => {
    const { hooks, claimed } = spyHooks();
    respond(ok(), ok(), ok());
    await notify({ severity: 'critical', title: 'a', dedupe: { key: 'k1' } }, hooks);
    await notify({ severity: 'warn', title: 'b', dedupe: { key: 'k2' } }, hooks);
    await notify({ severity: 'info', title: 'c', dedupe: { key: 'k3', ttlMs: 999 } }, hooks);

    expect(claimed[0][2]).toBe(12 * 60 * 60 * 1000);
    expect(claimed[1][2]).toBe(24 * 60 * 60 * 1000);
    expect(claimed[2][2]).toBe(999);
  });

  it('passes the fingerprint through, defaulting to empty', async () => {
    const { hooks, claimed } = spyHooks();
    respond(ok(), ok());
    await notify({ severity: 'warn', title: 'a', dedupe: { key: 'k', fingerprint: 'stopped' } }, hooks);
    await notify({ severity: 'warn', title: 'b', dedupe: { key: 'k2' } }, hooks);
    expect(claimed[0][1]).toBe('stopped');
    expect(claimed[1][1]).toBe('');
  });
});
