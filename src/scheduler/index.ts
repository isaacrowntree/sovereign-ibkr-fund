/**
 * Standalone scheduler — runs the whole fund with zero external orchestrator.
 *
 * It spawns each agent as `node dist/agents/<agent>.js --once` on its own
 * interval. That is the EXACT execution path paperclip / cron / systemd use, so
 * agents behave identically however they're triggered — the scheduler is just
 * one more way to pull the same `--once` contract.
 *
 * - Single-flight per agent: never starts a run while the previous one is still
 *   active (mirrors paperclip's `maxConcurrentRuns: 1`).
 * - Cadence mirrors the production heartbeat; override any agent via env
 *   (e.g. `SCHED_EXEC_SEC=3600`).
 * - Disable entirely with `ENABLE_SCHEDULER=false` when an external orchestrator
 *   (paperclip, cron) is doing the scheduling instead.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { log, logError } from '../log.js';

const AGENT = 'Scheduler';

interface AgentSchedule {
  name: string;
  script: string;
  intervalSec: number;
}

function sec(envKey: string, def: number): number {
  const v = parseInt(process.env[envKey] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

// Default cadence mirrors the production paperclip heartbeat.
const SCHEDULE: AgentSchedule[] = [
  { name: 'managing-partner',     script: 'managing-partner.js',     intervalSec: sec('SCHED_CEO_SEC', 14_400) },
  { name: 'portfolio-strategist', script: 'portfolio-strategist.js', intervalSec: sec('SCHED_STRATEGIST_SEC', 14_400) },
  { name: 'quant-analyst',        script: 'quant-analyst.js',        intervalSec: sec('SCHED_QUANT_SEC', 14_400) },
  { name: 'risk-manager',         script: 'risk-manager.js',         intervalSec: sec('SCHED_RISK_SEC', 14_400) },
  { name: 'execution-bot',        script: 'execution-bot.js',        intervalSec: sec('SCHED_EXEC_SEC', 14_400) },
  { name: 'tax-optimizer',        script: 'tax-optimizer.js',        intervalSec: sec('SCHED_TAX_SEC', 86_400) },
  { name: 'hedger',               script: 'hedger.js',               intervalSec: sec('SCHED_HEDGER_SEC', 86_400) },
  { name: 'research-scout',       script: 'research-scout.js',       intervalSec: sec('SCHED_SCOUT_SEC', 86_400) },
];

const running = new Set<string>();

function runAgent(a: AgentSchedule): void {
  if (running.has(a.name)) {
    log(`skip ${a.name} — previous run still active`, AGENT);
    return;
  }
  const script = join(__dirname, '..', 'agents', a.script);
  running.add(a.name);
  const started = Date.now();
  const child = spawn(process.execPath, [script, '--once'], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => {
    running.delete(a.name);
    const secs = Math.round((Date.now() - started) / 1000);
    if (code === 0) log(`${a.name} finished (${secs}s)`, AGENT);
    else logError(`${a.name} exited ${code}`, `after ${secs}s`, AGENT);
  });
  child.on('error', (err) => {
    running.delete(a.name);
    logError(`${a.name} failed to spawn`, err, AGENT);
  });
}

/** Start the scheduler: kick each agent (staggered) then run it on its interval. */
export function startScheduler(): void {
  log(`starting — ${SCHEDULE.length} agents`, AGENT);
  SCHEDULE.forEach((a, i) => {
    log(`${a.name}: every ${a.intervalSec}s`, AGENT);
    // Staggered first run so we don't spawn all agents against bezant at once.
    setTimeout(() => runAgent(a), i * 3_000);
    setInterval(() => runAgent(a), a.intervalSec * 1_000);
  });
}

if (require.main === module) {
  startScheduler();
}
