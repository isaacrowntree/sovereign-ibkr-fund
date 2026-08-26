# Backtesting: how to get an answer you can act on

Methodology notes. No portfolio figures live here — a private book belongs in a
private repo, and `src/portfolios/local.ts` is gitignored for the same reason.

Results measured against the real book live in `docs/private/`, which is
gitignored. If that directory is empty in your checkout, that is expected: it is
never published, and a fresh clone will not have it.

## Compare after tax, not before

`src/validation/after-tax.ts`. Every comparison here used to report pre-tax
return with a flat commission, which omits the dominant cost of the
highest-turnover strategy — on a taxable account that is not a rounding error,
it reverses rankings.

It reuses `generateTaxSummary`, the same path that produces the live CGT report,
rather than reimplementing. AU CGT is not a flat percentage: losses offset gains
proportionally and only the surviving long-term portion gets the 50% discount, so
a second implementation would drift from the real one.

Report **two** figures. Taxing only realised gains rewards a low-turnover
strategy for merely deferring a bill it still owes; also liquidating the whole
book on the final day removes that advantage. If the ranking flips between them,
the result is an artefact of the deferral assumption and you have not learned
anything yet.

The mechanism to watch is not "number of trades" but **when** gains are realised.
A 45-day rebalance cadence forces disposals inside 12 months, so they miss the
discount entirely; a 60-day cadence with a wider drift band can keep essentially
every disposal past the line.

## Do not judge a config on the window that selected it

A sweep picks the winner *of that sample*. Judging it there measures the sweep,
not the strategy. Split the data, or extend it and test on the part the sweep
never saw.

Check what the sample can actually test. If the regime census is
`risk_on 59, neutral 24, risk_off 1, crisis 0`, then any config that wins by
disabling a downside protection won for free — the sample contained no downside.
That is exactly how one config here scored well with `enableRegimeOverlay: false`
and lost to itself once the overlay was switched back on.

`FETCH_START` / `FETCH_OUT` on `pnpm fetch-data` and `BACKTEST_DATA_FILE` on the
loader let you build and study an alternate window without disturbing the default
dataset the suites assert against. Note the universe constrains the window: the
default sample is short only because one holding IPO'd recently, and dropping it
reaches back several more years.

## Model what you actually run

`optimizerMethod: 'static'` targets the model portfolio's own weights and runs no
optimizer, so the live allocation is expressible. Before it existed, every
comparison approximated it as buy-and-hold (never rebalances) or equal-weight
(wrong weights) — meaning the configuration in production was the one
configuration never measured.

In production it is also the honest way to disable the optimizer, instead of
setting `HRP_MIN_DAYS` absurdly high to jam the gate shut.

## Two traps this harness has already hit

**Silent no-ops.** `static` originally returned an empty covariance matrix, and
the engine does `if (covMatrix.length === 0) continue` — so every day was skipped
and every static run produced a no-trade buy-and-hold. Identical numbers, no
error, a plausible-looking table. If a config reports zero trades over years,
that is a bug until proven otherwise.

**Unrecoverable states.** The drawdown hard stop used to liquidate the whole book
and `continue`, while `peakValue` never reset — so NAV parked in cash kept the
drawdown above the threshold permanently and the strategy never re-entered. One
config read as a near-total failure over the full period; with the harness fixed
it read as one of the stronger performers. The entire difference was the artefact,
and it looked exactly like a real result. (Figures omitted — this repo is public
and those are the real book's numbers; see docs/private/.)

Production does not behave that way: at `stopped` the strategist declines to
generate orders and holds what it has. When the harness and production disagree,
the harness is wrong by definition.
