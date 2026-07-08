/**
 * Back-compat shim. The notifier is now pluggable — see `./index.ts`.
 * Existing imports (`import { alert } from '../notify/slack.js'`) keep working;
 * `alert` dispatches to the env-selected notifier (webhook / noop).
 */
export { alert, type Notifier } from './index.js';
