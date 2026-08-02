# Pi-side deployment

Five systemd **user** units and the push-based deploy script. Everything here is
a template — the `.service` files contain placeholders you must substitute for
your own host.

| Unit | What it does | Cadence |
|---|---|---|
| `ibkr-fund-watchdog` | probes the bezant gateway, restarts it if unhealthy | ~1 min |
| `ibkr-fund-relogin` | re-authenticates the IBKR session (Playwright) | ~5 min |
| `ibkr-fund-digest` | daily summary to Slack | Mon–Fri |
| `ibkr-fund-backup` | uploads the SQLite ledger to Slack | daily |
| `ibkr-fund-agent-health` | alerts on failing **or silent** agents | hourly |
| `ibkr-fund-db-retention` | redacts old run blobs in paperclip's DB | weekly |

## Substitute the placeholders

The container-side units run `docker exec` against a paperclip workspace whose
path contains your company and project IDs:

```bash
COMPANY_ID=...        # from paperclip
PROJECT_ID=...
for f in deploy/*/ibkr-fund-*.service; do
  sed -i "s#COMPANY_ID/PROJECT_ID#$COMPANY_ID/$PROJECT_ID#" "$f"
done
cp deploy/*/ibkr-fund-*.{service,timer} ~/.config/systemd/user/
cp deploy/*/systemd/ibkr-fund-*.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
```

Each unit reads its own `.env` (see the `.env.example` beside it). All are
`0600` and gitignored.

## STATE_DIR is not optional

`backup-to-slack.mjs` and `daily-summary.js` both do `process.env.STATE_DIR || '.'`
and **do not load dotenv**. With `STATE_DIR` unset they silently operate on the
process working directory. In this project's own deployment that meant a month
of "successful" ledger backups that were copies of a stale fork, and daily
digests reporting figures three weeks out of date — all while exiting 0.

Keep `-e STATE_DIR=…` explicit in the units, and point it somewhere **outside**
any checkout or deploy target. Long-lived data should not live inside a
directory that a deploy, or an orchestrator re-materialising a workspace, can
delete or overwrite.

## Deploying

The fund host is not expected to build this repo. `bezant-client` is a
git-hosted dependency whose `prepare` step needs a toolchain that may not exist
there, so a package manager cannot necessarily supply `typescript`. Build on a
workstation and push:

```bash
FUND_DEPLOY_HOST=my-pi \
FUND_DEPLOY_REMOTE=/var/lib/paperclip/instances/default/projects/$COMPANY_ID/$PROJECT_ID/sovereign-ibkr-fund \
  scripts/deploy-to-pi.sh
```

It builds with `tsc`, aborts if `package.json` / `pnpm-lock.yaml` /
`tsconfig.json` differ from the remote (a host that cannot install cannot
reconcile a dependency change), waits for in-flight agent runs, rsyncs
`src/ dist/ scripts/`, and writes `dist/.build-stamp`.

On the host, `scripts/run-agent.sh` sees a `.prebuilt` marker, skips `git pull`,
never builds, and recomputes the source fingerprint. On a mismatch it **refuses
to run** rather than execute stale code against a real account — so a `git pull`
without a redeploy fails loudly instead of trading.

> `src/portfolios/local.ts` (a private portfolio override) is gitignored and
> excluded from `rsync --delete`. Without that exclusion, deploying from a fresh
> clone would delete it on the host, and the loader falls back to
> `SAMPLE_PORTFOLIO` **silently** — i.e. rebalancing a live account toward a
> sample allocation.

## Monitoring

Agent failures are recorded in paperclip's Postgres (`heartbeat_runs`), **not**
in `docker logs`. A clean container log does not mean the fund is working; in
this project it hid months of every-run failures. `ibkr-fund-agent-health`
queries that table and alerts on two independent conditions — agents *failing*,
and agents *silent* (a dead scheduler produces zero failures, so a failure-only
check stays quiet through the worst outage).

Note that on some hosts `journalctl --user -u <unit>` returns nothing even
though the unit ran; user units may log to the system journal. Use
`journalctl _SYSTEMD_USER_UNIT=<unit>` instead.
