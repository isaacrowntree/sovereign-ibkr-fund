/**
 * What every agent does before its first real line of work.
 *
 * Deliberately imports nothing that resolves the portfolio or opens the
 * ledger: the observer and the digest call this too, and they must not start
 * failing because a model file is invalid. Agents that have loaded
 * ../config.js pass it in to be logged.
 */
import { getNotifier, noopNotifier } from './notify/index.js';
import { log } from './log.js';

/**
 * Refuse to run live with alerting silently switched off.
 *
 * getNotifier() falls back to noop whenever IBKR_FUND_ALERT_WEBHOOK is absent,
 * so a typo in the variable NAME degrades this fund to /dev/null without a
 * single error — you'd find out when a disconnection page didn't reach you.
 * (Since the 2026-09-24 paging policy, notify/policy.ts, that is the only
 * kind of message the agents send to Slack; everything else is on the feed.)
 *
 * It used to run only in the daemon (src/index.ts), which production never
 * starts: every agent there is a `--once` process, so the check guarded nothing.
 *
 * An explicit `NOTIFIER=noop` is still honoured: the point is to force the
 * choice to be deliberate and auditable, not to forbid it. Failing at start is
 * not "taking down a trading run" — nothing has traded yet.
 */
export function assertNotifierConfigured(env: NodeJS.ProcessEnv = process.env): void {
  const live = (env.TRADING_MODE || 'paper') === 'live';
  const explicitNoop = (env.NOTIFIER || '').toLowerCase() === 'noop';
  if (live && !explicitNoop && getNotifier() === noopNotifier) {
    throw new Error(
      'TRADING_MODE=live but no notifier is configured — a fund-disconnection page (the ' +
        'one thing the fund still sends to Slack) would be silently dropped. Set IBKR_FUND_ALERT_WEBHOOK, ' +
        'or set NOTIFIER=noop to silence alerts deliberately.',
    );
  }
}

/**
 * Live mode must SAY which optimizer it runs.
 *
 * The default used to be 'hrp', so a .env that lost its OPTIMIZER line —
 * a bad merge, a host rebuilt from .env.example — silently switched the live
 * book from its deliberate static weights to an optimizer. The default is now
 * 'static', the safe one, but a live strategist still refuses to guess.
 */
export function assertLiveStrategyConfig(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.TRADING_MODE || 'paper') === 'live' && !(env.OPTIMIZER || '').trim()) {
    throw new Error(
      'TRADING_MODE=live but OPTIMIZER is not set — refusing to pick an optimizer for a real book. ' +
        'Set OPTIMIZER explicitly (static | hrp | black_litterman | equal_weight).',
    );
  }
}

/**
 * The switches the plan (and ops) rely on, logged by name whatever their value
 * — "unset" is itself the thing you want to see when a behaviour surprises you.
 */
const FLAG_KEYS = [
  'TRADING_MODE', 'NOTIFIER', 'NOTIFY_OUTBOX', 'STATE_DIR',
  'EXECUTION_ENABLED', 'REPLY_POLICY', 'RUN_BUDGET_SEC', 'CALENDAR_FAIL_OPEN',
  'INTRADAY_DD_SOURCE', 'WASH_SALE_BLOCK', 'RISK_NAV_SOURCE', 'DRIFT_GATE',
  'OPTIMIZER', 'ENABLE_REGIME', 'REBALANCE_MIN_TRADE_USD', 'REBALANCE_DRIFT_THRESHOLD', 'YIELD_MODE',
  'OBSERVER_BLIP_MINUTES', 'RECONCILE_STALE_HOURS', 'RECONCILE_DRIFT_REF', 'DIGEST_STALE_HOURS',
];

/** Keys whose values are credentials or identify the account. Never logged. */
const SECRET_KEY = /secret|token|password|webhook|accountid|clientid|apikey/i;

/** Flatten a config object to `a.b.c = value`, with secrets redacted. */
export function flattenConfig(obj: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    out[prefix] = obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (SECRET_KEY.test(k)) out[key] = v === undefined || v === null || v === '' ? v : '[redacted]';
    else flattenConfig(v, key, out);
  }
  return out;
}

export function effectiveConfig(config?: unknown, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const flags: Record<string, string> = {};
  for (const k of FLAG_KEYS) flags[k] = env[k] ?? '(unset)';
  return {
    notifier: getNotifier() === noopNotifier ? 'noop' : 'webhook',
    ...flags,
    ...(config === undefined ? {} : flattenConfig(config)),
  };
}

/**
 * Run at the top of every `--once` entry point. Throws on a configuration that
 * must not start; the entry point turns that into a non-zero exit.
 */
export function agentStartup(
  agent: string,
  opts: { config?: unknown; requireExplicitOptimizer?: boolean } = {},
): void {
  assertNotifierConfigured();
  if (opts.requireExplicitOptimizer) assertLiveStrategyConfig();
  // One line, so a journal grep for "effective config" gives the whole picture
  // of what a run believed, next to what it did.
  log(`effective config: ${JSON.stringify(effectiveConfig(opts.config))}`, agent);
}
