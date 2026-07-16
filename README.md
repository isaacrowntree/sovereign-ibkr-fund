# Sovereign

**An autonomous, multi-agent portfolio fund for Interactive Brokers.** A companion to [bezant](https://github.com/isaacrowntree/bezant).

> *bezant mints the access; sovereign spends it.*

bezant is the IBKR Client Portal gateway (a Rust HTTP service). **Sovereign** is the fund on top of it: a set of deterministic TypeScript agents that hold a model portfolio, detect drift, size trades with proper risk controls, and execute through bezant — standalone or under any scheduler.

```
┌──────────────┐   HTTP    ┌─────────────────────┐
│  bezant       │◀─────────▶│  sovereign          │
│  (Rust)       │  :8080    │  (this repo, TS)     │
│  IBKR CPAPI   │           │  agents · risk · tax │
│  gateway      │           │  execution · backtest│
└──────┬───────┘           └──────────┬──────────┘
       │ IBKR Client Portal            │  scheduler / cron / systemd / paperclip
       ▼                               ▼
   Interactive Brokers            runs the --once agents on a cadence
```

## What it does

Nine single-purpose agents, each a plain `--once` process (no LLM calls — deterministic TypeScript):

| Agent | Role | Default cadence |
|---|---|---|
| Managing Partner | Orchestrates the fund, snapshots NAV/positions | 4h |
| Portfolio Strategist | HRP / Black-Litterman weights, drift detection, sizes rebalance orders | 4h |
| Quant Analyst | Regime detection, factor regression | 4h |
| Risk Manager | VaR/CVaR, drawdown control, vol targeting | 4h |
| Execution Bot | Executes queued orders through bezant (window-gated, capped) | 4h |
| Tax Optimizer | FIFO lots, tax-loss harvesting, wash-sale tracking | daily |
| Hedger | Options overlay (covered calls / protective puts) | daily |
| Research Scout | Price monitoring, significant-move detection | daily |
| Observer | WS fill/event stream ingestion, stream-health alerts | 5m |
| Daily Summary | Post-close digest to Slack (NAV, fills, drift, movers, advisories) | daily (21:30 UTC) |

Includes a backtest engine (HRP, risk-parity, Black-Litterman, Ledoit-Wolf covariance, regime overlay, vol targeting) validated against historical data you fetch yourself.

## Requirements

- Node 22.13+ (state is SQLite via the built-in `node:sqlite`, which doesn't exist before 22.5 and is unflagged from 22.13)
- [pnpm](https://pnpm.io) 9+ (`corepack enable pnpm`) — `pnpm-lock.yaml` is the committed lockfile
- A running [bezant](https://github.com/isaacrowntree/bezant) gateway (default `http://localhost:8080`)
- An Interactive Brokers account (**start on paper**)

## Quickstart

```sh
git clone https://github.com/isaacrowntree/sovereign-ibkr-fund.git
cd sovereign-ibkr-fund
pnpm install                 # npm < 11.13 cannot parse the `#path:` dep fragment
cp .env.example .env        # point BEZANT_URL at your bezant; TRADING_MODE=paper
pnpm run build
pnpm start                   # status server + built-in scheduler, against the sample portfolio
```

Out of the box it runs the **sample** model portfolio (a generic diversified ETF template) against **paper** trading. Nothing trades live until you set `TRADING_MODE=live` and provide your own portfolio.

## Run modes

The agents are just `node dist/agents/<name>.js --once`. Anything can schedule them:

- **Built-in scheduler** (default): `pnpm start` runs every agent on its cadence. Tune per agent with `SCHED_*_SEC` env vars.
- **cron / systemd**: point timers at the `--once` scripts. Examples in [`deploy/`](deploy/).
- **paperclip** (or any orchestrator): set `ENABLE_SCHEDULER=false` and have it invoke the `--once` scripts; it becomes the scheduler. `deploy/` has a reference adapter.

## Alerting

One Slack incoming webhook, one channel (`IBKR_FUND_ALERT_WEBHOOK`). Severity is carried by colour and emoji rather than by routing, so a hard stop is distinguishable from a fill while scrolling.

**Real-time** — reserved for things needing a human:

| | |
|---|---|
| 🚨 critical | Hard stop; execution blocked on a drawdown stop; **ledger diverged from IBKR after a real fill** |
| ⚠️ warn | Drawdown warning (7%) and de-risking (15%); run halted early; validation trade failed; fill recovered after the stream misreported it; suspect NAV/prices; NAV-history reset; event stream disconnected |
| ✅ recovery | Drawdown back to normal — the gate lifting, which self-clears |
| ℹ️ info | One coalesced summary per execution run |

**Daily digest** (`deploy/digest/`, 21:30 UTC — after the US close in both EST and EDT) carries everything advisory: NAV, cash, drawdown, VaR, the day's fills with realised P&L, worst drift, movers, harvest candidates, hedge suggestions.

Alerts are deduped in SQLite (`notify_dedupe`), so a stuck condition re-nags on a schedule rather than repeating every run, and transitions (warning → de-risking → stopped → normal) each alert once. Delivery failures release the claim so the alert retries rather than being lost.

The daily backup (`deploy/backup/`) reports whether the digest was sent. It authenticates with a **different** credential (a bot token), so it still lands if the webhook is revoked — a backup saying "NO DIGEST" means the alert path is dead.

## Your own portfolio

The public repo ships [`src/portfolios/sample.ts`](src/portfolios/sample.ts). To run your own, copy the template to a **gitignored** override — it takes precedence automatically:

```sh
cp src/portfolios/local.example.ts src/portfolios/local.ts   # edit; weights sum to 100
pnpm run build
```

`local.ts` is gitignored and never published. All other tuning is env-driven — see [`.env.example`](.env.example).

## Safety

Real money. Sovereign is defense-in-depth by design:

- **Validation-first execution** — the executor proves a live fill on the smallest order before batching.
- **Absolute caps** — `MAX_ORDER_NOTIONAL_USD`, `MAX_ORDER_PCT_NAV`, `MAX_RUN_NOTIONAL_USD`.
- **Data-sanity gates** — refuses to size against a garbled NAV or price tick.
- **Drawdown control** — de-risks / hard-stops on drawdown thresholds.
- **Idempotent ledger & executions reconcile** — fills are recorded once; IBKR executions are authoritative.
- **Keep state outside the checkout** — set `STATE_DIR` so positions/ledger never entangle with code.

None of this is a guarantee. **This is not financial advice. Trade at your own risk; start on paper.**

## Backtesting

The dataset (Yahoo Finance daily bars) is gitignored — generate it, then the backtest suites run:

```sh
pnpm run fetch-data    # writes src/validation/data/historical-daily.json
pnpm test              # backtest suites skip automatically until the data exists
```

## License

Dual-licensed under **Apache-2.0 OR MIT**.
