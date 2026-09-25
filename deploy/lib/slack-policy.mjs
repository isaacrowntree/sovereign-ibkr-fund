/**
 * The Slack paging policy for the host-side daemons (watchdog, relogin,
 * assisted login, agent-health). The same list as src/notify/policy.ts, which
 * these cannot import; src/notify/policy.test.ts fails if the two disagree.
 *
 * Set 2026-09-24. In the operator's words:
 *
 *   "slack should only page me for ip address disconnection or ibkr fund
 *    disconnection or a database upload. that's it. everything else can go
 *    into the ops page view."
 *
 * Every Slack post from deploy/ names its category and goes through mayPage();
 * anything that does not pass is written to the ops feed instead.
 *
 * Plain .mjs for the same reason as webhook.mjs: agent-health runs as bare
 * `node` with no tsx. slack-policy.d.mts gives the TypeScript side its types.
 */

/** @type {ReadonlyArray<'ip-disconnect' | 'fund-disconnect' | 'db-upload'>} */
export const PAGE_CATEGORIES = Object.freeze(['ip-disconnect', 'fund-disconnect', 'db-upload']);

/** @param {unknown} category */
export function mayPage(category) {
  return typeof category === 'string' && PAGE_CATEGORIES.includes(/** @type {any} */ (category));
}
