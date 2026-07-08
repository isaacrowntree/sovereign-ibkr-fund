/**
 * Sovereign — main entry point (daemon mode).
 *
 * Starts the status server and, unless disabled, the built-in scheduler that
 * runs the fund with no external orchestrator. Set `ENABLE_SCHEDULER=false`
 * when an external orchestrator (paperclip, cron, systemd) triggers the agents
 * instead — then this process just serves status.
 *
 * Individual agents are also invokable directly via `--once`
 * (e.g. `node dist/agents/execution-bot.js --once`).
 */
import { startStatusServer } from './status/server.js';
import { startScheduler } from './scheduler/index.js';
import { log } from './log.js';

function main(): void {
  log('Sovereign starting (daemon mode)');
  startStatusServer();
  if (process.env.ENABLE_SCHEDULER !== 'false') {
    startScheduler();
  } else {
    log('scheduler disabled (ENABLE_SCHEDULER=false) — expecting an external orchestrator');
  }
}

if (!process.argv.includes('--once')) {
  main();
}
