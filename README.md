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
| Research Scout | Price monitoring, alerts | daily |
| Observer | WS fill/event stream ingestion | — |

Includes a backtest engine (HRP, risk-parity, Black-Litterman, Ledoit-Wolf covariance, regime overlay, vol targeting) validated against historical data you fetch yourself.

## Requirements

- Node 20+
- A running [bezant](https://github.com/isaacrowntree/bezant) gateway (default `http://localhost:8080`)
- An Interactive Brokers account (**start on paper**)

## Quickstart

```sh
git clone https://github.com/isaacrowntree/sovereign-ibkr-fund.git
cd sovereign-ibkr-fund
npm install
cp .env.example .env        # point BEZANT_URL at your bezant; TRADING_MODE=paper
npm run build
npm start                    # status server + built-in scheduler, against the sample portfolio
```

Out of the box it runs the **sample** model portfolio (a generic diversified ETF template) against **paper** trading. Nothing trades live until you set `TRADING_MODE=live` and provide your own portfolio.

## Run modes

The agents are just `node dist/agents/<name>.js --once`. Anything can schedule them:

- **Built-in scheduler** (default): `npm start` runs every agent on its cadence. Tune per agent with `SCHED_*_SEC` env vars.
- **cron / systemd**: point timers at the `--once` scripts. Examples in [`deploy/`](deploy/).
- **paperclip** (or any orchestrator): set `ENABLE_SCHEDULER=false` and have it invoke the `--once` scripts; it becomes the scheduler. `deploy/` has a reference adapter.

## Your own portfolio

The public repo ships [`src/portfolios/sample.ts`](src/portfolios/sample.ts). To run your own, copy the template to a **gitignored** override — it takes precedence automatically:

```sh
cp src/portfolios/local.example.ts src/portfolios/local.ts   # edit; weights sum to 100
npm run build
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
npm run fetch-data     # writes src/validation/data/historical-daily.json
npm test               # backtest suites skip automatically until the data exists
```

## License

Dual-licensed under **Apache-2.0 OR MIT**.
