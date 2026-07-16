/**
 * Wires notify()'s dedupe to the real store.
 *
 * Deliberately a separate module from ./index.ts: this is the one file that
 * knows about both, so `notify/index.ts` stays a leaf whose only import is
 * ../log.js. Agents import this; tests of the notifier don't, and therefore
 * never touch node:sqlite or create a bot-state.db.
 */
import { claimAlert, releaseAlert } from '../state/store.js';
import type { DedupeHooks } from './index.js';

export const storeHooks: DedupeHooks = {
  claim: claimAlert,
  release: releaseAlert,
};
