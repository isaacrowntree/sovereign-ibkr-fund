/**
 * Wires notify()'s dedupe and outbox to the real store.
 *
 * Deliberately a separate module from ./index.ts: this is the one file that
 * knows about both, so `notify/index.ts` stays a leaf whose only import is
 * ../log.js. Agents import this; tests of the notifier don't, and therefore
 * never touch node:sqlite or create a bot-state.db.
 */
import {
  claimAlert,
  releaseAlert,
  outboxEnqueue,
  outboxDue,
  outboxLease,
  outboxReschedule,
  outboxDelete,
} from '../state/store.js';
import type { DedupeHooks } from './index.js';
import type { OutboxStore } from './outbox.js';

export const storeHooks: DedupeHooks = {
  claim: claimAlert,
  release: releaseAlert,
  enqueue: (key, event) => outboxEnqueue(key, JSON.stringify(event)),
  settle: (key) => outboxDelete(key),
};

/** The drainer's view of the store — used by the observer only. */
export const outboxStore: OutboxStore = {
  due: outboxDue,
  lease: outboxLease,
  reschedule: outboxReschedule,
  remove: outboxDelete,
};
