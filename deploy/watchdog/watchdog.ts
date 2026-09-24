/**
 * One watchdog tick: probe bezant, decide, act. Effects come in through
 * `WatchdogDeps` so the whole decision can run against a fake bezant with a
 * fake clock (see test/fake-bezant.mjs and watchdog.test.ts); index.ts wires
 * the real ones.
 *
 * What it will and will not do, and why (2026-09-24 review, WS-B):
 *
 *   gateway DEAD      /health 5xx or unreachable for DEAD_AFTER_S → restart,
 *                     day or night. This is the one case D5 allows at night:
 *                     nothing is working, so there is no session to lose.
 *                     Only this kind of restart clears relogin's park, and
 *                     never 23:00–07:00 (a cleared park at 02:00 is an IB Key
 *                     push nobody taps).
 *   SSO bridge wedged logged out and ssodh/init 5xx for SSO_WEDGED_AFTER_S →
 *                     restart, by day only. (The container's own SSO watch
 *                     usually gets there first.)
 *   upstream failing  bezant up, api.ibkr.com failing (`upstream_failing` on
 *                     /health) → NEVER restart: a restart cannot fix IBKR's
 *                     side and logs the fund out. Alert after a time limit.
 *   stream silent     authenticated but the event feed is dead → NEVER restart.
 *                     This used to bounce the container, and a bounce always
 *                     costs the session. Instead: POST /events/_reconnect
 *                     (a 404 means an older bezant, fall through), then
 *                     /iserver/reauthenticate, then alert. The fund confirms
 *                     fills from /trades when the stream is quiet.
 *
 * Every threshold is ELAPSED SECONDS since the condition was first seen, not a
 * count of ticks: the timer's default AccuracySec let "5 probes" mean anything
 * from 5 to 10 minutes, and a Pi that was off for an hour must not come back
 * and count one probe as five. A gap longer than MAX_GAP_S between probes
 * throws away every streak, because the evidence is no longer continuous.
 *
 * Nothing that touches the session happens while someone else holds the
 * session lock (a login in flight, a hub reset); the watchdog takes the same
 * lock for its own restart.
 *
 * WATCHDOG_RESTART=dry-run (the default for now) logs every restart, park
 * clear and reauthenticate it WOULD do and does none of them. The stream
 * reconnect still runs — it touches only bezant's own websocket — and alerts
 * still fire, because they are the thing being observed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { acquire, currentHolder, describeHolder, type Holder } from '../lib/session-lock.js';
import { isQuietHours } from '../lib/quiet-hours.js';
import type { FeedEvent } from '../lib/ops-feed.js';

export type HealthState =
  | 'authenticated'
  | 'not_authenticated'
  | 'upstream_failing'
  | 'server_error'
  | 'unreachable';

export type RestartMode = 'on' | 'dry-run';

export interface Thresholds {
  deadAfterS: number;
  ssoWedgedAfterS: number;
  streamStaleS: number;
  streamReconnectAfterS: number;
  streamStepWaitS: number;
  streamAlertAfterS: number;
  upstreamAlertAfterS: number;
  notAuthAlertAfterS: number;
  restartCooldownS: number;
  downAlertIntervalS: number;
  maxGapS: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  deadAfterS: 300,
  ssoWedgedAfterS: 300,
  // Observed feed cadence is ~60s; 15 min of silence is anomalous.
  streamStaleS: 15 * 60,
  streamReconnectAfterS: 10 * 60,
  streamStepWaitS: 5 * 60,
  streamAlertAfterS: 30 * 60,
  upstreamAlertAfterS: 15 * 60,
  notAuthAlertAfterS: 30 * 60,
  restartCooldownS: 2 * 60 * 60,
  downAlertIntervalS: 6 * 60 * 60,
  maxGapS: 180,
};

export interface WatchdogConfig {
  baseUrl: string; // e.g. http://localhost:8080 — /health, /events/* and /v1/api/* hang off it
  debugToken?: string;
  restartMode: RestartMode;
  stateFile: string;
  reloginDisabledFile: string;
  reloginStateFile: string;
  lockDir: string;
  probeTimeoutMs: number;
  postRestartProbes: number;
  postRestartIntervalMs: number;
  thresholds: Thresholds;
}

export interface WatchdogDeps {
  now(): Date;
  /** Run the container restart. Resolves true when the command succeeded. */
  restart(): Promise<boolean>;
  feed(ev: FeedEvent): void;
  alert(text: string): Promise<void>;
  log(msg: string): void;
  sleep(ms: number): Promise<void>;
}

type StreamStep = 'none' | 'reconnect' | 'reauth';

export interface WatchdogState {
  lastProbeAt: string | null;
  lastHealthState: HealthState | null;
  serverErrorSince: string | null;
  notAuthSince: string | null;
  ssoFaultSince: string | null;
  streamWedgedSince: string | null;
  streamStep: StreamStep;
  streamStepAt: string | null;
  streamAlertedAt: string | null;
  upstreamFailingSince: string | null;
  upstreamAlertedAt: string | null;
  lastRestartAt: string | null;
  lastRestartReason: string | null;
  totalRestarts: number;
  lastWouldRestartAt: string | null;
  lastDownAlertAt: string | null;
}

export const DEFAULT_STATE: WatchdogState = {
  lastProbeAt: null,
  lastHealthState: null,
  serverErrorSince: null,
  notAuthSince: null,
  ssoFaultSince: null,
  streamWedgedSince: null,
  streamStep: 'none',
  streamStepAt: null,
  streamAlertedAt: null,
  upstreamFailingSince: null,
  upstreamAlertedAt: null,
  lastRestartAt: null,
  lastRestartReason: null,
  totalRestarts: 0,
  lastWouldRestartAt: null,
  lastDownAlertAt: null,
};

/** The SSO bridge path. Same endpoint assisted-login pokes during a login. */
export const SSODH_INIT_PATH = '/v1/api/iserver/auth/ssodh/init';
export const REAUTH_PATH = '/v1/api/iserver/reauthenticate';
export const RECONNECT_PATH = '/events/_reconnect';

// ---------- state ----------

export async function loadState(file: string): Promise<WatchdogState> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<WatchdogState>;
    // Older state files carry tick counters (consecutiveServerErrors, ...).
    // They are dropped on purpose: a count cannot be turned into an elapsed
    // time, and the streaks rebuild within one threshold.
    const s: WatchdogState = { ...DEFAULT_STATE };
    for (const k of Object.keys(DEFAULT_STATE) as (keyof WatchdogState)[]) {
      if (k in raw) (s as unknown as Record<string, unknown>)[k] = raw[k];
    }
    return s;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

async function saveState(file: string, state: WatchdogState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, file);
}

// ---------- probes ----------

interface HealthProbe {
  state: HealthState;
  detail: string;
}

export async function probeHealth(cfg: WatchdogConfig): Promise<HealthProbe> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/health`, { signal: AbortSignal.timeout(cfg.probeTimeoutMs) });
  } catch {
    return { state: 'unreachable', detail: 'no answer' };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON body: judge on status alone */
  }
  // Checked before the status code on purpose: bezant may report this state
  // on a 5xx, and it must never be read as "the gateway is dead". Both the
  // field and a `code` of the same name are accepted, and their absence (an
  // older bezant) simply means "not failing".
  // bezant ≥ the events-fix release says `code: "gateway_upstream_failing"`
  // (gateway reachable, its auth/status answering 5xx); the bare field is
  // accepted too so either spelling keeps the watchdog's hands off.
  if (
    body.upstream_failing === true ||
    body.code === 'upstream_failing' ||
    body.code === 'gateway_upstream_failing'
  ) {
    return { state: 'upstream_failing', detail: `HTTP ${res.status}` };
  }
  if (res.status === 200) {
    return body.authenticated === true
      ? { state: 'authenticated', detail: 'HTTP 200' }
      : { state: 'not_authenticated', detail: 'HTTP 200 authenticated=false' };
  }
  if (res.status === 401) return { state: 'not_authenticated', detail: 'HTTP 401' };
  if (res.status >= 500) return { state: 'server_error', detail: `HTTP ${res.status}` };
  // Anything else (3xx, other 4xx) is not evidence of a dead gateway.
  return { state: 'not_authenticated', detail: `HTTP ${res.status}` };
}

/**
 * Is the event feed delivering? null = cannot tell (endpoint unreachable or
 * malformed), which is treated as not-wedged on purpose: acting needs positive
 * evidence of a wedge, never the absence of evidence of health.
 */
async function probeStream(
  cfg: WatchdogConfig,
  nowMs: number,
): Promise<{ wedged: boolean; detail: string } | null> {
  try {
    const res = await fetch(`${cfg.baseUrl}/events/_status`, {
      signal: AbortSignal.timeout(cfg.probeTimeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { connected?: unknown; last_message_at?: unknown };
    if (typeof body.connected !== 'boolean') return null;
    const lastAt = typeof body.last_message_at === 'string' ? Date.parse(body.last_message_at) : NaN;
    const silentS = Number.isNaN(lastAt) ? Infinity : (nowMs - lastAt) / 1000;
    const age = silentS === Infinity ? 'never' : `${Math.floor(silentS / 60)}min`;
    return {
      wedged: !body.connected || silentS > cfg.thresholds.streamStaleS,
      detail: `connected=${body.connected} last_message=${age}`,
    };
  } catch {
    return null;
  }
}

/** HTTP status of a POST, or null when the request itself failed. */
async function post(cfg: WatchdogConfig, pathname: string, body: unknown, headers: Record<string, string> = {}) {
  try {
    const res = await fetch(`${cfg.baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.probeTimeoutMs),
    });
    return res.status;
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function reloginFailures(file: string): Promise<number> {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8')) as { consecutiveFailures?: unknown };
    return typeof s.consecutiveFailures === 'number' ? s.consecutiveFailures : 0;
  } catch {
    return 0;
  }
}

// ---------- the tick ----------

const secsSince = (iso: string | null, nowMs: number): number =>
  iso ? (nowMs - Date.parse(iso)) / 1000 : 0;

export async function tick(cfg: WatchdogConfig, deps: WatchdogDeps): Promise<WatchdogState> {
  const T = cfg.thresholds;
  const now = deps.now();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const state = await loadState(cfg.stateFile);
  const dry = cfg.restartMode !== 'on';
  const quiet = isQuietHours(now);
  const tag = dry ? 'DRY-RUN — would ' : '';

  // Streaks are only meaningful over continuous observation.
  if (state.lastProbeAt && secsSince(state.lastProbeAt, nowMs) > T.maxGapS) {
    deps.log(`last probe was ${Math.round(secsSince(state.lastProbeAt, nowMs))}s ago — restarting every streak`);
    state.serverErrorSince = state.notAuthSince = state.ssoFaultSince = null;
    state.streamWedgedSince = state.upstreamFailingSince = null;
    state.streamStep = 'none';
    state.streamStepAt = null;
  }
  state.lastProbeAt = nowIso;

  const health = await probeHealth(cfg);
  if (state.lastHealthState !== health.state) {
    deps.log(`/health transition: ${state.lastHealthState ?? '<first>'} → ${health.state} (${health.detail})`);
    state.lastHealthState = health.state;
  }
  const dead = health.state === 'server_error' || health.state === 'unreachable';
  state.serverErrorSince = dead ? (state.serverErrorSince ?? nowIso) : null;
  state.notAuthSince = health.state === 'not_authenticated' ? (state.notAuthSince ?? nowIso) : null;

  const holder: Holder | null = currentHolder(cfg.lockDir, nowMs);
  if (holder) deps.log(`session lock held by ${describeHolder(holder, nowMs)} — no session actions this tick`);

  // SSO bridge: only while logged out (authenticated, it is already bridged),
  // and never under the lock — this is a `compete` call, and it would fight
  // the login that holds it.
  let sso: number | null = null;
  if (health.state === 'not_authenticated' && !holder) {
    sso = await post(cfg, SSODH_INIT_PATH, { publish: true, compete: true });
    if (sso !== null && sso >= 500) state.ssoFaultSince ??= nowIso;
    else if (sso !== null) state.ssoFaultSince = null;
  } else if (health.state !== 'not_authenticated') {
    state.ssoFaultSince = null;
  }

  // ---- restart decision ----
  let restart: { kind: 'dead' | 'sso'; reason: string } | null = null;
  const deadFor = secsSince(state.serverErrorSince, nowMs);
  const ssoFor = secsSince(state.ssoFaultSince, nowMs);
  if (state.serverErrorSince && deadFor >= T.deadAfterS) {
    restart = { kind: 'dead', reason: `/health ${health.state} for ${Math.round(deadFor)}s (${health.detail})` };
  } else if (state.ssoFaultSince && ssoFor >= T.ssoWedgedAfterS) {
    if (quiet) {
      deps.log(`SSO bridge wedged ${Math.round(ssoFor)}s, but it is quiet hours — no restart until 07:00 (D5)`);
    } else {
      restart = {
        kind: 'sso',
        reason: `SSO bridge wedged — ${SSODH_INIT_PATH} 5xx for ${Math.round(ssoFor)}s while logged out, so no login could complete`,
      };
    }
  }

  const coolLeftS = T.restartCooldownS - secsSince(dry ? state.lastWouldRestartAt : state.lastRestartAt, nowMs);
  const cooling = (dry ? state.lastWouldRestartAt : state.lastRestartAt) !== null && coolLeftS > 0;

  if (restart && holder) {
    deps.log(`restart wanted (${restart.reason}) but deferred: session lock held by ${holder.owner}`);
  } else if (restart && cooling) {
    deps.log(`restart wanted (${restart.reason}) but cooling down, ${Math.ceil(coolLeftS / 60)}min left`);
  } else if (restart && dry) {
    const clears = restart.kind === 'dead' && !quiet;
    deps.log(`${tag}restart bezant: ${restart.reason}${clears ? ' — and clear relogin\'s park' : ''}`);
    state.lastWouldRestartAt = nowIso;
    deps.feed({
      source: 'watchdog',
      severity: 'info',
      title: `Dry run: would have restarted bezant (${restart.reason})`,
      detail: 'WATCHDOG_RESTART=dry-run — observing only. Set WATCHDOG_RESTART=on to act.',
    });
  } else if (restart) {
    await doRestart(cfg, deps, state, restart, quiet, nowIso);
  }

  // ---- event stream: never a restart ----
  if (health.state === 'authenticated') {
    const stream = await probeStream(cfg, nowMs);
    if (stream?.wedged) {
      state.streamWedgedSince ??= nowIso;
      await remedyStream(cfg, deps, state, stream.detail, holder, nowMs, dry);
    } else if (stream) {
      if (state.streamWedgedSince) {
        deps.log(`event stream is delivering again (${stream.detail})`);
        if (state.streamAlertedAt) {
          deps.feed({ source: 'watchdog', severity: 'recovery', title: 'The order/P&L event stream is delivering again' });
        }
      }
      state.streamWedgedSince = null;
      state.streamStep = 'none';
      state.streamStepAt = null;
      state.streamAlertedAt = null;
    }
    // stream === null: cannot tell — neither advance nor reset.
  } else if (health.state !== 'upstream_failing') {
    // Logged out or down: the feed cannot work by definition and that is
    // relogin's (or the restart's) problem, not the stream's.
    state.streamWedgedSince = null;
    state.streamStep = 'none';
    state.streamStepAt = null;
  }

  // ---- upstream failing: never a restart, alert after a limit ----
  if (health.state === 'upstream_failing') {
    state.upstreamFailingSince ??= nowIso;
    const forS = secsSince(state.upstreamFailingSince, nowMs);
    if (forS >= T.upstreamAlertAfterS && !state.upstreamAlertedAt) {
      state.upstreamAlertedAt = nowIso;
      const mins = Math.round(forS / 60);
      await deps.alert(`IBKR's API (api.ibkr.com) has been failing for ${mins} min. bezant is up; a restart cannot fix this and is not being attempted.`);
      deps.feed({
        source: 'watchdog',
        severity: 'critical',
        title: `IBKR's API has been failing for ${mins} min`,
        detail: 'The gateway is up but api.ibkr.com is not answering properly. Not restarting — it would only log the fund out.',
      });
    }
  } else if (state.upstreamFailingSince) {
    deps.log(`upstream recovered after ${Math.round(secsSince(state.upstreamFailingSince, nowMs))}s`);
    if (state.upstreamAlertedAt) {
      deps.feed({ source: 'watchdog', severity: 'recovery', title: "IBKR's API is answering again" });
    }
    state.upstreamFailingSince = null;
    state.upstreamAlertedAt = null;
  }

  // ---- silent-outage backstop: logged out a long time AND relogin parked ----
  const parked = await exists(cfg.reloginDisabledFile);
  const notAuthFor = secsSince(state.notAuthSince, nowMs);
  if (state.notAuthSince && notAuthFor >= T.notAuthAlertAfterS && parked) {
    if (secsSince(state.lastDownAlertAt, nowMs) >= T.downAlertIntervalS || !state.lastDownAlertAt) {
      deps.feed({
        source: 'watchdog',
        severity: 'critical',
        title: `Logged out ~${Math.round(notAuthFor / 60)}+ min and auto-relogin is parked`,
        detail: 'Start a login from pi.lan/ibkr when you can tap an IB Key push. The nightly pre-market re-key will also unpark and try once.',
      });
      state.lastDownAlertAt = nowIso;
    }
  }

  deps.log(
    `status: health=${health.state} sso=${sso ?? 'n/a'} dead_for=${Math.round(deadFor)}s ` +
      `sso_fault_for=${Math.round(ssoFor)}s stream_wedged_for=${Math.round(secsSince(state.streamWedgedSince, nowMs))}s ` +
      `stream_step=${state.streamStep} relogin_failures=${await reloginFailures(cfg.reloginStateFile)} ` +
      `relogin_parked=${parked} mode=${cfg.restartMode}${quiet ? ' quiet-hours' : ''}`,
  );

  await saveState(cfg.stateFile, state);
  return state;
}

async function doRestart(
  cfg: WatchdogConfig,
  deps: WatchdogDeps,
  state: WatchdogState,
  restart: { kind: 'dead' | 'sso'; reason: string },
  quiet: boolean,
  nowIso: string,
): Promise<void> {
  // Hold the session lock across the restart so relogin, preflight and the
  // hub do not start a login against a gateway that is going away under it.
  const lock = acquire('watchdog-restart', 180, { dir: cfg.lockDir, inheritToken: '' });
  if (!lock.ok) {
    deps.log(`restart wanted (${restart.reason}) but the session lock was just taken by ${lock.holder?.owner ?? '?'}`);
    return;
  }
  try {
    deps.log(`RESTARTING bezant: ${restart.reason}`);
    let ok = await deps.restart();
    if (ok) {
      ok = false;
      for (let i = 0; i < cfg.postRestartProbes; i++) {
        await deps.sleep(cfg.postRestartIntervalMs);
        const h = await probeHealth(cfg);
        if (h.state !== 'unreachable') {
          deps.log(`post-restart /health responsive: ${h.state}`);
          state.lastHealthState = h.state;
          ok = true;
          break;
        }
      }
      if (!ok) deps.log('post-restart /health still unreachable');
    } else {
      deps.log('docker restart FAILED');
    }
    state.lastRestartAt = nowIso;
    state.lastRestartReason = restart.reason;
    state.totalRestarts += 1;
    // Re-measure everything from the new baseline.
    state.serverErrorSince = state.ssoFaultSince = state.notAuthSince = null;
    state.streamWedgedSince = null;
    state.streamStep = 'none';

    if (ok) {
      // The park is cleared ONLY after a dead-gateway restart (the park was
      // most likely caused by the same dead gateway), and never in quiet hours
      // (clearing it hands the 5-min relogin a push to send at 02:00).
      let cleared = false;
      if (restart.kind === 'dead' && !quiet) {
        try {
          await fs.unlink(cfg.reloginDisabledFile);
          cleared = true;
          deps.log('cleared relogin\'s park — the next 5-min relogin tick will retry');
        } catch {
          /* not parked */
        }
      } else if (await exists(cfg.reloginDisabledFile)) {
        deps.log(`relogin's park left in place (${restart.kind === 'dead' ? 'quiet hours' : 'not a dead-gateway restart'})`);
      }
      deps.feed({
        source: 'watchdog',
        severity: 'warn',
        title: `bezant was down (${restart.reason}) — auto-restarted`,
        detail:
          `Restart #${state.totalRestarts}. The gateway usually comes back logged out` +
          (cleared ? '; relogin was unparked and will pick it up.' : '; the 5-minute re-login picks it up unless it is parked.'),
      });
    } else {
      await deps.alert(`🚨 IBKR fund: bezant down (${restart.reason}) and the auto-restart FAILED — manual intervention needed on the Pi.`);
      deps.feed({
        source: 'watchdog',
        severity: 'critical',
        title: `bezant is down (${restart.reason}) and the auto-restart FAILED`,
        detail: 'Self-heal did not work — the container needs a look on the Pi.',
      });
    }
  } finally {
    lock.release();
  }
}

async function remedyStream(
  cfg: WatchdogConfig,
  deps: WatchdogDeps,
  state: WatchdogState,
  detail: string,
  holder: Holder | null,
  nowMs: number,
  dry: boolean,
): Promise<void> {
  const T = cfg.thresholds;
  const nowIso = new Date(nowMs).toISOString();
  const wedgedFor = secsSince(state.streamWedgedSince, nowMs);
  const stepFor = secsSince(state.streamStepAt, nowMs);

  const reauth = async (why: string) => {
    state.streamStep = 'reauth';
    state.streamStepAt = nowIso;
    if (dry) return deps.log(`DRY-RUN — would POST ${REAUTH_PATH} (${why})`);
    if (holder) return deps.log(`reauthenticate skipped: session lock held by ${holder.owner}`);
    const code = await post(cfg, REAUTH_PATH, {});
    deps.log(`POST ${REAUTH_PATH} → ${code ?? 'no answer'} (${why})`);
  };

  if (state.streamStep === 'none' && wedgedFor >= T.streamReconnectAfterS) {
    state.streamStep = 'reconnect';
    state.streamStepAt = nowIso;
    const headers: Record<string, string> = cfg.debugToken ? { 'X-Bezant-Debug-Token': cfg.debugToken } : {};
    const code = await post(cfg, RECONNECT_PATH, {}, headers);
    if (code !== null && code >= 200 && code < 300) {
      deps.log(`event stream silent ${Math.round(wedgedFor)}s (${detail}) — asked bezant to reconnect it (HTTP ${code})`);
    } else {
      // 404: a bezant without the endpoint (or with debug routes off);
      // 401: token missing or wrong. Either way the next rung is all we have.
      deps.log(`POST ${RECONNECT_PATH} → ${code ?? 'no answer'}; going straight to reauthenticate`);
      await reauth('reconnect unavailable');
    }
  } else if (state.streamStep === 'reconnect' && stepFor >= T.streamStepWaitS) {
    await reauth(`stream still silent ${Math.round(stepFor)}s after the reconnect`);
  }

  if (wedgedFor >= T.streamAlertAfterS && !state.streamAlertedAt) {
    state.streamAlertedAt = nowIso;
    const mins = Math.round(wedgedFor / 60);
    await deps.alert(
      `The order/P&L event stream has been silent for ${mins} min (${detail}) and reconnect/reauthenticate did not bring it back. ` +
        'Not restarting (a restart logs the fund out). Fills are confirmed from /trades meanwhile.',
    );
    deps.feed({
      source: 'watchdog',
      severity: 'critical',
      title: `Event stream silent for ${mins} min — not recovered`,
      detail: `${detail}. Reconnect and reauthenticate were tried; a restart is deliberately not attempted.`,
    });
  }
}
