# ibkr-fund-watchdog

Pi-side liveness watchdog for the `bezant` Docker container. Lives in the
`ibkr-fund` repo because that's the consumer that needs the container
healthy; the watchdog operates on bezant from the outside.

## What it does

Runs once a minute. Probes `http://localhost:8080/health`. If the
container is in a state that's empirically required a manual `docker
restart bezant` to recover (server alive but health stuck), the
watchdog does it automatically.

## Restart triggers

| Trigger | Threshold | Why |
|---|---|---|
| `/health` returns 5xx or unreachable | 5 consecutive probes (~5 min) | Server crashed but container PID still alive, or networking stack wedged |

## What does NOT trigger a restart

- `/health` returns 401 not_authenticated — that's the normal state
  immediately after session expiry; the relogin timer handles it
- A single 5xx — could be transient
- `bezant-relogin/disabled` sentinel exists — that's the user's "I'm
  not around to tap a phone push right now" signal. Restarting bezant
  and clearing the sentinel just spams the phone with IB Key pushes
  while you're away. Manual reset is the right recovery path here.

## Recovery vs. relogin disabled

If the watchdog DOES fire (5xx restart) and `bezant-relogin/disabled`
happens to be present at the same time, the watchdog clears it after
the restart succeeds. Working assumption: the disabled state was
caused by the same wedged condition the restart just fixed, so let
relogin retry against the freshly-restarted container.

If `/health` is returning a clean 401 (server fine, just no auth), the
watchdog leaves the disabled sentinel alone — bezant isn't broken,
the user is just away.

## Cooldown

**2 hours** minimum between restarts. Belt-and-braces against
persistent issues that restart can't fix.

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

You'll see one line per minute like:

```
[2026-05-05T00:55:01.234Z] [watchdog] status: health=authenticated relogin_failures=0 (healthy)
```

When something fires:

```
[2026-05-05T05:30:01.000Z] [watchdog] /health transition: authenticated → not_authenticated
[2026-05-05T05:35:01.000Z] [watchdog] RESTARTING bezant: 5 consecutive server_error/unreachable probes
[2026-05-05T05:35:08.000Z] [watchdog] docker restart returned successfully — waiting for /health to respond
[2026-05-05T05:35:13.000Z] [watchdog] Post-restart /health responsive: not_authenticated
[2026-05-05T05:35:13.000Z] [watchdog] Cleared bezant-relogin disabled sentinel — next 5-min relogin tick will retry
```

## State

Persisted at `~/.local/state/bezant-watchdog/state.json`:

```json
{
  "lastHealthState": "authenticated",
  "consecutiveServerErrors": 0,
  "lastRestartAt": null,
  "lastRestartReason": null,
  "totalRestarts": 0
}
```

## Tuning

All thresholds are env-overridable. Defaults (top of `index.ts`):

- `IBKR_FUND_ALERT_WEBHOOK` — **recommended**, no default. Without it the
  watchdog restarts the container silently and you never hear that it happened.
  Set the SAME webhook as the fund and `pi/relogin` — one channel. Read from
  `.env` in this directory (optional file; the unit tolerates its absence).
- `BEZANT_HEALTH_URL` — default `http://localhost:8080/health`
- `BEZANT_CONTAINER` — default `bezant`
- `BEZANT_RELOGIN_DISABLED_FILE` — default `~/.local/state/bezant-relogin/disabled`
- `BEZANT_RELOGIN_STATE_FILE` — default `~/.local/state/bezant-relogin/state.json`
- `BEZANT_WATCHDOG_STATE_DIR` — default `~/.local/state/bezant-watchdog`

The thresholds (server-error count, restart cooldown) live as `const`s
in `index.ts` — change there if you need different behavior.

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
