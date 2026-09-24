/**
 * The IBKR session lock — one thing at a time touches the gateway's login.
 *
 * Several unrelated programs can each decide, on their own clock, that the
 * session needs something done to it: relogin (every 5 min), the nightly
 * preflight, the hub's "Log in now" and "Restart gateway" buttons, the watchdog,
 * and the SSO watch inside the bezant container. Any two of them overlapping is
 * the failure: a restart under a login destroys the push the operator is about
 * to tap, and two `ssodh/init` compete calls fight over one bridge. Until now
 * each pair was coordinated ad hoc (preflight stops the relogin timer, the hub
 * has its status-file slot) and the rest not at all.
 *
 * The lock is a DIRECTORY on a persistent path, holding one file:
 *
 *   <dir>/holder.json   {"owner","pid","host","token","acquiredAt",
 *                        "expiresAt","expiresAtEpoch"}
 *
 * A directory (not a file) so it can be bind-mounted read-only into the bezant
 * container, and persistent (not $XDG_RUNTIME_DIR) because the hub is a system
 * unit with no runtime dir and the container cannot see one either.
 *
 * Protocol — shared by this file, preflight (bash) and the hub (python), so it
 * is kept to primitives all three have:
 *
 *   acquire  write the holder to a temp file, then link(2) it to holder.json.
 *            link fails with EEXIST if a holder exists, so the check and the
 *            create are one atomic step and a reader never sees a half-written
 *            file.
 *   stale    expiresAtEpoch has passed, OR the holder is on this host and its
 *            pid is gone, OR the file is unreadable. The TTL is what makes a
 *            SIGKILLed holder (the hub kills assisted logins) recoverable, and
 *            the only test available inside the container, which cannot see
 *            host pids.
 *   steal    rename(2) a stale holder aside, and only unlink it if it is still
 *            the one judged stale (same token). If someone replaced it in
 *            between, put theirs back.
 *   release  unlink holder.json only if it still carries our token.
 *   inherit  a child started by a holder (preflight → relogin) is handed the
 *            token in IBKR_SESSION_LOCK_TOKEN and runs under the parent's lock
 *            without taking or releasing it.
 *
 * Everything is synchronous so release can run from a process 'exit' handler.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export interface Holder {
  owner: string;
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
  expiresAt: string;
  expiresAtEpoch: number;
}

export const HOLDER_FILE = 'holder.json';

export function defaultLockDir(): string {
  return process.env.IBKR_SESSION_LOCK_DIR ?? path.join(os.homedir(), '.local', 'state', 'ibkr-session');
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parse(raw: string): Holder | null {
  try {
    const h = JSON.parse(raw) as Partial<Holder>;
    if (typeof h.token !== 'string' || typeof h.expiresAtEpoch !== 'number') return null;
    return h as Holder;
  } catch {
    return null;
  }
}

function readRaw(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function isStale(h: Holder | null, nowMs: number, host = os.hostname()): boolean {
  if (!h) return true;
  if (nowMs / 1000 >= h.expiresAtEpoch) return true;
  if (h.host === host && !pidAlive(h.pid)) return true;
  return false;
}

/** The live holder, or null when the lock is free (absent or stale). */
export function currentHolder(dir = defaultLockDir(), nowMs = Date.now()): Holder | null {
  const raw = readRaw(path.join(dir, HOLDER_FILE));
  if (raw === null) return null;
  const h = parse(raw);
  return isStale(h, nowMs) ? null : h;
}

export function describeHolder(h: Holder, nowMs = Date.now()): string {
  const left = Math.max(0, Math.round(h.expiresAtEpoch - nowMs / 1000));
  return `${h.owner} (pid ${h.pid} on ${h.host}, ${left}s left on its lease)`;
}

export type Acquired = {
  ok: true;
  token: string;
  /** True when running under a parent's lock (IBKR_SESSION_LOCK_TOKEN). */
  inherited: boolean;
  release(): void;
};
export type Refused = { ok: false; holder: Holder | null };

export interface AcquireOptions {
  dir?: string;
  nowMs?: number;
  /** Token handed down by a parent holder; defaults to IBKR_SESSION_LOCK_TOKEN. */
  inheritToken?: string;
}

export function acquire(owner: string, ttlSec: number, opts: AcquireOptions = {}): Acquired | Refused {
  const dir = opts.dir ?? defaultLockDir();
  const nowMs = opts.nowMs ?? Date.now();
  const file = path.join(dir, HOLDER_FILE);
  const inheritToken = opts.inheritToken ?? process.env.IBKR_SESSION_LOCK_TOKEN;

  if (inheritToken) {
    const h = parse(readRaw(file) ?? '');
    if (h && h.token === inheritToken && !isStale(h, nowMs)) {
      return { ok: true, token: inheritToken, inherited: true, release: () => {} };
    }
    // A token that no longer matches means the parent's lease is gone; fall
    // through and take the lock properly rather than run unguarded.
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const token = crypto.randomBytes(12).toString('hex');
  const holder: Holder = {
    owner,
    pid: process.pid,
    host: os.hostname(),
    token,
    acquiredAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlSec * 1000).toISOString(),
    expiresAtEpoch: Math.floor(nowMs / 1000) + ttlSec,
  };
  const tmp = path.join(dir, `.holder.${token}.tmp`);
  // 0644: the bezant container reads this as a different uid.
  fs.writeFileSync(tmp, JSON.stringify(holder) + '\n', { mode: 0o644 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.linkSync(tmp, file);
        return { ok: true, token, inherited: false, release: () => release(token, dir) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const cur = parse(readRaw(file) ?? '');
      if (!isStale(cur, nowMs)) return { ok: false, holder: cur };
      const aside = path.join(dir, `.stale.${token}`);
      try {
        fs.renameSync(file, aside);
      } catch {
        continue; // already gone — someone else cleared it; retry the link
      }
      const moved = parse(readRaw(aside) ?? '');
      if ((moved?.token ?? null) !== (cur?.token ?? null)) {
        // Between our read and our rename, someone replaced the stale holder
        // with a live one. Give it back and yield.
        try {
          fs.linkSync(aside, file);
        } catch {
          /* a third party got in; theirs stands */
        }
        fs.rmSync(aside, { force: true });
        return { ok: false, holder: moved };
      }
      fs.rmSync(aside, { force: true });
    }
    return { ok: false, holder: currentHolder(dir, nowMs) };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Remove holder.json if, and only if, it is still ours. */
export function release(token: string, dir = defaultLockDir()): void {
  const file = path.join(dir, HOLDER_FILE);
  const h = parse(readRaw(file) ?? '');
  if (h?.token !== token) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}
