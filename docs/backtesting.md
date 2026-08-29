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

## The 2026-08-29 truthfulness audit

Four flaws were confirmed by proof tests before being fixed (the pre-fix
proofs live in the git history of `src/validation/flaw-proofs.test.ts`; the
file now holds the inverted regression locks L1–L5):

1. **Silent window fallback.** A `startDate`/`endDate` the dataset couldn't
   serve was silently ignored and the full period ran instead. The "2022 Bear
   Market" scenario had actually been testing 2024→2026 for its whole life.
   The engine now throws; the 2022/2023 scenarios point `config.dataFile` at
   `historical-long.json`.
2. **Regime parity.** The backtest computed regimes from `lookbackDays` (180)
   samples, where production's quant-analyst requires ≥200 and publishes null
   below that — and null means NO multiplier (fails open at 1.0), not
   "extrapolate from a short window". `trendSignal` also silently shrank its
   200-day MA to fit the short window. The engine now feeds the regime
   overlay its own `regimeLookbackDays` (200) window, and DEFAULT_CONFIG
   mirrors the production gate. Measured on the default window: 84 regime
   actions production would never have taken.
3. **Frictionless fills.** Production measures per-fill implementation
   shortfall (`execution/shortfall.ts`); the backtest paid $1 commission but
   zero spread. Fills now pay `slippagePctPerSide` (default 5 bps) in the
   adverse direction.
4. **Dividend blindness.** Returns used raw closes, so distributions
   vanished. TLT over the bundled window: −6.1% price-only vs +5.9%
   total-return — a sign flip on the primary hedge candidate, which had been
   poisoning every hedge-composition comparison. Prices are now
   dividend-adjusted (`useTotalReturn`) throughout, including the OHLC bars
   fed to ADX.

One flaw can only be measured, not fixed: **survivorship**. The 7-name core
universe is today's holdings — names selected partly because they performed.
Lock L5 quantifies the inflation against a no-hindsight benchmark on the
identical window (three-digit percentage points). Treat every absolute return
from this universe as inflated; only comparisons *within* the same universe
are meaningful.

## Walk-forward (src/validation/walk-forward.test.ts)

Rolling 300-trading-day train / 150-day test folds over the long dataset,
27-config grid (drift 5/10/15% × cadence 30/45/60d × vol target 15/20/25%),
selection on train Calmar, applied out-of-sample. Verdict from the first run
(synthetic $30k, 7-name universe, six folds spanning 2022-09→2026-04):

- OOS positive in **all six folds**, including the 2022 bear fold where
  buy-and-hold was double-digit negative — the drawdown-management story is
  real and survives out-of-sample.
- Walk-forward selection beat the fixed production defaults only modestly;
  parameters are stable across folds. Notable: **drift 5% won 5 of 6 folds**
  (production runs 10%), cadence 45–60d and vol target 15–20% match
  production. If anything earns a live change it's the drift band, and only
  after the after-tax lens (a tighter band means more disposals inside the
  12-month CGT line — see "Compare after tax").
- Buy-and-hold beat the managed strategy on absolute return over the span, as
  expected in a bull-heavy window with a survivorship-inflated universe; the
  managed strategy's worst fold drawdown was less than half of B&H's.

## Algorithm options (researched 2026-08-29, ranked by fit)

1. **Keep band-based rebalancing; consider tightening drift toward 5% after
   tax modeling.** The literature agrees with what this repo already does:
   tolerance bands beat calendar rebalancing on turnover-for-tracking-error,
   and calendar rebalancing "rebalances too soon" in trends. The walk-forward
   independently picked tighter bands than production runs.
2. **Momentum tilt on the existing book (overweight recent 6–12m winners
   within the universe, don't add names).** Volatility-managed momentum is
   the one factor where vol-scaling evidence stays positive out-of-sample.
   Cheap to trial: the engine's `black_litterman` path already consumes
   momentum views.
3. **Volatility-managed exposure (already implemented as vol targeting) —
   keep, but don't expect alpha from it.** Moreira & Muir's in-sample alphas
   largely evaporate in broader out-of-sample studies (53 win / 50 lose of
   103 portfolios); its honest value here is drawdown shaping, which the
   walk-forward confirms.
4. **HRP vs equal-weight: re-examine.** Recent studies find 1/N beats HRP
   out-of-sample in small universes; HRP's edge is variance reduction, not
   return. Worth a head-to-head in the honest engine before assuming the
   optimizer earns its complexity at this portfolio size (n < 20).
5. **Skip:** minimum-variance optimizers (concentration blowups at this n),
   ML/RL allocation (overfitting at one-book scale), anything requiring
   shorting or options (long-only spot mandate).

Sources: Kitces on opportunistic rebalancing; Dimensional "Finding Your
Balance"; FPA Journal "Opportunistic Rebalancing"; Moreira & Muir 2017
"Volatility-Managed Portfolios" (J. Finance) and the contrary evidence in
"On the performance of volatility-managed portfolios" (JFE 2020); López de
Prado 2016 on HRP and later comparative studies (e.g. arXiv 2210.00984).

## Drift band × AU CGT (src/validation/drift-band-tax.test.ts, 2026-08-29)

The walk-forward picked drift 5% in 5 of 6 folds; production runs 10%. The
feared mechanism ("tighter band → more disposals inside the 12-month line →
misses the 50% discount") was tested directly on the honest engine, synthetic
$30k, marginal 47% (sensitivity 32%), reporting both the deferral figure and
the terminal-liquidation bookend per the rule above.

Result: **5% beat 10% on every column, on both windows.** On the long window
(includes the 2022 bear) it wasn't close — roughly 25pp better after tax at
either rate and both bookends, with lower max drawdown. On the short default
window 5% and 15% tie after tax and 10% is the *worst* of the three.

The warned mechanism did not materialise: the 5% band produced MORE total
disposals but FEWER short-term ones than 10% (long window: 54 of 119 inside
12 months vs 68 of 109). A tight band trims small, often stale lots
continuously; the wide band waits, then sells bigger slices of younger lots.
Trade count is indeed the wrong thing to reason from — but in the direction
opposite to the intuition recorded above.

Re-scoring the walk-forward with an after-tax train metric keeps the same
answer: drift 5% wins 4 of 6 folds, 10% the other two.

Verdict offered (decision is the operator's, config untouched): the evidence
supports moving REBALANCE_DRIFT_THRESHOLD from 10 to 5. Caveats: the universe
is survivorship-inflated so only the relative ranking matters; the default
window's three-way spread is small; and 10% being worst of three says the
drift dimension carries noise — the long-window margin is what makes the case.

## AMENDMENT (2026-08-29, later): the drift-band verdict above is WITHDRAWN

The "5% beats 10%" section above was measured on an engine whose rebalance
gate did not match production, and it is superseded by the gate-fidelity work
in this amendment. What was wrong, in order of impact:

1. **Wrong optimizer.** The study ran HRP; production has run `static` since
   the 2026-08-19 operational study. Under HRP, re-optimized weights blow
   through any drift band and the cadence binds — which is exactly why its
   5% and 10% rows traded almost identically (154 vs 144). Under static
   weights the band is the binding constraint and the comparison changes
   entirely.
2. **Cooldown counted trading days.** Production counts CALENDAR days since
   the last rebalance; 45 trading days is ~63 calendar days. The engine's
   cooldown was ~40% too long.
3. **No urgent path, no within-threshold/too-soon distinction.** The engine
   skipped the drift computation during cooldown, so it could not model the
   urgent bypass (25%) or the cash-flow deployment that production runs in
   the within-threshold state. All three states now route through the SAME
   `decideRebalance` production uses, and idle cash above $1,000 deploys
   buy-only into underweights without resetting the cooldown — as live.
4. **Vol targeting was fiction.** risk-manager computes `volTargetLeverage`
   and writes it to state, but no order path reads it. The engine applied it
   as a daily target multiplier; DEFAULT_CONFIG now disables it for parity.

**Gate validation.** With the paths above ablated back to the 2026-08-19
operational study's shape, this engine reproduces its trade-count regime
(116 vs its 118 at drift 5% over the long window) — so the counts in that
study are evidence about the gate it modeled, and neither of the two prior
studies (that one: no urgent/cash-flow/calendar-cooldown, dividend-blind,
frictionless; this doc's earlier section: HRP + the same gate gaps) measured
the strategy production actually runs.

**Result under the faithful gate: INCONCLUSIVE on 5 vs 10.** The ranking is
non-monotonic in the band and flips sign across windows (10% wins the
default and full long windows; 10% is the worst of the three on the
2020→2023-09 out-of-sample cut). The dominant driver is not the band at all:
the interaction of exposure-scaled drift, the urgent bypass, and buy-only
cash-flow redeployment generates hundreds of extra fills (vs tens without
those paths) and, with the regime overlay ON, ~25pp of extra drawdown in the
long window (sell-low on a regime flip, rebuy-high via cash-flow days
later). Almost every disposal it forces is short-term, so none of it earns
the CGT discount.

**The real finding is a design hazard, not a tuning answer.** Production's
own code path can churn: a regime downgrade scales targets and can fire an
urgent (or post-cooldown regular) sell; the resulting cash then re-deploys
into the same names through the cash-flow path on later within-threshold
days; a regime upgrade completes the round trip. The 2026-08-19 engine could
not see this because it modeled neither path. Reviewing that interaction
(e.g. hysteresis on regime-driven target changes, or excluding
regime-scaling from the drift that feeds the gate) matters more than the
band choice.

**Operational fact (independent of any backtest):** the cash-flow deployment
runs ONLY in the `within-threshold` state. At drift 10% with current drift
below the threshold, idle cash deploys. Moving the threshold to 5% while
drift sits above it puts the gate in `too-soon` until the 45-day cooldown
lapses (2026-10-02) — re-blocking deployment, which is the exact condition
the 2026-08-19 change was made to escape.

**Verdict: keep 10%.** Not because 10% is proven better after tax — the
faithful-gate evidence is inconclusive — but because (a) the case for 5% is
withdrawn with the engine that produced it, (b) 5% would re-block cash-flow
deployment until at least 2026-10-02, and (c) the churn hazard should be
understood before any band tuning. Revisit after 2026-10-02.

## Churn fix study (2026-08-29, later still)

The churn hazard flagged in the amendment above was diagnosed, guarded, and
re-measured. All numbers: honest engine + faithful gate, static model
weights, synthetic $30k, locked metric fixed before the runs (after-tax
liquidation-bookend return at 47%, and max drawdown).

**Diagnosis.** The loop is: exposure-scaled targets (regime multiplier
inside the drift signal) trigger a sell via `decideRebalance`; the freed
cash redeploys into the SAME names through the buy-only `allocateCashFlow`
path on later within-threshold days. Measured at drift 10 on the long
window: 71 of 101 cash-flow fills rebought a name sold within the prior 30
days, median gap 5 days, ~18x the account's capital round-tripped over the
window, every leg a short-term disposal.

**Guards implemented** (both in production code paths, config-gated,
DEFAULT OFF — merging changes no live behaviour):
- `dampExposure` dead-band (rebalance.ts): a new exposure multiplier only
  applies once it moves ≥ deadBand from the last APPLIED one.
- `allocateCashFlow` rebuy guard (cashflow-rebalance.ts): cash-flow skips
  names the strategy sold within N days; their share of the deposit stays
  in cash rather than over-filling other names.

**Validation (churn-fix.test.ts).** The rebuy guard ALONE is the fix:
- churn zeroed (71 → 0 rebuy-within-30d fills; short-term disposals down);
- the overlay's protective function is RESTORED: long-window max drawdown
  66% → 35%, and overlay ON is now better than overlay OFF on drawdown —
  before the guard it was 25pp WORSE (sell-low/rebuy-high sequencing);
- the 2020→2023-09 OOS cut goes from -33% to -1% liq@47, beating overlay
  OFF as well.
The dead-band was not robust (helps one window, hurts another; combined
config dominated by guard-only) — implemented and unit-tested, not
recommended. And the honest cost, locked in the tests: the churn had been
accidentally PROFITABLE in bull windows (rebuys kept the book more invested
while prices rose) — removing it costs ~6pp liq@47 on the long window and
~30pp on the 2023→2026 window. The OOS cut shows that profit was
uncompensated bear risk: the same mechanism produced the -33%.

**Re-tune on the fixed system.** After-tax walk-forward (guard 0/14/30/60 ×
drift 5/10/15, liq@47-Calmar train metric): fold winners scatter across the
grid, and chained OOS keeps the unfixed config ahead (five of six folds are
bull-era). No parameter is robustly better — the tuning inconclusiveness
from the previous amendment persists. The guard is a RISK decision, not a
return optimization: it buys a halved worst-case drawdown and bear-window
survival at the price of bull-window after-tax return.

**Recommendation to the operator** (nothing enabled in production; the
adoption decision is yours): enable `cashFlowRebuyGuardDays=30` if the
fund's mandate weights drawdown control and bear survivability over
maximal bull capture — that is the stated reason the regime overlay exists,
and the guard is what makes the overlay actually deliver it. Leave the
dead-band off. Keep drift at 10% (unchanged conclusion). If enabled, watch
the first weeks around the cash-flow path: with the guard active, recently
trimmed names will sit in cash longer by design.
