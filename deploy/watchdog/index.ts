/**
 * ibkr-fund-watchdog
 *
 * Pi-side liveness watchdog for the bezant Docker container, run once a minute
 * by a systemd timer. The decisions live in watchdog.ts (tested against a fake
 * bezant); this file only wires them to the real world.
 *
 * History that shaped it:
 *   - 2026-08-08: the upstream websocket died for four days while /health said
 *     `authenticated`. Stream liveness has been watched ever since — but a
 *     silent stream now gets a reconnect and a reauthenticate, never a restart,
 *     because a restart always costs the session (learned 2026-08-12).
 *   - 2026-09-03: ssodh/init returned 500 for hours while logged out, so no
 *     login could complete. Still restarted, by day.
 *   - 2026-09-24 review (WS-B): quiet hours 23:00–07:00 (D5), thresholds in
 *     elapsed seconds, the session lock, `upstream_failing`, and a dry-run
 *     mode to watch the new policy before it acts.
 *
 * Relogin's park (the `disabled` sentinel) is the operator's "I'm not around to
 * tap a push" signal. It is cleared only after a dead-gateway restart, and
 * never in quiet hours.
 *
 * Config (env, or .env in this directory):
 *   WATCHDOG_RESTART        on | dry-run (default dry-run)
 *   BEZANT_HEALTH_URL       default http://localhost:8080/health
 *   BEZANT_DEBUG_TOKEN      bezant's debug token, for POST /events/_reconnect.
 *                           Unset → the reconnect rung 401s and is skipped.
 *   BEZANT_CONTAINER        default bezant
 *   BEZANT_RESTART_CMD      default `docker restart $BEZANT_CONTAINER`
 *   IBKR_SESSION_LOCK_DIR   default ~/.local/state/ibkr-session
 *   IBKR_FUND_ALERT_WEBHOOK optional Slack/Discord/ntfy {"text"} webhook.
 *     SILENCING THIS FOR A TEST: set it EMPTY, never unset — dotenv refills an
 *     absent variable from .env, and a self-test once paged for real that way.
 *
 * Logs: journalctl --user -u ibkr-fund-watchdog -f
 */
import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { feed } from '../lib/ops-feed.js';
import { defaultLockDir } from '../lib/session-lock.js';
import { tick, DEFAULT_THRESHOLDS, type WatchdogConfig, type RestartMode } from './watchdog.js';

const execAsync = promisify(exec);

const HEALTH_URL = process.env.BEZANT_HEALTH_URL ?? 'http://localhost:8080/health';
const CONTAINER = process.env.BEZANT_CONTAINER ?? 'bezant';
const RESTART_CMD = process.env.BEZANT_RESTART_CMD ?? `docker restart ${CONTAINER}`;
const ALERT_WEBHOOK = process.env.IBKR_FUND_ALERT_WEBHOOK;
const STATE_DIR =
  process.env.BEZANT_WATCHDOG_STATE_DIR ?? path.join(os.homedir(), '.local', 'state', 'bezant-watchdog');

function restartMode(): RestartMode {
  const v = (process.env.WATCHDOG_RESTART ?? '').trim().toLowerCase();
  if (v === 'on') return 'on';
  if (v && v !== 'dry-run') log(`WATCHDOG_RESTART=${v} is not on|dry-run — using dry-run`);
  return 'dry-run';
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [watchdog] ${msg}`);
}

async function alert(text: string): Promise<void> {
  if (!ALERT_WEBHOOK) return;
  // One retry: a watchdog alert is rare and a dropped one is an outage nobody
  // hears about.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(ALERT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `:rotating_light: [ibkr-fund-watchdog] ${text}` }),
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) return;
      log(`alert webhook answered HTTP ${res.status}`);
    } catch (err) {
      log(`alert webhook failed: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

const cfg: WatchdogConfig = {
  baseUrl: HEALTH_URL.replace(/\/health\/?$/, ''),
  debugToken: process.env.BEZANT_DEBUG_TOKEN || undefined,
  restartMode: restartMode(),
  stateFile: path.join(STATE_DIR, 'state.json'),
  reloginDisabledFile:
    process.env.BEZANT_RELOGIN_DISABLED_FILE ??
    path.join(os.homedir(), '.local', 'state', 'bezant-relogin', 'disabled'),
  reloginStateFile:
    process.env.BEZANT_RELOGIN_STATE_FILE ??
    path.join(os.homedir(), '.local', 'state', 'bezant-relogin', 'state.json'),
  lockDir: defaultLockDir(),
  probeTimeoutMs: 5_000,
  postRestartProbes: 12,
  postRestartIntervalMs: 5_000,
  thresholds: DEFAULT_THRESHOLDS,
};

tick(cfg, {
  now: () => new Date(),
  restart: async () => {
    try {
      await execAsync(RESTART_CMD, { timeout: 60_000 });
      return true;
    } catch (err) {
      log(`${RESTART_CMD} failed: ${(err as Error).message}`);
      return false;
    }
  },
  feed,
  alert,
  log,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}).catch((err) => {
  log(`Fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
