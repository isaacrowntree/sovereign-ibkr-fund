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
import { config } from './config.js';
import { getNotifier, noopNotifier } from './notify/index.js';
import { log } from './log.js';

/**
 * Refuse to run live with alerting silently switched off.
 *
 * getNotifier() falls back to noop whenever IBKR_FUND_ALERT_WEBHOOK is absent,
 * so a typo in the variable NAME degrades this fund to /dev/null without a
 * single error — you'd find out when a hard stop didn't reach you.
 *
 * An explicit `NOTIFIER=noop` is still honoured: the point is to force the
 * choice to be deliberate and auditable, not to forbid it. Failing at boot is
 * not "taking down a trading run" — nothing has traded yet.
 */
function assertNotifierConfigured(): void {
  const explicitNoop = (process.env.NOTIFIER || '').toLowerCase() === 'noop';
  if (config.tradingMode === 'live' && !explicitNoop && getNotifier() === noopNotifier) {
    throw new Error(
      'TRADING_MODE=live but no notifier is configured — every alert, including the ' +
        'drawdown hard stop, would be silently dropped. Set IBKR_FUND_ALERT_WEBHOOK, ' +
        'or set NOTIFIER=noop to silence alerts deliberately.',
    );
  }
}

function main(): void {
  log('Sovereign starting (daemon mode)');
  assertNotifierConfigured();
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
