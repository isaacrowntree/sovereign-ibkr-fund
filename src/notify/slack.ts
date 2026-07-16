/**
 * Back-compat shim. The notifier is now pluggable — see `./index.ts`.
 * Existing imports (`import { alert } from '../notify/slack.js'`) keep working;
 * `alert` dispatches to the env-selected notifier (webhook / noop).
 *
 * `notify` is the structured, deduped, Block-Kit path — prefer it for new call
 * sites. Pair it with `storeHooks` from './store-hooks.js' to get dedupe.
 */
export { alert, notify, type Notifier, type DedupeHooks } from './index.js';
export type { NotifyEvent, NotifyField, Severity } from './blocks.js';
