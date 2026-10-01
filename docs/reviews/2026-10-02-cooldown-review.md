# 2026-10-02 cooldown review — decision brief

Diarised review: the 45-day rebalance cooldown (`REBALANCE_FREQ_DAYS=45`,
last rebalance 2026-08-18) lapses today. This note is analysis only — no
config or code changes are made here. It supersedes nothing in
`docs/backtesting.md`; read that file's 2026-09-24 sections (the regime
retirement, G6) alongside this one.

No book figures appear below. This is a public repo; the methodology is
public, the book is not (`docs/private/`, gitignored).

## 1. The cooldown lapse is a no-op on the legacy gate

`decideRebalance` (`src/portfolio/rebalance.ts`) only changes behaviour from
the cooldown lapsing if the book is currently sitting in the `too-soon`
state — i.e. `maxDrift` was already past `REBALANCE_DRIFT_THRESHOLD` (10pp)
while the cooldown blocked it. Lapsing the cooldown then promotes that to
`regular` and a sell fires. If the book is instead `within-threshold`
(`maxDrift < 10`), the cooldown was never the binding constraint and its
lapse changes nothing — cash-flow deployment to underweights was already
running every cycle regardless of cooldown state.

`computeDrift` (`rebalance.ts:241-253`) takes the single largest
`|current% − target%|` across all 19 names. With targets in the 2–8% range,
reaching the 10pp legacy threshold on any one name requires that name's
weight to roughly double-or-more its target (an 8%-target name would need
to reach ~18% of NAV; a 2%-target name would need ~12%, a 6x overweight).
The urgent bypass (`REBALANCE_URGENT_DRIFT_THRESHOLD=25`) requires an even
more extreme single-name concentration. Neither is a plausible outcome of
normal drift inside a 19-name diversified book — this is the same
arithmetic the 2026-09-24 review used to retire the regime overlay (below),
and it applies identically to the legacy gate itself: **the legacy gate is
very unlikely to be in `too-soon` at all on this book shape**, which is why
the cooldown lapsing today is expected to be a no-op by itself.

This is a statement about the gate's arithmetic, not a claim about today's
actual `maxDrift` — that's a private-book number and isn't computed here.
Isaac can confirm directly from the strategist's last log line (`maxDrift`
is logged every run) or from `state.json`: if it reads `within-threshold`
or `too-soon` with `maxDrift < 10`, the brief's conclusion holds and no
action follows from the lapse alone. If it somehow reads `too-soon` with
`maxDrift >= 10`, that would mean some name is already running at roughly
double its target weight — worth knowing regardless of the cooldown, and a
separate conversation from "the cooldown lapsed."

**Why the regime overlay retirement doesn't change this.** The overlay
(`computeExposure`, `rebalance.ts:159-229`) applies one multiplier,
`regimeMult`, to every target weight uniformly — it doesn't single out
names. On a book of 2–8% targets, a one-notch regime change (the kind that
happens often; risk_on↔neutral is a small composite-score move) contributes
at most `|Δmult| × target_i` of drift to any one name — for the largest,
8%-target name, a 15-point multiplier swing adds at most ~1.2pp, nowhere
near the 10pp gate. So even switched on, the overlay could not have pushed
`computeDrift` past the legacy threshold on this book — it only ever
reduced the *size* of every target uniformly, which throttled how much idle
cash the buy-only cash-flow path (`within-threshold`) deployed into
underweights. That is the "cannot trigger any sell, only throttles
cash-flow buys" conclusion from the 2026-09-24 review (`docs/backtesting.md`
§"The regime overlay is retired"), and it is consistent with — not
contradicted by — the retirement decision. Its old evidence (the churn
study's drawdown story) came from a 7-name book where single-name targets
were large enough (~14%) for the same multiplier swing to move drift by
several points.

**Bottom line:** confirm `maxDrift` from the log before close of business;
absent a surprise there, nothing about today's date calls for a trade, a
config change, or an override of the "accept the book as-is" decision
already made.

## 2. Bands shadow: what ~8 days can and cannot show

`DRIFT_GATE=bands` shipped dark on 2026-09-24/25 (`ca159d1`,
`7d177d4`). `state.bandsShadow` and the `bands gate would: …` log lines
(`src/agents/portfolio-strategist.ts:428-442`) have been accumulating since
deploy — roughly a week to 10 days of live records by today.

**What it can show**, read fairly:
- The band gate runs without error on live prices and real fills' lot
  history (FIFO reconstruction, CGT guard, rebuy-guard interaction) — an
  operational check, not a performance one.
- Qualitative signal: how often `assessBands` reports `triggered` or
  `urgent` on the live book, which names go out-of-band and in which
  direction, and whether the half-L1 (`½Σ|dev|`) figure is trending up or
  down relative to the 5% portfolio trigger.
- Whether the shadow's "would sell" set, had it executed, looks like it was
  trimming into further gains or into a pullback over the following days —
  directionally suggestive, not a measurement.

**What it cannot show:**
- It cannot overturn G6. G6's pre-registered uncertainty method (stationary
  block bootstrap, mean block 20 trading days) exists precisely because
  daily portfolio returns are autocorrelated — a handful of days is well
  under even one resampling block, let alone the stretch needed for the
  bootstrap's 95% lower bound to move. G6 failed by a wide margin on two of
  four pre-registered conditions (M1 −12.2pp on W1, bootstrap lower bound
  −4.6%/yr on W1, −5.1pp on W2); ~8 days of shadow data cannot close a gap
  that size under any honest statistical treatment.
- It cannot speak to bear-market behaviour at all — the window contains no
  bear regime, and G6's worst result for bands was specifically in the 2022
  bear window (W2).
- It says nothing about the survivorship bias G6's "Reading it" section
  flagged (bands trims winners early in a universe selected partly because
  it ran) — that bias doesn't resolve with more calendar days of the same
  live names, only with the deferred random-book test.

**What to look for in the log between now and the next look** (recording
only, not for an early decision): trigger/urgent frequency vs. legacy's
actual trade frequency; which names recur in the out-of-band list; CGT-guard
hold-backs (`notes`); any overlap between bands' would-be sells and the
rebuy guard's exclusions, which would flag the churn mechanism G6's
"Reading it" section is watching for even in shadow form.

**Next honest look — pre-registered now, not after peeking:**
- **Date:** propose **2027-03-25** — roughly six months of live shadow
  (two full quarters), long enough to contain at least one real
  decorrelated block under the G6 bootstrap's own 20-trading-day block
  size with room to spare, and to very likely span at least one regime
  change the current ~8-day window cannot.
- **Rule, fixed now:** re-run the G6 decision rule (`docs/backtesting.md`
  §G6, same four conditions) with the shadow-log fills substituted for the
  backtest's "bands" arm wherever they overlap the live window, PLUS the
  deferred random-book history test (a universe not selected for having
  already won) as a second, independent non-inferiority check. Both must
  pass for a switch-on; either failing keeps `DRIFT_GATE=legacy`. No
  intermediate check-in between now and 2027-03-25 should use the shadow
  record to argue for an early switch — an interim look that happens to
  land favourably is exactly the kind of peeking the pre-registration is
  meant to foreclose.

## 3. Rebuy-guard month review — checklist for the Pi

This session cannot reach the Pi. The following is for Isaac to run there
directly, against `state.json` / the strategist's log
(`CASH_FLOW_REBUY_GUARD_DAYS` in `.env`, consumed as
`config.rebalance.cashFlowRebuyGuardDays`, `src/config.ts:57`; mechanics in
`src/portfolio/cashflow-rebalance.ts`):

1. **Current setting.** Confirm what `CASH_FLOW_REBUY_GUARD_DAYS` is
   actually set to on the Pi (default is `0` / off if unset — check, don't
   assume it matches the backtest's recommended 30).
2. **Exclusion log frequency.** Grep the strategist's log for "Rebuy guard"
   lines over the past month. Count how often a name was excluded from
   cash-flow deployment, and how often an exclusion was later "lifted"
   (`rebuyGuardExclusions`'s `lifted` list — a sale whose target was since
   raised). A guard that never fires isn't being tested by this window; one
   firing constantly on a small set of names is worth a closer look at why
   those names keep getting sold.
3. **Idle cash.** Cross-reference excluded names against the "Cash
   reserve"/"deployable" log lines for the same runs. When a deposit landed
   while a name was excluded, did its share of the deposit sit in cash (as
   designed) or get silently redirected in a way that overshot another
   name's target? Check whether idle, undeployed cash accumulated for
   multiple cycles because the excluded name's weight in the deficit set
   was large relative to the rest.
4. **Guard vs. bad-sale repair.** The scenario the guard is explicitly
   trading away: a sale that, with hindsight, shouldn't have happened (a
   one-notch regime flap, a data blip, a reconciliation correction) cannot
   be undone by cash-flow buys until the guard window lapses. Search the
   month's log for any SELL followed within the guard window by a situation
   where the name's target rose (the "lifted" path exists for exactly this)
   — and separately, any case where a sale looked like it needed correcting
   and the guard sat in the way with no lift available. Zero instances is
   the expected/good outcome; any instance is worth bringing back for
   discussion rather than resolving unilaterally.

## 4. Rollout flags pending from 2026-09-24

All four ship dark; `src/rollout.ts` documents the default/typo-safe
behaviour. Pi-side checks only — this session has no way to run them.

- **`INTRADAY_DD_SOURCE` shadow → nl.** Already defaults to `shadow`
  (`src/rollout.ts:66`, `.env.example:163`): the legacy upnl/rpnl
  reconstruction gates today, and the `nl`-based figure logs alongside it
  for comparison. Before flipping to `nl`: pull a week (ideally more) of
  the shadow comparison lines and confirm the `nl` figure never diverges
  from legacy by an amount that would have changed a drawdown-ladder
  decision, and that it has no missing/stale values during a market-data
  gap (that's the one way "sane shadow values" could be mistaken for
  "ready" — a figure that looks fine because it's frozen, not because it's
  right).
- **`REPLY_POLICY` log → enforce.** Currently `log`
  (`src/connection/gateway.ts:678`). The check before flipping:
  `state.orderReplyLog` (capped at 200 entries,
  `src/agents/execution-bot.ts:245`) must, over the review period, contain
  every `messageIds` combination IBKR has actually raised, each already
  present in `REPLY_ALLOW_IDS` (`gateway.ts:672`) or explicitly accepted
  into `REPLY_ALLOW_IDS`/the deny list. Walk the log end-to-end (not a
  sample) and confirm no prompt id it recorded falls into "unknown" under
  `evaluateReply` — any unknown id under `enforce` silently fails to place
  that order, so this is a completeness check, not a spot check.
- **`WASH_SALE_BLOCK` → off.** Currently `on` by default
  (`src/tax/harvesting.ts:27-28`, `.env.example:177-179` — "ON until the
  tax work is deployed"). The stated rationale for turning it off is sound
  (AU's TR 2008/1 test is about purpose, not a 31-day count, so the US-style
  block is overcautious here) — the check before flipping is to confirm the
  AU tax-report path (`src/tax`) that was meant to replace this guard has
  actually shipped and is the one the Pi runs, not that the rationale is
  correct in the abstract. If that replacement logic isn't live yet, turning
  the block off removes a safeguard before its replacement exists.
- **`WATCHDOG_RESTART` dry-run → on.** Currently `dry-run`
  (`deploy/watchdog/.env.example:15`). The check: read the journal for
  "DRY-RUN — would …" lines over the review window and confirm (a) they
  only fire for the conditions the README's table says should restart
  (dead gateway, wedged SSO bridge) and never for `upstream_failing` (which
  the table says should never restart), and (b) no dry-run restart would
  have collided with another process holding the session lock — i.e. that
  going live wouldn't have caused the watchdog to fight `relogin` or a
  manual session. A month of correct dry-run logging with no near-misses
  on the session lock is the bar; switching early on a thin log just moves
  the risk from "watchdog didn't act" to "watchdog acted wrongly."

## 5. Recommendation

Do nothing today: the cooldown lapsing is, on the gate's own arithmetic,
not expected to change anything while the book sits within the legacy
threshold (confirm `maxDrift` from the log as the one-line check), the bands
gate stays dark pending a pre-registered look in six months rather than an
early peek at a statistically meaningless week of shadow data, and the
residue from the 2026-08-18 rebalance stays accepted rather than trimmed —
consistent with the decision already made that this is a model-conformance
call, not something to hand to a gate that failed its own pre-registered
test. The real tradeoff worth naming plainly: accepting the residue and
declining to tighten the gate trades a small, known, continuing deviation
from the model's stated weights for not repeating the G6 finding that this
survivorship-tilted universe punishes any rule that trims winners on a
schedule — that's a bet that the band gate's failure mode (not this
specific residue) is the bigger risk, and it should be revisited on the
pre-registered date above, not whenever the residue starts to feel
uncomfortable. The four rollout flags are independent of all of this and
can proceed on their own Pi-side schedules without waiting on the bands
decision.
