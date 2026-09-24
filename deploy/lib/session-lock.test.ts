import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquire, currentHolder, release, HOLDER_FILE, type Holder } from './session-lock.js';
import { isQuietHours, localHour } from './quiet-hours.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-lock-'));
});

const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid!;

function plant(h: Partial<Holder>): void {
  const full: Holder = {
    owner: 'other', pid: process.pid, host: os.hostname(), token: 'tok-other',
    acquiredAt: new Date().toISOString(), expiresAt: '', expiresAtEpoch: Math.floor(Date.now() / 1000) + 300,
    ...h,
  };
  fs.writeFileSync(path.join(dir, HOLDER_FILE), JSON.stringify(full));
}

describe('session lock', () => {
  it('is free when nobody holds it, and taken once acquired', () => {
    expect(currentHolder(dir)).toBeNull();
    const a = acquire('relogin', 60, { dir, inheritToken: '' });
    expect(a.ok).toBe(true);
    expect(currentHolder(dir)?.owner).toBe('relogin');
  });

  it('refuses a second holder and names the first', () => {
    acquire('relogin', 60, { dir, inheritToken: '' });
    const b = acquire('watchdog', 60, { dir, inheritToken: '' });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.holder?.owner).toBe('relogin');
  });

  it('release frees it, and only for the holder that took it', () => {
    const a = acquire('relogin', 60, { dir, inheritToken: '' });
    release('not-mine', dir);
    expect(currentHolder(dir)?.owner).toBe('relogin');
    if (a.ok) a.release();
    expect(currentHolder(dir)).toBeNull();
  });

  it('breaks a holder whose lease has expired', () => {
    plant({ expiresAtEpoch: Math.floor(Date.now() / 1000) - 1 });
    const a = acquire('relogin', 60, { dir, inheritToken: '' });
    expect(a.ok).toBe(true);
  });

  it('breaks a same-host holder whose process is gone (a SIGKILLed login)', () => {
    plant({ pid: deadPid() });
    expect(currentHolder(dir)).toBeNull();
    expect(acquire('hub-reset', 60, { dir, inheritToken: '' }).ok).toBe(true);
  });

  it('trusts the lease, not the pid, for a holder on another host (the container)', () => {
    plant({ pid: deadPid(), host: 'some-other-host' });
    expect(currentHolder(dir)?.owner).toBe('other');
    expect(acquire('relogin', 60, { dir, inheritToken: '' }).ok).toBe(false);
  });

  it('treats an unreadable holder file as stale rather than wedging forever', () => {
    fs.writeFileSync(path.join(dir, HOLDER_FILE), '{not json');
    expect(acquire('relogin', 60, { dir, inheritToken: '' }).ok).toBe(true);
  });

  it('lets a child run under its parent\'s lock without taking or releasing it', () => {
    const parent = acquire('preflight', 60, { dir, inheritToken: '' });
    if (!parent.ok) throw new Error('parent failed');
    const child = acquire('relogin', 60, { dir, inheritToken: parent.token });
    expect(child.ok && child.inherited).toBe(true);
    if (child.ok) child.release();
    expect(currentHolder(dir)?.owner).toBe('preflight');
  });

  it('leaves no temp files behind', () => {
    const a = acquire('relogin', 60, { dir, inheritToken: '' });
    acquire('watchdog', 60, { dir, inheritToken: '' });
    if (a.ok) a.release();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('quiet hours (D5)', () => {
  const q = { tz: 'Australia/Sydney', start: 23, end: 7 };
  it('reads the Sydney wall clock through DST', () => {
    // 2026-07-01 13:00Z = 23:00 AEST (+10); 2026-12-01 12:00Z = 23:00 AEDT (+11).
    expect(localHour(new Date('2026-07-01T13:00:00Z'), q.tz)).toBe(23);
    expect(localHour(new Date('2026-12-01T12:00:00Z'), q.tz)).toBe(23);
  });
  it('is quiet from 23:00 up to but not including 07:00', () => {
    expect(isQuietHours(new Date('2026-07-01T12:59:00Z'), q)).toBe(false); // 22:59
    expect(isQuietHours(new Date('2026-07-01T13:00:00Z'), q)).toBe(true); // 23:00
    expect(isQuietHours(new Date('2026-07-01T16:00:00Z'), q)).toBe(true); // 02:00
    expect(isQuietHours(new Date('2026-07-01T20:59:00Z'), q)).toBe(true); // 06:59
    expect(isQuietHours(new Date('2026-07-01T21:00:00Z'), q)).toBe(false); // 07:00
  });
});
