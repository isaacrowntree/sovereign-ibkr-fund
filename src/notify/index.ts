/**
 * Pluggable notifications for the fund agents.
 *
 * `alert(text)` sends a pre-formatted string. `notify(event)` sends a
 * structured event rendered to Slack Block Kit, with dedupe.
 *
 * A monitoring failure must never take down a trading run, so every impl is
 * best-effort and NEVER throws — including on a renderer bug or a dedupe-store
 * failure, not just on transport.
 *
 *   IBKR_FUND_ALERT_WEBHOOK set  → `webhook` (POSTs `{ text }`; Slack-compatible)
 *   otherwise                    → `noop`   (logs, stays silent)
 *
 * Override the choice explicitly with `NOTIFIER=webhook|noop`.
 *
 * Env is read PER CALL, not captured at module load — that keeps this module a
 * leaf and makes it testable by mutating process.env, with no resetModules
 * ceremony.
 */
import { log, logError } from '../log.js';
import { renderText, renderSlackPayload, type NotifyEvent, type RenderMeta } from './blocks.js';
import { feed } from './feed.js';

export type { NotifyEvent, NotifyField, RenderMeta, Severity } from './blocks.js';

const AGENT = 'Alert';
const TIMEOUT_MS = 10_000;

export interface Notifier {
  /**
   * Send a pre-formatted string. Posts plain `{ text }` — byte-identical to the
   * pre-Block-Kit behaviour, and deliberately does NOT inherit notify()'s
   * fallback retry: there is nothing to fall back *from*, since the payload
   * already IS the fallback shape, so a retry would only double-post.
   */
  alert(text: string): Promise<void>;
  /** Send a structured event. Resolves true only when Slack accepted it. */
  notify(event: NotifyEvent): Promise<boolean>;
}

interface PostResult {
  status: number;
  body: string;
}

/**
 * Validate the webhook URL before handing it to fetch.
 *
 * A URL with no scheme (`hooks.slack.com/...` instead of `https://...`) makes
 * fetch throw `Failed to parse URL from <the entire secret>` — and that message
 * goes straight to logError, i.e. into the systemd journal / docker logs. Every
 * other failure mode is safe (a DNS failure is just "fetch failed"; the host
 * lives in err.cause, which log.ts never reads), so this one config typo is the
 * only path that leaks the credential. Fail closed and never interpolate the
 * URL into the message.
 */
function validWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** POST once. Resolves null when the transport itself failed (network/timeout). */
async function post(webhook: string, payload: unknown): Promise<PostResult | null> {
  if (!validWebhook(webhook)) {
    logError('IBKR_FUND_ALERT_WEBHOOK is not a valid URL (missing https:// scheme?) — not sending', '', AGENT);
    return null;
  }
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, body: res.ok ? '' : await res.text().catch(() => '') };
  } catch (err) {
    logError('alert webhook failed', err, AGENT);
    return null;
  }
}

function meta(): RenderMeta {
  return { mode: process.env.TRADING_MODE || 'paper', at: new Date().toISOString() };
}

/** POSTs to IBKR_FUND_ALERT_WEBHOOK — works with any Slack-style incoming webhook. */
export const webhookNotifier: Notifier = {
  async alert(text: string): Promise<void> {
    const webhook = process.env.IBKR_FUND_ALERT_WEBHOOK;
    if (!webhook) {
      log(`(alert suppressed — IBKR_FUND_ALERT_WEBHOOK unset): ${text}`, AGENT);
      return;
    }
    const res = await post(webhook, { text });
    if (res && res.status >= 400) {
      logError(`alert webhook returned ${res.status}`, res.body, AGENT);
    }
  },

  async notify(event: NotifyEvent): Promise<boolean> {
    const webhook = process.env.IBKR_FUND_ALERT_WEBHOOK;
    if (!webhook) {
      log(`(alert suppressed — IBKR_FUND_ALERT_WEBHOOK unset): ${renderText(event, meta())}`, AGENT);
      return false;
    }

    const payload = renderSlackPayload(event, meta());
    const res = await post(webhook, payload);
    if (!res) return false; // transport failed — caller releases the claim
    if (res.status < 400) return true;

    // 400 — Slack rejected the payload itself (blocks nested in an attachment
    // surface as `invalid_attachments`). Retry ONCE as plain text so a renderer
    // bug cannot silence the alert it was rendering. Non-recursive by
    // construction: the retry payload contains no blocks.
    if (res.status === 400) {
      logError('alert webhook rejected blocks (400) — retrying as plain text', res.body, AGENT);
      const plain = await post(webhook, { text: payload.text });
      if (plain && plain.status < 400) return true;
      if (plain) logError(`alert webhook returned ${plain.status} on text fallback`, plain.body, AGENT);
      return false;
    }

    // 429 — rate limited. Do NOT retry and do NOT fall back: the payload was
    // fine, and an immediate second POST doubles our rate at the exact moment
    // Slack asked us to slow down. Returning false releases the claim, so the
    // next agent run re-sends.
    if (res.status === 429) {
      logError('alert webhook rate limited (429) — releasing claim, will retry next run', res.body, AGENT);
      return false;
    }

    // 403/404/410 permanent (revoked / archived), 5xx transient (Slack down).
    // Neither is helped by an immediate retry.
    logError(`alert webhook returned ${res.status}`, res.body, AGENT);
    return false;
  },
};

/** Silent notifier — logs the message and does nothing else. */
export const noopNotifier: Notifier = {
  async alert(text: string): Promise<void> {
    log(`(alert, no notifier configured): ${text}`, AGENT);
  },
  async notify(event: NotifyEvent): Promise<boolean> {
    log(`(alert, no notifier configured): ${renderText(event, meta())}`, AGENT);
    return false;
  },
};

/** Resolve the active notifier from env. */
export function getNotifier(): Notifier {
  const choice = (process.env.NOTIFIER || '').toLowerCase();
  if (choice === 'noop') return noopNotifier;
  if (choice === 'webhook') return webhookNotifier;
  return process.env.IBKR_FUND_ALERT_WEBHOOK ? webhookNotifier : noopNotifier;
}

/** Best-effort alert via the active notifier. Never throws. */
export function alert(text: string): Promise<void> {
  return getNotifier().alert(text);
}

/**
 * Dedupe hooks, injected rather than imported.
 *
 * This is what keeps notify/ a leaf. Importing ../state/store.js here would
 * pull node:sqlite and store.ts's module-load STATE_DIR into every consumer of
 * the notifier, and any notify() test touching dedupe would create a real
 * bot-state.db in the process's cwd. Agents wire `storeHooks` in; tests pass a
 * fake.
 */
export interface DedupeHooks {
  claim(key: string, fingerprint: string, ttlMs: number): boolean;
  release(key: string): void;
}

/**
 * Re-nag cadence when a condition is stuck and its fingerprint hasn't changed.
 * `info` defaults to Infinity: informational events are keyed on something
 * inherently once-only (a run id, a date), so a re-nag would be pure noise.
 */
const DEFAULT_TTL_MS: Record<string, number> = {
  critical: 12 * 60 * 60 * 1000,
  warn: 24 * 60 * 60 * 1000,
  recovery: 12 * 60 * 60 * 1000,
  info: Infinity,
};

/**
 * Send a structured event. NEVER throws.
 *
 * Dedupe lives here rather than in the impls, so the impls stay pure transport
 * and every call site stays a one-liner.
 *
 * Ordering is claim-then-send, with a RELEASE when delivery fails. Claiming
 * without releasing would permanently lose any once-ever alert (a fill, the
 * digest) on a single transient Slack 5xx — reintroducing exactly the silence
 * this exists to end. Releasing only on failure means no duplicate was ever
 * delivered. The residual is Slack accepting but the 200 being lost in transit,
 * costing one duplicate; for a fund that trade is obvious — a duplicate is
 * noise, a missing fill is a divergence between what you think you hold and
 * what you hold.
 */
export async function notify(event: NotifyEvent, hooks?: DedupeHooks): Promise<void> {
  let claimed: string | null = null;
  try {
    if (event.dedupe && hooks) {
      const ttl = event.dedupe.ttlMs ?? DEFAULT_TTL_MS[event.severity] ?? Infinity;
      let ok: boolean;
      try {
        ok = hooks.claim(event.dedupe.key, event.dedupe.fingerprint ?? '', ttl);
      } catch (err) {
        // FAIL OPEN. A duplicate alert is annoying; a suppressed one costs
        // money. The dedupe layer must never be the reason you didn't hear.
        logError('dedupe claim failed — sending anyway', err, AGENT);
        ok = true;
      }
      if (!ok) return;
      claimed = event.dedupe.key;
    }

    // The ops feed is the record; Slack is an interruption layer on top of it,
    // and `channel: 'ops'` means record-only. Both sit BELOW the dedupe claim
    // rather than above it, which matters more than it looks: the daily
    // digest's claim row (`digest:<date>`) is what the nightly backup reads to
    // prove the digest agent ran at all. Short-circuiting before the claim
    // would have left that row unwritten and the backup crying wolf every
    // night — the exact false alarm it was fixed for in the first place.
    feed(event);
    if (event.channel === 'ops') return;

    const delivered = await getNotifier().notify(event);
    if (!delivered && claimed && hooks) {
      try {
        hooks.release(claimed);
      } catch (err) {
        logError('dedupe release failed — this alert will not retry', err, AGENT);
      }
    }
  } catch (err) {
    // The outer net. Covers the renderer as well as transport: blocks.ts being
    // "pure" is no guarantee it cannot throw (a .toFixed() on an undefined
    // number is a TypeError), and this call sits on the drawdown hard-stop
    // path. Nothing here may propagate into a trading agent.
    logError('notify failed', err, AGENT);
    if (claimed && hooks) {
      try { hooks.release(claimed); } catch { /* best effort */ }
    }
  }
}
