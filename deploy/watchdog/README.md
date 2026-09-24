# ibkr-fund-watchdog

Pi-side liveness watchdog for the `bezant` Docker container. Lives in the
`ibkr-fund` repo because that's the consumer that needs the container
healthy; the watchdog operates on bezant from the outside.

## What it does

Runs once a minute. Probes `/health`, `/events/_status` and (while logged out)
the SSO bridge. The decisions live in `watchdog.ts`; `index.ts` wires them up.

| Condition | After (elapsed) | Action | Quiet hours 23:00–07:00 |
|---|---|---|---|
| `/health` 5xx or unreachable — the gateway is dead | 300 s | restart; clear relogin's park | restart yes, park **not** cleared |
| logged out and `ssodh/init` 5xx — SSO bridge wedged | 300 s | restart (park untouched) | no restart |
| `/health` carries `upstream_failing: true` — bezant up, api.ibkr.com failing | 900 s | **never restart**; alert once | same |
| authenticated but the event stream is silent/disconnected | 600 s | `POST /events/_reconnect` (debug token; 404 = older bezant, skip) | same |
| ...still silent | +300 s | `POST /iserver/reauthenticate` | same |
| ...still silent | 1800 s total | alert once; **never restart** | same |
| logged out 30 min with relogin parked | 1800 s | ops-feed entry, ≤ every 6 h | same |

Thresholds are elapsed seconds since the condition was first seen. A gap of
more than 180 s between probes (Pi off, timer stopped) resets every streak.
2-hour cooldown between restarts.

Nothing that touches the session — restart, reauthenticate, the SSO probe —
happens while another program holds the **session lock**
(`~/.local/state/ibkr-session/holder.json`, see `../lib/session-lock.ts`), and
the watchdog takes that lock for its own restart.

## `WATCHDOG_RESTART`

`dry-run` (the default for now) logs `DRY-RUN — would ...` for every restart,
park clear and reauthenticate, and does none of them; the stream reconnect and
the alerts still happen. `on` acts. Watch a few days of

```bash
journalctl --user -u ibkr-fund-watchdog | grep DRY-RUN
```

before switching.

## Tests

`watchdog.test.ts` (run by the repo's `pnpm test`) drives `tick()` against
`test/fake-bezant.mjs` with a fake clock; the restart is a recorded callback.

## Pi setup

```bash
ssh your-pi
cd ~/sovereign-ibkr-fund && git pull
cd ~/sovereign-ibkr-fund/deploy/watchdog && npm install

# Alerting — optional but recommended. Without it the watchdog restarts the
# container silently and you never hear it happened.
cp .env.example .env && chmod 600 .env   # then set IBKR_FUND_ALERT_WEBHOOK

mkdir -p ~/.config/systemd/user
cp systemd/ibkr-fund-watchdog.service ~/.config/systemd/user/
cp systemd/ibkr-fund-watchdog.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ibkr-fund-watchdog.timer
```

(linger should already be enabled from ibkr-fund-relogin setup; if not:
`sudo loginctl enable-linger pi`)

## Tail logs

```bash
journalctl --user -u ibkr-fund-watchdog -f
```

One status line per minute (`status: health=... dead_for=...s ... mode=dry-run`),
plus a line for each transition and action (`RESTARTING bezant: ...`,
`DRY-RUN — would restart bezant: ...`, `session lock held by ...`).

## State

`~/.local/state/bezant-watchdog/state.json`: the `...Since` timestamp of each
open condition, the stream ladder's step, and restart history. Old
counter-based files load fine; the counters are dropped.

## Tuning

Env (or `.env` here, see `.env.example`): `WATCHDOG_RESTART`,
`BEZANT_DEBUG_TOKEN`, `IBKR_FUND_ALERT_WEBHOOK`, `BEZANT_HEALTH_URL`,
`BEZANT_CONTAINER`, `BEZANT_RESTART_CMD`, `IBKR_SESSION_LOCK_DIR`,
`QUIET_HOURS_TZ`, `QUIET_HOURS`, `BEZANT_RELOGIN_DISABLED_FILE`,
`BEZANT_RELOGIN_STATE_FILE`, `BEZANT_WATCHDOG_STATE_DIR`. Thresholds are
`DEFAULT_THRESHOLDS` in `watchdog.ts`.

## Manual override

Force an immediate restart attempt (ignores cooldown — you'll need to
delete the state file or wait):

```bash
ssh your-pi 'docker restart bezant'
```

Force the watchdog to run a probe right now (instead of waiting for
the next 60s tick):

```bash
ssh your-pi 'systemctl --user start ibkr-fund-watchdog.service'
```
