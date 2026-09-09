import { describe, it, expect } from 'vitest';
import { startRun, enterPhase, recordSignal, describeAbandonedRun, type RunPhase } from './run-recorder.js';

const T0 = new Date('2026-09-08T18:53:12.900Z');
const MB = 1024 * 1024;

const run = (over: Partial<RunPhase> = {}): RunPhase =>
  ({ ...startRun(T0, 4242, 120 * MB), ...over });

describe('startRun / enterPhase', () => {
  it('records who is running, since when, and how much memory it holds', () => {
    const r = startRun(T0, 4242, 120 * MB);
    expect(r).toMatchObject({ at: T0.toISOString(), pid: 4242, phase: 'starting', rssMb: 120 });
    expect(r.phaseAt).toBe(T0.toISOString());
    expect(r.signal).toBeUndefined();
  });

  it('advances the phase without losing who started the run or when', () => {
    const t1 = new Date('2026-09-08T18:56:18.000Z');
    const r = enterPhase(run(), 'confirming:HHH', t1, 190 * MB);
    expect(r.at).toBe(T0.toISOString());     // run start is preserved…
    expect(r.pid).toBe(4242);
    expect(r.phaseAt).toBe(t1.toISOString()); // …the phase clock is not
    expect(r.phase).toBe('confirming:HHH');
    expect(r.rssMb).toBe(190);
  });

  it('keeps a signal already seen when the phase moves on', () => {
    const r = enterPhase(recordSignal(run(), 'SIGTERM', T0), 'placing:DDD', T0, 100 * MB);
    expect(r.signal).toBe('SIGTERM');
  });
});

describe('describeAbandonedRun — the post-mortem the next run reports', () => {
  const later = new Date('2026-09-09T09:00:00.000Z');
  const alive = () => true;
  const dead = () => false;

  it('says nothing when there is no previous run', () => {
    expect(describeAbandonedRun(undefined, later, dead)).toBeNull();
    expect(describeAbandonedRun(null, later, dead)).toBeNull();
  });

  it('says nothing while the run that holds the lock is still alive', () => {
    const fresh = enterPhase(run(), 'placing:DDD', new Date(T0.getTime() + 60_000), 130 * MB);
    expect(describeAbandonedRun(fresh, new Date(T0.getTime() + 120_000), alive)).toBeNull();
  });

  it('names the phase the run was in when it stopped', () => {
    // Nothing in-process survives a SIGKILL — no handler, no finally, no exit
    // hook — so the last phase written to disk is the only evidence of where
    // the run got to. Naming it is the entire purpose of the record.
    const dying = enterPhase(run(), 'confirming:HHH', new Date('2026-09-08T18:56:18.000Z'), 190 * MB);
    const out = describeAbandonedRun(dying, later, dead);
    expect(out).not.toBeNull();
    expect(out!.phase).toBe('confirming:HHH');
    expect(out!.detail).toContain('confirming:HHH');
    expect(out!.detail).toContain('4242');
  });

  it('reports how long the run had been in that phase, not just that it died', () => {
    const dying = enterPhase(run(), 'confirming:HHH', new Date('2026-09-08T18:56:18.000Z'), 190 * MB);
    const out = describeAbandonedRun(dying, new Date('2026-09-08T18:59:18.000Z'), dead)!;
    expect(out.phaseMs).toBe(3 * 60_000);
    expect(out.detail).toMatch(/3m|180s|3 min/);
  });

  it('distinguishes a signalled shutdown from a silent kill', () => {
    // SIGTERM is catchable, so if the supervisor asked first we know. Nothing
    // can record SIGKILL from inside — the ABSENCE of a signal is the finding.
    const termed = recordSignal(enterPhase(run(), 'confirming:HHH', T0, 190 * MB), 'SIGTERM', T0);
    expect(describeAbandonedRun(termed, later, dead)!.detail).toContain('SIGTERM');

    const silent = enterPhase(run(), 'confirming:HHH', T0, 190 * MB);
    const d = describeAbandonedRun(silent, later, dead)!.detail;
    expect(d).toMatch(/no signal|SIGKILL|without warning/i);
  });

  it('carries the memory reading, so an OOM shows up as one', () => {
    const dying = enterPhase(run(), 'confirming:HHH', T0, 1900 * MB);
    expect(describeAbandonedRun(dying, later, dead)!.detail).toContain('1900');
  });

  it('treats a long-stale lock as abandoned even if something answers to that pid', () => {
    // Across a container restart the pid may be reused by an unrelated process,
    // so liveness alone would wrongly call an ancient lock "still running".
    const old = enterPhase(run(), 'confirming:HHH', T0, 190 * MB);
    expect(describeAbandonedRun(old, later, alive)).not.toBeNull();
  });

  it('survives a malformed record rather than taking the run down with it', () => {
    const junk = { pid: 'nope', phase: 42 } as unknown as RunPhase;
    expect(() => describeAbandonedRun(junk, later, dead)).not.toThrow();
  });
});
