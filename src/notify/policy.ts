/**
 * The Slack paging policy — what is allowed to interrupt, in one place.
 *
 * Set 2026-09-24. In the operator's words:
 *
 *   "slack should only page me for ip address disconnection or ibkr fund
 *    disconnection or a database upload. that's it. everything else can go
 *    into the ops page view."
 *
 * So Slack is an ALLOWLIST of three categories and nothing else:
 *
 *   ip-disconnect    the trading bot's egress IP is off its exchange whitelist
 *                    (a sibling project; listed so the three read together)
 *   fund-disconnect  the fund has lost IBKR: the gateway session is gone or
 *                    parked, a login needs a phone tap, the gateway is dead and
 *                    could not be restarted, or the event stream is
 *                    DISCONNECTED — plus the recovery for an outage that paged
 *   db-upload        the nightly backup carrying the database off the host
 *                    (scripts/backup-to-slack.mjs — it posts the file itself)
 *
 * Everything else — risk, drift, orders, digests, reconciler findings, config
 * warnings, agent health — is recorded on the ops feed (feed.ts) and read at
 * the ops page. An event with no `page` category is feed-only; there is no way
 * to reach Slack by default.
 *
 * deploy/lib/slack-policy.mjs is the same list for the host-side daemons
 * (watchdog, relogin, agent-health), which cannot import from src/. A test
 * (policy.test.ts) fails if the two ever disagree.
 */
export type PageCategory = 'ip-disconnect' | 'fund-disconnect' | 'db-upload';

export const PAGE_CATEGORIES: readonly PageCategory[] = Object.freeze([
  'ip-disconnect',
  'fund-disconnect',
  'db-upload',
]);

/** True only for an allowed category. Anything else — including undefined — stays on the feed. */
export function mayPage(category: unknown): category is PageCategory {
  return typeof category === 'string' && (PAGE_CATEGORIES as readonly string[]).includes(category);
}
