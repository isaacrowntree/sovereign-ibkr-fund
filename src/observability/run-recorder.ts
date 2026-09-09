/**
 * Flight recorder for execution runs — so a killed run leaves evidence.
 *
 * ## The problem
 *
 * A run that is killed rather than thrown out of never reaches the `finally`
 * that releases its lock, and says nothing about where it got to. If it died
 * mid-order the shares are at the broker with nothing in the ledger, and the
 * cause is unavailable afterwards: a kill leaves no entry in the host log, the
 * container's, or the supervisor's.
 *
 * ## What survives a kill
 *
 * Nothing in-process. `SIGKILL` runs no handler, no `finally`, no exit hook,
 * so anything worth knowing afterwards has to already be on disk before the
 * process stops. Hence the design: a run writes a breadcrumb as it enters
 * each phase, and the NEXT run finds the abandoned breadcrumb and reports the
 * post-mortem.
 * The dead run cannot report itself; its successor can.
 *
 * A polite shutdown CAN be caught — `SIGTERM`/`SIGINT` mean a supervisor asked
 * first, which points at a timeout or a deploy. So the absence of a recorded
 * signal is itself the finding, narrowing the cause to `SIGKILL`, a crash, or
 * the machine stopping.
 *
 * Pure: no I/O, no clock, no mutation. The caller persists the record and does
 * the alerting.
 */

export interface RunPhase {
  /** ISO time the run began. Preserved across every phase change. */
  at: string;
  pid: number;
  /** What the run was doing when this was last written. */
  phase: string;
  /** ISO time the current phase began. */
  phaseAt: string;
  /** Resident set size on entering the phase, whole MB — an OOM shows as a climb. */
  rssMb: number;
  /** A catchable signal that arrived. Absent for SIGKILL, which cannot be observed. */
  signal?: string;
  /** ISO time the signal arrived. */
  signalAt?: string;
}

/** How long a lock can be held before it is treated as abandoned regardless of pid. */
export const RUN_STALE_MS = 35 * 60 * 1000;

const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

export function startRun(now: Date, pid: number, rssBytes: number): RunPhase {
  const iso = now.toISOString();
  return { at: iso, pid, phase: 'starting', phaseAt: iso, rssMb: mb(rssBytes) };
}

export function enterPhase(prev: RunPhase, phase: string, now: Date, rssBytes: number): RunPhase {
  return { ...prev, phase, phaseAt: now.toISOString(), rssMb: mb(rssBytes) };
}

export function recordSignal(prev: RunPhase, signal: string, now: Date): RunPhase {
  return { ...prev, signal, signalAt: now.toISOString() };
}

export interface RunPostMortem {
  phase: string;
  /** How long the run had been in that phase when it stopped. */
  phaseMs: number;
  title: string;
  detail: string;
}

function humanMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 90_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.round(ms / 60_000);
  return m < 90 ? `${m}m` : `${(m / 60).toFixed(1)}h`;
}

/**
 * Describe a previous run that never released the lock, or null if there is
 * nothing to report.
 *
 * `isAlive` is injected rather than calling `process.kill(pid, 0)` directly so
 * the decision stays testable. Liveness alone is not enough: across a container
 * restart the pid can be reused by an unrelated process, which would make an
 * ancient lock look like a healthy concurrent run. So a long-stale lock counts
 * as abandoned whatever the pid says.
 */
export function describeAbandonedRun(
  rec: RunPhase | null | undefined,
  now: Date,
  isAlive: (pid: number) => boolean,
): RunPostMortem | null {
  if (!rec || typeof rec !== 'object') return null;

  const phase = typeof rec.phase === 'string' ? rec.phase : 'unknown';
  const pid = typeof rec.pid === 'number' ? rec.pid : 0;
  const phaseStart = Date.parse(rec.phaseAt ?? rec.at ?? '');
  const runStart = Date.parse(rec.at ?? '');
  const phaseMs = Number.isFinite(phaseStart) ? Math.max(0, now.getTime() - phaseStart) : 0;
  const runMs = Number.isFinite(runStart) ? Math.max(0, now.getTime() - runStart) : 0;

  const stale = runMs > RUN_STALE_MS;
  let live = false;
  try {
    live = pid > 0 && isAlive(pid);
  } catch {
    live = false;
  }
  if (live && !stale) return null; // a healthy concurrent run, not a corpse

  const cause = rec.signal
    ? `It was sent ${rec.signal}${rec.signalAt ? ` at ${rec.signalAt}` : ''}, so something asked it to stop — ` +
      'look for a supervisor timeout, a deploy, or a container restart.'
    : 'NO signal was recorded. SIGTERM and SIGINT are caught and would have been, so this was a ' +
      'SIGKILL, a crash, or the machine going away — not a polite shutdown.';

  return {
    phase,
    phaseMs,
    title: `Previous execution run died in "${phase}"`,
    detail:
      `A run (pid ${pid}) started ${rec.at} never released its lock. Last phase: "${phase}", ` +
      `entered ${rec.phaseAt} and still in it after ${humanMs(phaseMs)}. Memory at that point: ` +
      `${rec.rssMb}MB. ${cause} Any order in flight at that moment may have filled without being ` +
      'recorded; orphan recovery reconciles that against broker positions on the next run.',
  };
}
