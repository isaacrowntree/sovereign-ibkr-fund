/**
 * POST a `{ text }` alert to a Slack-style webhook, with a short retry.
 *
 * For the host-side scripts (watchdog, agent-health) — the fund agents have
 * their own notifier with a persisted outbox (src/notify/). These run once and
 * exit, so there is nowhere to queue; a couple of in-process retries is what
 * turns "one Slack 5xx and the page is gone" into "Slack was down for a while".
 *
 * Plain .mjs on purpose: agent-health runs as bare `node` inside the paperclip
 * container with no tsx, and the watchdog imports it through tsx. A .d.mts
 * beside it gives the TypeScript side its types.
 *
 * Never throws. Resolves true only when the webhook accepted the post.
 *
 * @param {string | undefined} url
 * @param {unknown} payload
 * @param {{ delaysMs?: number[], timeoutMs?: number, fetchImpl?: typeof fetch,
 *           sleep?: (ms: number) => Promise<void>, log?: (msg: string) => void }} [opts]
 * @returns {Promise<boolean>}
 */
export async function postWebhook(url, payload, opts = {}) {
  const {
    delaysMs = [2_000, 5_000],
    timeoutMs = 8_000,
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = () => {},
  } = opts;
  if (!url) return false;
  // A scheme-less URL makes fetch throw "Failed to parse URL from <the secret>";
  // refuse before that message can reach a log.
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
  } catch {
    log('alert webhook is not a valid URL — not sending');
    return false;
  }
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    let why = '';
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      if (res.ok) return true;
      why = `HTTP ${status}`;
    } catch (err) {
      why = (err && err.message) || String(err);
    }
    // Retry only what a retry can fix: the transport, a 5xx, a rate limit.
    // A 4xx means the webhook is revoked or the payload is wrong.
    const transient = status === 0 || status === 429 || status >= 500;
    if (!transient || attempt >= delaysMs.length) {
      log(`alert webhook failed (${why}) after ${attempt + 1} attempt${attempt ? 's' : ''}`);
      return false;
    }
    await sleep(delaysMs[attempt]);
  }
}
