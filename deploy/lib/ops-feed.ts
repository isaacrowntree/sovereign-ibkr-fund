/**
 * The ops feed — where the Pi says things now that Slack is quiet.
 *
 * Slack used to be the only surface these daemons could reach, so everything
 * went there: sessions restored at 4am, agents failing at 1am, containers
 * restarting. Almost none of it needed a phone notification; it needed a page
 * you could consult. That page is `pi.lan/ops`, and this is how the unattended
 * half of the Pi talks to it.
 *
 * Slack keeps exactly two jobs now: the nightly backup (it carries the archive,
 * which is the off-Pi copy) and the pushes that need a thumb inside two minutes.
 * Everything else appends here.
 *
 * One JSON object per line, append-only:
 *
 *   {"at": ISO8601, "source": string, "severity": "critical"|"warn"|
 *    "recovery"|"info", "title": string, "detail"?: string}
 *
 * A flat file rather than a socket or a table because the writers are two
 * TypeScript daemons, a Node script inside a container and a bash script, and
 * append-to-a-file is the only interface all four already have. The reader
 * (the hub, in Python) tolerates a malformed line, so a torn write during a
 * trim costs one event and never the page.
 *
 * Best-effort by construction: NOTHING here throws. A monitoring write must
 * never be the reason a re-login or a watchdog tick fails — that is the exact
 * inversion this whole system exists to avoid.
 */
// NOTE ON `package.json` IN THIS DIRECTORY. It exists for one line —
// `"type": "module"` — and it is load-bearing. relogin/ and watchdog/ declare
// themselves ESM in their own package.json, but those do not reach a sibling
// directory: without a marker here the nearest package.json is the repo root's,
// which says `"type": "commonjs"`. This file then loads as CJS and the ESM
// importers fail at RUNTIME with "does not provide an export named 'feed'" —
// while `tsc --noEmit` passes, because module format is not a type error. The
// three daemons that import this all die at startup when that happens.
import fs from 'node:fs';
import path from 'node:path';

export type Severity = 'critical' | 'warn' | 'recovery' | 'info';

/**
 * Host path, and the paperclip container's /fund-state/state, are the same
 * directory. It is the one place both sides of the Pi can already write —
 * giving the feed a tidier home of its own would mean a new bind mount and a
 * paperclip restart, which is a worse trade than an odd-looking path.
 */
const DIR = process.env.PI_OPS_DIR ?? '/var/lib/sovereign-fund/state';
const FILE = path.join(DIR, 'ops-feed.jsonl');

/** Trim when the file passes this, keeping the newest TRIM_KEEP lines. */
const MAX_BYTES = 256 * 1024;
const TRIM_KEEP = 400;

export interface FeedEvent {
  source: string;
  severity: Severity;
  title: string;
  detail?: string;
}

/** Append one event. Never throws, never rejects. */
export function feed(ev: FeedEvent): void {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    // One write(2) of a line that ends in \n: short appends to a file opened
    // O_APPEND do not interleave, which is what lets four unrelated programs
    // share this file with no lock.
    fs.appendFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), ...ev }) + '\n');
    trim();
  } catch {
    /* the feed is never worth failing a run over */
  }
}

function trim(): void {
  try {
    if (fs.statSync(FILE).size <= MAX_BYTES) return;
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    // Rename into place so a reader never sees a half-written file — the
    // truncate-then-write it replaces had a window where the feed was empty.
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, lines.slice(-TRIM_KEEP).join('\n') + '\n');
    fs.renameSync(tmp, FILE);
  } catch {
    /* a feed that cannot be trimmed is still a feed */
  }
}
