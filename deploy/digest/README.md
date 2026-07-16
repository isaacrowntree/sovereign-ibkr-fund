# Daily summary timer

Posts the post-close digest to Slack once per US trading day: NAV, cash,
drawdown, VaR, the day's fills with realised P&L, worst drift, movers, tax-loss
harvest candidates and hedge suggestions.

Reads `bot-state.db` only — no IBKR connection, no recomputation — so it works
even when the gateway is down, and it can't perturb trading.

## Why UTC, and why not 22:00 like the backup

`OnCalendar` follows the **system** clock. The Pi runs AEST, where 22:00 local
is ~08:00 ET — *pre*-market. A local-time digest would summarise the *previous*
session. (`deploy/backup/ibkr-fund-backup.timer` has the same issue; it matters
less for a backup than for a summary.)

The US close (16:00 ET) is 20:00 UTC on EDT and 21:00 UTC on EST, so **21:30
UTC** is after the close in both halves of the year, regardless of either
country's DST or the Pi's own timezone.

Don't translate this to a fixed local time: AEST/AEDT and EST/EDT shift on
different dates, so no single local time is correct year-round.

> **Requires systemd ≥ 252** for the timezone suffix. Raspberry Pi OS bookworm
> ships 252; bullseye ships 247 and will reject the unit. Check with:
> ```sh
> systemd-analyze calendar 'Mon..Fri 21:30 UTC'
> ```
> If the Pi is older: set the host clock to UTC and drop the ` UTC` suffix.

## Install

```sh
mkdir -p ~/ibkr-fund/pi/digest
cp .env.example ~/ibkr-fund/pi/digest/.env   # then edit: same webhook as the fund
cp ibkr-fund-digest.service ibkr-fund-digest.timer ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now ibkr-fund-digest.timer
```

Check it:

```sh
systemctl --user list-timers ibkr-fund-digest.timer   # next fire time
systemctl --user start ibkr-fund-digest.service       # run once, now
journalctl --user -u ibkr-fund-digest -f
```

## Notes

- **`ExecStart` hardcodes the paperclip project path**, mirroring
  `deploy/backup/`. It must match the fund's working directory — that's what
  makes both read the same `bot-state.db`. If you move the project, update both
  units.
- **Safe to run twice.** The digest claims `digest:<trading-date>` with no
  expiry, so a second run the same day is a no-op rather than a duplicate post.
  That's also why `Persistent=true` is safe: a missed run fires on next boot and
  either posts the day's summary or does nothing.
- **The backup reports whether this ran.** `deploy/backup/` authenticates with a
  bot token, not the webhook, so it still lands if the webhook is revoked — a
  backup saying `⚠️ NO DIGEST` means the alert path is dead. That's the only
  liveness check on the webhook, since the fund, watchdog and relogin all share
  it and would go dark together.
