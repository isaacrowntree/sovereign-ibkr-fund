/**
 * Pluggable notifications for the fund agents.
 *
 * `alert(text)` dispatches to the notifier selected by env — a monitoring
 * failure must never take down a trading run, so every impl is best-effort and
 * never throws.
 *
 *   IBKR_FUND_ALERT_WEBHOOK set  → `webhook` (POSTs `{ text }`; Slack-compatible)
 *   otherwise                    → `noop`   (logs, stays silent)
 *
 * Override the choice explicitly with `NOTIFIER=webhook|noop`.
 */
import { log, logError } from '../log.js';

const AGENT = 'Alert';

export interface Notifier {
  alert(text: string): Promise<void>;
}

/** POSTs `{ text }` to IBKR_FUND_ALERT_WEBHOOK — works with any Slack-style incoming webhook. */
export const webhookNotifier: Notifier = {
  async alert(text: string): Promise<void> {
    const webhook = process.env.IBKR_FUND_ALERT_WEBHOOK;
    if (!webhook) {
      log(`(alert suppressed — IBKR_FUND_ALERT_WEBHOOK unset): ${text}`, AGENT);
      return;
    }
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        logError(`alert webhook returned ${res.status}`, await res.text().catch(() => ''), AGENT);
      }
    } catch (err) {
      logError('alert webhook failed', err, AGENT);
    }
  },
};

/** Silent notifier — logs the message and does nothing else. */
export const noopNotifier: Notifier = {
  async alert(text: string): Promise<void> {
    log(`(alert, no notifier configured): ${text}`, AGENT);
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
