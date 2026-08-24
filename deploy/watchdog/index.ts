/**
 * ibkr-fund-watchdog
 *
 * Pi-side liveness watchdog for the bezant Docker container. Runs once per
 * minute via systemd timer. Restarts the container on either of two failures:
 *
 *   1. `/health` 5xx or unreachable for 5 consecutive probes.
 *   2. The event feed is wedged for 10 consecutive probes WHILE `/health`
 *      still reports `authenticated` (see STREAM_URL below).
 *
 * (2) exists because (1) was not enough. `/health` describes the GATEWAY, not
 * the feed. On 2026-08-08 the upstream websocket died and stayed dead for four
 * days: /health answered `authenticated` the whole time, this watchdog logged
 * "(healthy)" every minute, and nothing restarted anything. The outage was
 * found by hand. Fill confirmation and intraday drawdown both derive from that
 * feed, so "authenticated but silent" is an outage, not a curiosity.
 *
 * IMPORTANT: this watchdog does NOT restart on `ibkr-fund-relogin` having
 * disabled itself. The disabled sentinel is the user's "I'm not around to
 * tap a phone push right now" signal; auto-restarting and re-enabling
 * relogin in that case just spams the phone with IB Key pushes during
 * gym/sleep/meeting hours. If the disabled flag is present, the watchdog
 * leaves it alone and the user re-enables manually when they're ready.
 *
 * After a 5xx-triggered restart we DO clear the disabled sentinel — the
 * working assumption is the disable was caused by the same wedged state
 * the restart just fixed, so we want relogin to retry.
 *
 * 2-hour cooldown between restarts prevents loops on persistent issues.
 *
 * Logs go to stdout → systemd journal. Tail with:
 *   journalctl --user -u ibkr-fund-watchdog -f
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ---------- config ----------

const HEALTH_URL = process.env.BEZANT_HEALTH_URL ?? 'http://localhost:8080/health';
const CONTAINER_NAME = process.env.BEZANT_CONTAINER ?? 'bezant';
const RELOGIN_DISABLED_FILE =
  process.env.BEZANT_RELOGIN_DISABLED_FILE ??
  path.join(os.homedir(), '.local', 'state', 'bezant-relogin', 'disabled');
const RELOGIN_STATE_FILE =
  process.env.BEZANT_RELOGIN_STATE_FILE ??
  path.join(os.homedir(), '.local', 'state', 'bezant-relogin', 'state.json');
const STATE_DIR =
  process.env.BEZANT_WATCHDOG_STATE_DIR ??
  path.join(os.homedir(), '.local', 'state', 'bezant-watchdog');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const HEALTH_TIMEOUT_MS = 5_000;
const SERVER_ERROR_THRESHOLD = 5; // consecutive 5xx/unreachable probes before restart
const RESTART_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours minimum between restarts
const POST_RESTART_HEALTH_PROBES = 12; // wait up to 60s for /health to come back
const POST_RESTART_PROBE_INTERVAL_MS = 5_000;
// Silent-outage backstop: if the fund stays logged out this long AND relogin
// has disabled itself, alert (the condition that caused a ~2-week outage).
// Stream liveness. /health only reports whether the GATEWAY is authenticated,
// which is not the same thing as the event feed working: on 2026-08-08 the
// upstream websocket died and stayed dead for four days while /health kept
// answering `authenticated` and this watchdog kept logging "(healthy)". The
// feed is what execution-bot's fill confirmation and risk-manager's intraday
// drawdown are built on, so a wedged stream is a real outage, not a warning.
const STREAM_URL = process.env.BEZANT_STREAM_URL ?? 'http://localhost:8080/events/_status';
// Wedged = not connected, OR connected but silent. Both are needed: during the
// August outage the connector flapped — it would reconnect for ~90s before a
// heartbeat timeout killed it — so `connected` alone kept resetting the counter
// while `last_message_at` stayed pinned to the day it actually broke.
const STREAM_STALE_MS = 15 * 60 * 1000; // observed cadence is ~60s, so 15min of silence is anomalous
const STREAM_WEDGED_THRESHOLD = 10; // ≈10 consecutive probes (≈10 min) before bouncing
const NOT_AUTH_ALERT_THRESHOLD = 30; // ≈30 consecutive not_authenticated probes (≈30 min)
const DOWN_ALERT_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-alert at most every 6h while down
const ALERT_WEBHOOK = process.env.IBKR_FUND_ALERT_WEBHOOK; // optional Slack/Discord/ntfy {"text"} webhook

// ---------- types ----------

type HealthState = 'authenticated' | 'not_authenticated' | 'server_error' | 'unreachable';

interface WatchdogState {
  lastHealthState: HealthState | null;
  consecutiveServerErrors: number;
  consecutiveNotAuthenticated: number;
  consecutiveStreamWedged: number;
  lastRestartAt: string | null;
  lastRestartReason: string | null;
  totalRestarts: number;
  lastDownAlertAt: string | null;
}

const DEFAULT_STATE: WatchdogState = {
  lastHealthState: null,
  consecutiveServerErrors: 0,
  consecutiveNotAuthenticated: 0,
  consecutiveStreamWedged: 0,
  lastRestartAt: null,
  lastRestartReason: null,
  totalRestarts: 0,
  lastDownAlertAt: null,
};

// ---------- state persistence ----------

async function loadState(): Promise<WatchdogState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

async function saveState(state: WatchdogState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, STATE_FILE);
}

// ---------- probes ----------

async function probeHealth(): Promise<HealthState> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (res.status === 200) {
      const body = (await res.json()) as { authenticated?: boolean };
      return body.authenticated ? 'authenticated' : 'not_authenticated';
    }
    if (res.status === 401) return 'not_authenticated';
    return 'server_error';
  } catch {
    return 'unreachable';
  }
}

/**
 * Is the event feed actually delivering?
 *
 * Returns null when we cannot tell (endpoint unreachable or malformed) — the
 * caller treats "unknown" as not-wedged on purpose. A restart is a blunt act on
 * a live book, so it should require positive evidence of a wedge, never the
 * mere absence of evidence of health.
 */
async function probeStream(): Promise<{ wedged: boolean; detail: string } | null> {
  try {
    const res = await fetch(STREAM_URL, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { connected?: unknown; last_message_at?: unknown };
    if (typeof body.connected !== 'boolean') return null;

    const lastAt = typeof body.last_message_at === 'string' ? Date.parse(body.last_message_at) : NaN;
    // A never-connected-since-boot feed reports null; that is genuinely silent,
    // so treat an unparseable timestamp as stale rather than as unknown.
    const silentMs = Number.isNaN(lastAt) ? Infinity : Date.now() - lastAt;
    const stale = silentMs > STREAM_STALE_MS;

    const age = silentMs === Infinity ? 'never' : `${Math.floor(silentMs / 60_000)}min`;
    return {
      wedged: !body.connected || stale,
      detail: `connected=${body.connected} last_message=${age}`,
    };
  } catch {
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function getReloginFailureCount(): Promise<number> {
  try {
    const raw = await fs.readFile(RELOGIN_STATE_FILE, 'utf8');
    const s = JSON.parse(raw) as { consecutiveFailures?: unknown };
    return typeof s.consecutiveFailures === 'number' ? s.consecutiveFailures : 0;
  } catch {
    return 0;
  }
}

// ---------- actions ----------

async function restartContainer(reason: string): Promise<boolean> {
  log(`RESTARTING ${CONTAINER_NAME}: ${reason}`);
  try {
    await execAsync(`docker restart ${CONTAINER_NAME}`, { timeout: 60_000 });
    log(`docker restart returned successfully — waiting for /health to respond`);
  } catch (err) {
    log(`docker restart FAILED: ${(err as Error).message}`);
    return false;
  }
  for (let i = 0; i < POST_RESTART_HEALTH_PROBES; i++) {
    await new Promise((r) => setTimeout(r, POST_RESTART_PROBE_INTERVAL_MS));
    const h = await probeHealth();
    if (h !== 'unreachable') {
      log(`Post-restart /health responsive: ${h}`);
      return true;
    }
  }
  log(`Post-restart /health still unreachable after 60s`);
  return false;
}

async function clearReloginDisabled(): Promise<void> {
  try {
    await fs.unlink(RELOGIN_DISABLED_FILE);
    log('Cleared bezant-relogin disabled sentinel — next 5-min relogin tick will retry');
  } catch {
    /* not present, no-op */
  }
}

// ---------- logging ----------

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [watchdog] ${msg}`);
}

/**
 * Best-effort alert to an optional webhook (Slack/Discord/ntfy `{"text"}`).
 * No-op when IBKR_FUND_ALERT_WEBHOOK is unset.
 */
async function alert(text: string): Promise<void> {
  if (!ALERT_WEBHOOK) return;
  try {
    await fetch(ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `:rotating_light: [ibkr-fund-watchdog] ${text}` }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    log(`alert webhook failed: ${(err as Error).message}`);
  }
}

// ---------- main ----------

async function main(): Promise<void> {
  const state = await loadState();
  const now = new Date();

  const currentHealth = await probeHealth();
  if (state.lastHealthState !== currentHealth) {
    log(`/health transition: ${state.lastHealthState ?? '<first>'} → ${currentHealth}`);
    state.lastHealthState = currentHealth;
  }

  if (currentHealth === 'server_error' || currentHealth === 'unreachable') {
    state.consecutiveServerErrors += 1;
  } else {
    state.consecutiveServerErrors = 0;
  }

  if (currentHealth === 'not_authenticated') {
    state.consecutiveNotAuthenticated += 1;
  } else {
    state.consecutiveNotAuthenticated = 0;
  }

  // Stream wedge is only OUR problem when the gateway is otherwise fine. If the
  // gateway is unauthenticated the feed cannot work by definition, and that is
  // relogin's job — restarting would be both useless and actively harmful. We
  // learned this the hard way on 2026-08-12: bouncing the container dropped the
  // gateway to `not authenticated`, and only a relogin brought the feed back.
  const stream = currentHealth === 'authenticated' ? await probeStream() : null;
  if (stream?.wedged) {
    state.consecutiveStreamWedged += 1;
  } else {
    state.consecutiveStreamWedged = 0;
  }

  const sinceLastRestart = state.lastRestartAt
    ? now.getTime() - new Date(state.lastRestartAt).getTime()
    : Infinity;
  const cooldownActive = sinceLastRestart < RESTART_COOLDOWN_MS;

  const reloginDisabled = await pathExists(RELOGIN_DISABLED_FILE);
  const reloginFailures = await getReloginFailureCount();

  let restartReason: string | null = null;

  if (cooldownActive) {
    const cdMin = Math.floor((RESTART_COOLDOWN_MS - sinceLastRestart) / 60_000);
    log(
      `status: health=${currentHealth} relogin_failures=${reloginFailures} relogin_disabled=${reloginDisabled} (cooldown ${cdMin}min remaining)`,
    );
  } else if (state.consecutiveServerErrors >= SERVER_ERROR_THRESHOLD) {
    restartReason = `${state.consecutiveServerErrors} consecutive server_error/unreachable probes`;
  } else if (state.consecutiveStreamWedged >= STREAM_WEDGED_THRESHOLD) {
    restartReason =
      `event stream wedged for ${state.consecutiveStreamWedged} consecutive probes ` +
      `(${stream?.detail ?? 'no detail'}) while /health reported authenticated`;
  } else {
    log(
      `status: health=${currentHealth} stream=${stream ? stream.detail : 'n/a'} ` +
        `stream_wedged=${state.consecutiveStreamWedged} relogin_failures=${reloginFailures} ` +
        `relogin_disabled=${reloginDisabled} (healthy)`,
    );
  }

  if (restartReason) {
    const ok = await restartContainer(restartReason);
    state.lastRestartAt = now.toISOString();
    state.lastRestartReason = restartReason;
    state.consecutiveServerErrors = 0;
    state.totalRestarts += 1;
    if (ok) {
      await clearReloginDisabled();
      // bezant was hard-down (not just logged out) and we bounced it — surface
      // it so a recurring crash loop is visible, not silent.
      await alert(`IBKR fund: bezant was down (${restartReason}) — auto-restarted the container (restart #${state.totalRestarts}).`);
    } else {
      // Restart itself failed — bezant is down AND self-heal didn't work.
      await alert(`🚨 IBKR fund: bezant down (${restartReason}) and the auto-restart FAILED — manual intervention needed on the Pi.`);
    }
    state.lastHealthState = await probeHealth();
    state.consecutiveNotAuthenticated = 0;
    // The restart itself usually drops the gateway to `not authenticated`; the
    // 5-minute relogin tick re-establishes it, and only then can the feed come
    // back. So do not re-probe the stream here and do not expect it healthy yet
    // — just clear the counter so we re-measure from the new baseline rather
    // than immediately re-triggering once the cooldown lapses.
    state.consecutiveStreamWedged = 0;
  }

  // Silent-outage backstop: fund logged out for a sustained period AND relogin
  // has given up (disabled). relogin alerts when it disables; this also covers
  // disables predating alerting, or a missed webhook. Re-alerts ≤ every 6h.
  if (state.consecutiveNotAuthenticated >= NOT_AUTH_ALERT_THRESHOLD && reloginDisabled) {
    const sinceAlert = state.lastDownAlertAt
      ? now.getTime() - new Date(state.lastDownAlertAt).getTime()
      : Infinity;
    if (sinceAlert >= DOWN_ALERT_INTERVAL_MS) {
      await alert(
        `IBKR fund has been logged out for ~${state.consecutiveNotAuthenticated}+ min and ` +
          `auto-relogin is DISABLED. Reset: ssh your-pi 'rm -f ` +
          `~/.local/state/bezant-relogin/disabled && systemctl --user start ibkr-fund-relogin.service'`,
      );
      state.lastDownAlertAt = now.toISOString();
      log(`down-alert sent (not_authenticated ×${state.consecutiveNotAuthenticated}, relogin disabled)`);
    }
  }

  await saveState(state);
}

main().catch((err) => {
  log(`Fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
