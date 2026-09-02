# ibkr-fund-relogin

Pi-side IBKR Client Portal Gateway re-login service. Lives in the
`ibkr-fund` repo because that's the consumer that needs the Gateway alive;
talks to bezant-server (which exposes CPGateway) over loopback on the Pi.

## What it does

The IBKR Client Portal Gateway minted by `docker compose up` requires
interactive 2FA login, and the session ages out roughly every 24 hours.
This script automates the boring parts of re-login:

- Polls `bezant-server`'s `/health` endpoint every 5 min via systemd timer
- When `authenticated=false`, drives a headless Playwright browser at
  `https://localhost:5000` to fill username + password
- Triggers an IB Key push to your phone — you tap "Approve"
- Polls `/health` for up to 2 min until it flips to `authenticated=true`
- **One push per session-expiry event.** If the push isn't tapped within
  2 minutes, writes a `disabled` sentinel and stops auto-firing. Manual
  reset (one SSH command) triggers a fresh attempt at a time of your
  choosing.

Why one push instead of three: empirically, when you're away (asleep,
gym, meeting) running multiple attempts inside the 5-min timer window
just spams the phone with IB Key pushes you can't respond to. One push
preserves the natural escape valve while you're around, and goes silent
when you're not.

It does **not** automate the IB Key approval — by design. That stays a
human-in-the-loop step so the Pi can't be silently logged in if the
credentials leak.

## When IBKR asks for a challenge code instead

Approving the IB Key push does not always finish the login. Sometimes IBKR
follows it with a **challenge/response** screen:

```
Enter the challenge code below into the IBKR Mobile app to generate a response code.
Challenge: 111 222    [ Enter Response Code ]    [Login]
```

There is no push left to tap. The login can only be completed by a human reading
the challenge into IBKR Mobile (Avatar → Two-Factor Authentication) and typing
the response code back. `index.ts` now recognises this screen, classifies the
run `challenge` rather than `push_timeout`, and alerts with instructions — the
generic "clear the sentinel and tap a push" advice cannot fix it.

To complete one, run the operator-assisted login:

```bash
ssh your-pi 'cd ~/sovereign-ibkr-fund/deploy/relogin && setsid nohup npx tsx assisted-login.ts > /tmp/assisted.log 2>&1 &'
```

It holds the browser open (20 min) and posts the challenge digits to the alert
webhook. Answer it from **the phone that generates the code**:

### http://pi.lan:8777

While the login is waiting, the run serves a one-page form on the LAN. Open it
on your phone, read the challenge off it, generate the response in IBKR Mobile,
type it in, submit. No SSH, no reading digits off someone else's screen — which
is the step that burned two valid single-use codes on 2026-09-02.

The listener exists only for the life of the login: it starts with the run, dies
with it, and there is nothing listening between logins. It shows one challenge
and accepts one response code — never credentials.

The terminal route still works and writes to the same file:

```bash
ssh your-pi 'echo <RESPONSE-CODE> > /tmp/bezant-assisted/response.txt'
```

Port and hostname are `ASSISTED_WEB_PORT` (8777) and `ASSISTED_WEB_HOST`
(`pi.lan`, used only to build the URL printed in logs and alerts).

It submits **once** — the code is single-use, and a second submission is
rejected whatever the first did. On success it clears the `disabled` sentinel
and resets `state.json`, so the timers see an honest last-success time.

### Testing it without touching production

```bash
node test/run-assisted-tests.mjs     # 20 cases, ~2 min
```

`test/fake-ibkr.mjs` is a fake gateway reproducing the parts that actually
broke: the challenge form inside a (optionally cross-origin) iframe, a
single-use response code, and the optional challenge. Every earlier iteration of
this script was debugged against the live fund, at a cost of one IB Key push,
one operator interruption and one burned response code per attempt — and three
broken versions still shipped. If Playwright's browsers are not installed,
point `ASSISTED_BROWSER_PATH` at any Chromium build on the machine.

### Do not use `page.evaluate` with a function here

`tsx` compiles with esbuild's `keepNames`, which rewrites named functions —
including arrows inside an `evaluate()` callback — into `__name(fn, "fn")`.
`__name` does not exist in the browser, so **every such call throws
`ReferenceError: __name is not defined`** the moment it runs. Caught and
defaulted to `''`, that makes a perfectly normal page look empty.

This one mistake produced three "fixes" for imaginary problems: a main-frame CSS
selector, a frame-by-frame `innerText` scan, and a shadow-piercing DOM walk —
each shipped to the Pi, each failing while the screenshots showed the form
plainly. `assisted-login.ts` therefore evaluates **source strings**, which the
compiler cannot rewrite. Playwright's own locator API is unaffected and is fine
to use.

## Architecture

```
systemd timer (5 min) ──▶ ibkr-fund-relogin.service ──▶ npx tsx index.ts
                                                            │
                                                            ▼
                                            GET http://localhost:8080/health
                                                            │
                                              authenticated=false?
                                                            │
                                                            ▼
                              Playwright (headless Chromium) → https://localhost:5000
                                                            │
                                                            ▼
                                           IB Key push → your phone → tap Approve
                                                            │
                                                            ▼
                                           poll /health until authenticated=true
```

## Pi setup

These commands assume you're running as `pi` on the Pi (`your-pi`).

### 1. Get the code onto the Pi

```bash
ssh your-pi
cd ~ && git clone https://github.com/isaacrowntree/sovereign-ibkr-fund.git
```

### 2. Install runtime dependencies

```bash
ssh your-pi
cd ~/sovereign-ibkr-fund/deploy/relogin
npm install
npm run install-browsers   # downloads Chromium (~150 MB)
```

If `playwright install` complains about missing system libs, run
`sudo npx playwright install-deps chromium` once.

### 3. Configure credentials

```bash
ssh your-pi
cd ~/sovereign-ibkr-fund/deploy/relogin
cp .env.example .env
chmod 600 .env
$EDITOR .env   # fill IBKR_USERNAME and IBKR_PASSWORD
```

If you remapped the host port for CPGateway (macOS AirPlay collision),
also override `BEZANT_LOGIN_URL` here.

### 4. Install + enable the systemd user units

```bash
ssh your-pi
mkdir -p ~/.config/systemd/user
cp ~/sovereign-ibkr-fund/deploy/relogin/systemd/ibkr-fund-relogin.service ~/.config/systemd/user/
cp ~/sovereign-ibkr-fund/deploy/relogin/systemd/ibkr-fund-relogin.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ibkr-fund-relogin.timer
```

### 5. Allow the user units to keep running when you're not logged in

User units stop when your SSH session ends unless lingering is enabled:

```bash
sudo loginctl enable-linger pi
```

### 6. Verify

```bash
# show timer schedule
systemctl --user list-timers ibkr-fund-relogin.timer

# tail the live log
journalctl --user -u ibkr-fund-relogin -f

# fire one attempt manually
systemctl --user start ibkr-fund-relogin.service
```

## Manual re-trigger / reset after auto-disable

If the script self-disables (1 consecutive timeout), reset it from your
laptop with:

```bash
ssh your-pi 'rm -f ~/.local/state/bezant-relogin/disabled && systemctl --user start ibkr-fund-relogin.service'
ssh your-pi 'sleep 6 && journalctl --user -u ibkr-fund-relogin -n 30 --no-pager'
```

## State

Persisted at `~/.local/state/bezant-relogin/` (path retained from when
this lived in the bezant repo, so existing state survives the move):

- `state.json` — `{ consecutiveFailures, lastAttemptAt, lastSuccessAt }`
- `disabled` — sentinel file. If present, the script exits silently.
  Created automatically after 1 consecutive failure, removed on manual
  reset or after a successful login.

## Selectors

The Playwright login uses these CSS selectors against the CPGateway
login page:

- `#user_name, input[name="username"]`
- `#password, input[name="password"]`
- `#submitForm, button[type="submit"], input[type="submit"]`

If IBKR redesigns the login form, update them in `index.ts`. Verify
against the live page source at `https://localhost:5000`.

## Why not full automation (TOTP)?

Putting the second factor on the same machine as the credentials defeats
the purpose of having a second factor at all. With IB Key push, the Pi
holds username + password but cannot complete a login without a
human-held device tapping "Approve". The credentials leaking from the Pi
isn't sufficient to log in.

If you want zero-touch logins later, the path is: switch IBKR to TOTP,
add `otplib` to this script, generate codes locally, fill the third
input. The cost is the security trade-off above.
