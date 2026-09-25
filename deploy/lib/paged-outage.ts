/**
 * "An IBKR outage paged Slack and has not been declared over yet."
 *
 * The 2026-09-24 paging policy (./slack-policy.mjs) keeps a recovery message
 * on Slack only when it is the other half of an outage that paged; otherwise
 * the recovery is an ops-feed line. Several programs can page a fund
 * disconnection — relogin when it parks, the assisted login when it fails, the
 * watchdog when the gateway stays logged out or a restart fails — but only the
 * watchdog sees the session come back within a minute, whoever logged it in.
 * So the pagers leave this marker, and the watchdog alone sends the one
 * "restored" page and clears it: one recovery per paged outage, and none for an
 * outage that never paged.
 *
 * Lives in the session-lock directory, the one place all of them already share.
 * Best-effort: nothing here throws.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultLockDir } from './session-lock.js';

export function pagedOutageFile(dir: string = defaultLockDir()): string {
  return path.join(dir, 'paged-outage.json');
}

/** Record that a fund-disconnection page went out. Keeps the FIRST page's time. */
export function markPagedOutage(what: string, dir?: string): void {
  try {
    const file = pagedOutageFile(dir);
    if (fs.existsSync(file)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), what }) + '\n');
  } catch {
    /* the worst case is a recovery that lands on the feed instead of Slack */
  }
}

/** The open paged outage, if any. */
export function readPagedOutage(dir?: string): { at: string; what: string } | null {
  try {
    const v = JSON.parse(fs.readFileSync(pagedOutageFile(dir), 'utf8'));
    return typeof v?.at === 'string' ? { at: v.at, what: String(v.what ?? '') } : { at: '', what: '' };
  } catch (err) {
    // Present but unreadable still means "something paged".
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : { at: '', what: '' };
  }
}

export function clearPagedOutage(dir?: string): void {
  try {
    fs.rmSync(pagedOutageFile(dir), { force: true });
  } catch {
    /* best effort */
  }
}
