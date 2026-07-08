# Execution Bot — Risk Register (gates unpausing)

Updated 2026-07-04. The staged-execution refactor + ten-lens review fixed 10
correctness bugs (`02f56c4`); the six register items below were then addressed
in `399cf3c` + `<base-row fix>`. **All six are now resolved or mitigated** —
see status on each. Two things still stand between here and unpausing, called
out in "Before unpausing" at the bottom.

Severity reflects verification against the actual code (not just the review
finding), including mitigations already present in the system.

---

## 1. AUD/USD currency mismatch in the cash gate and NAV — _RESOLVED (`399cf3c`)_

**How IBKR reports it (the answer):** the account (`U1234567`, IB-AU, STKCASH)
holds cash in **per-currency buckets** and does **not** auto-convert. CPAPI's
`/summary.totalcashvalue` is the **base-currency (AUD) aggregate** — e.g. a few
dollars of AUD, which says nothing about USD buying power. The live `/ledger`
shows USD `cashbalance` $0 and USD `settledcash` $0, with the bulk of NAV in
USD **stock** value. A cash account cannot borrow USD, so USD stock buys must
be funded by **USD cash** — here, the USD proceeds of the USD sells that run
first (the staged sells-before-buys ordering already guarantees this). IBKR
lets a cash account spend **unsettled** proceeds (`cashbalance` includes them);
the only restriction is you must not re-sell the bought shares before the
funding sale settles (T+1) — irrelevant for a buy-and-hold rebalance.

**Fix:** `gateway.getUsdBalances()` reads `/ledger`, returns USD `cashbalance`
+ USD NAV (excluding the `BASE` pseudo-row, which double-counted NAV ~2×). The
executor gates on USD cash and the strategist sizes on USD NAV/cash. Verified
live: `usdCash=$0.00`, `usdNav=$29,155.64`. Re-running the strategist proved
the old quantities were oversized by the FX factor (AVGO 9→6 shares, TLT
39→27) and that weights now sum to ~100% (NET's true weight is 41.6%, not the
29% the AUD-mixed math showed).

**Original description follows.**

### (original) AUD/USD currency mismatch in the cash gate and NAV

**What:** The account (`U1234567`) is IB-AU with **AUD** base currency.
`getAccountSummary().totalCashValue` and `netLiquidation` come from CPAPI's
`/summary`, denominated in the **account base currency (AUD)**. But order
`estimatedValue` is `qty × USD price` (**USD**), because the strategist prices
US equities in USD.

- `gateBuysByCash(buys, totalCashValue, ...)` compares **USD** buy costs
  against **AUD** cash → overstates USD buying power by ~1/FX (≈ +50% at
  AUD/USD ≈ 0.66). The gate admits buys that real USD cash can't fund; the
  first over-budget buy rejects at IBKR (now caught by halt-on-reject), but
  the gate's whole purpose is defeated and the run churns.
- `ctx.nav` (AUD `lastNav`) feeds `selectExecutionStrategy`'s
  percent-of-portfolio thresholds against USD order values — mislabels order
  sizes (e.g. TWAP vs adaptive vs market selection).

**Note:** this is a *pre-existing systemic* modeling gap — the strategist's own
drift math already mixes USD position values against AUD NAV. Fixing it here
without fixing it there would be half a fix.

**Recommended fix:** fetch the **USD cash line** specifically from CPAPI
`/summary` (it exposes per-currency rows) and gate against that; or fetch an
FX rate and convert. Thread a single currency convention through strategist +
executor. Until then the gate is advisory, not a real guardrail.

---

## 2. Cross-run duplicate on confirmation timeout — _RESOLVED (`399cf3c`)_

**Fix:** `gateway.cancelOrder()` wired (the bezant `DELETE …/orders/{id}` route
exists). On a confirmation timeout, confirm-stream error, or timed-out partial,
the executor now best-effort **cancels the working order** before halting, so a
still-live order can't be regenerated and doubled by the next strategist tick.
Best-effort by design — a failed cancel just leaves the pre-existing risk, it
never throws. (A fuller belt-and-braces fix would also give the strategist
open-order awareness; the cancel closes the common case.)

### (original) Cross-run duplicate on confirmation timeout

**What:** On a fill-confirmation timeout the executor drops the order (doesn't
requeue) on the stated assumption that "the strategist rebuilds the queue from
live positions, which reconciles either way." **The strategist reads positions
only — it has no open-order awareness.** So if a timed-out order is still
working at IBKR, the drift that generated it persists, and the next strategist
heartbeat (urgent-drift bypasses the 45-day cooldown; its RTH window overlaps
the execution window) regenerates the **same** order and submits it a second
time → double-trade.

**Why not patched:** the safe fix is to **cancel the working order on timeout**
before dropping it — but `gateway.ts` exposes no cancel function yet (bezant
has `DELETE /accounts/{id}/orders/{orderId}`; it's just not wired). Alternative
/ complement: give the strategist open-order awareness so it won't regenerate
an order that's already working.

**Recommended fix:** add `cancelOrder(orderId)` to the gateway and call it on
timeout/halt for orders whose state is unknown; and/or have the strategist
fetch open orders and subtract them before generating the queue.

---

## 3. Quantity-aware FIFO lot accounting — _RESOLVED (`399cf3c`)_

**Fix:** `src/tax/fifo.ts` `matchSellFifo()` replays history, nets each BUY lot
by shares already consumed by prior SELLs, and consumes the current sale across
lots oldest-first — weighted cost basis, correct P&L sign (so loss sales open
wash-sale entries), and a `longTermQty` for the AU CGT discount. New
`matchedLots[]` on the trade record; legacy `matchedBuyTimestamp` honoured as
whole-lot consumption. 8 unit tests including the multi-lot sign-flip case.

### (original) Quantity-aware FIFO lot accounting

**What:** `recordFilledTrade`'s FIFO matcher pairs each SELL with exactly one
earliest unmatched BUY **record**, ignoring share quantities:

- A SELL spanning multiple lots prices the whole quantity off one lot →
  wrong realised P&L, and a **sign flip** can suppress a real wash-sale entry
  (loss sales only open the wash-sale window), letting the strategist rebuy
  inside the 31-day window.
- A SELL smaller than the matched lot marks the whole lot consumed
  (`matchedBuyTimestamp`), so a later SELL of the same symbol finds no
  unmatched BUY and records **no** cost basis / P&L at all.

The refactor fixed the per-fill quantity (P&L now uses confirmed filled qty),
but the whole-lot matching is unchanged from the original code.

**Recommended fix:** a lot-tracking matcher that consumes BUY lots partially
(remaining-qty per lot, carried across sells), replacing the whole-record
`matchedBuyTimestamp` marker. Self-contained and unit-testable — a good next
PR. IBKR keeps authoritative lot accounting, so this is about the bot's
internal wash-sale suppression and its own tax ledger, not the broker's.

---

## 4. fill-confirmer polls the orders ring from cursor 0 — _MITIGATED (`399cf3c`)_

**Fix:** the executor now threads `fromCursor` into `confirmFill`, set to the
observer's current orders cursor (`ordersCursorFloor`), so confirmation only
considers events at/after this run — a recycled orderId can't match stale
history from a prior session. Mitigation, not a total fix: it relies on the
observer cursor being reasonably fresh; if the observer isn't running the floor
falls back to 0 (today's behaviour, safe but wider). A complete fix captures the
ring head cursor at each placement.

### (original) fill-confirmer polls the orders ring from cursor 0

**What:** `confirmFill` is called without `fromCursor`, so it defaults to 0 and
scans the **entire** orders ring from the beginning every time
(`fill-confirmer.ts:89`). Two consequences:

- **Recycled orderId → phantom terminal fill:** IBKR order ids can recur; a
  stale historical event for the same id can be matched as this order's
  terminal state.
- **Backlog burns the timeout:** the poll loop sleeps `pollIntervalMs` after
  every page while catching up through ring history, so a large backlog can
  exhaust the timeout before live events for the current order are reached.

**Recommended fix:** capture the ring's head cursor at (or just before) order
placement and pass it as `fromCursor`, so confirmation only considers events
at/after this order. The observer already persists `observerCursors` in state
— reuse that head.

---

## 5. No in-process run lock (defense-in-depth) — _RESOLVED (`399cf3c`)_

**Fix:** a state-file run lock (`executionRunLock` = `{at, pid}`, stale after
35 min) acquired at run start and released in `finally`. Refuses to start if a
non-stale lock is held. Paperclip already serialises heartbeat runs per agent
(atomic `UPDATE … WHERE status='queued' RETURNING`); this defends the residual
case — a manual `node execution-bot.js` overlapping a scheduled run.

### (original) No in-process run lock (defense-in-depth)

**What:** the bot holds `pendingOrders` in memory for the whole run (up to
~30 min with 10 Patient confirmations) and only writes `requeue` back at the
end via `mergeState` (last-write-wins per top-level key).

**Mitigation already present:** paperclip claims each heartbeat run atomically
(`UPDATE heartbeat_runs SET status='running' WHERE status='queued' RETURNING`;
the loser gets null and bails) and skips enqueuing an agent that already has a
queued/running run. So **normal heartbeat operation will not run two
execution-bots concurrently.** The residual risk is a **manual** invocation
(`node dist/agents/execution-bot.js --once`) launched while a heartbeat run is
active — that path has no guard and would double-place the queue.

**Recommended fix (cheap):** a state-file lock (`executionRunLock` with a
pid/timestamp and a stale-after timeout) checked at run start — pure
defense-in-depth so a stray manual run can't overlap.

---

## 6. mergeState clobbers a mid-run strategist queue update — _RESOLVED (`399cf3c`)_

**Fix:** the executor snapshots `pendingOrders` at run start and, at write-back,
re-reads the on-disk queue; if the strategist regenerated it mid-run the
executor **skips writing `pendingOrders`** (keeping the strategist's fresher,
position-derived queue) rather than overwriting with its stale requeue — which
could have resurrected just-filled orders. Other keys still merge.

### (original) mergeState clobbers a mid-run strategist queue update

**What:** `mergeState` is whole-key last-write-wins. If the strategist rewrites
`pendingOrders` while an execution run is in flight, the executor's end-of-run
write (from a snapshot taken minutes earlier) overwrites it — either
resurrecting just-filled orders or dropping fresh ones.

**Mitigation:** run-level serialization (item 5) makes strategist and executor
runs for the same company unlikely to overlap in practice, but they are
*different agents*, so the claim lock doesn't strictly exclude them.

**Recommended fix:** re-load state and reconcile `pendingOrders` by identity at
write time instead of overwriting, or move the queue to a claim-based table.

---

## Summary

| # | Risk | Severity | Status |
|---|------|----------|--------|
| 1 | AUD/USD cash-gate & NAV currency | High | **Resolved** — USD ledger for gate + strategist sizing |
| 2 | Cross-run duplicate on timeout | High | **Resolved** — cancel-on-uncertainty wired |
| 3 | Quantity-aware FIFO lots | Medium (tax) | **Resolved** — `src/tax/fifo.ts` |
| 4 | fill-confirmer cursor-0 scan | Medium | **Mitigated** — `fromCursor` floor threaded |
| 5 | No in-process run lock | Low | **Resolved** — state-file lock |
| 6 | mergeState clobber | Low | **Resolved** — skip write on mid-run regen |

## Go-live deal-breaker review (2026-07-04, `f92a514`)

A second, dedicated review — ten lenses hunting only for go-live deal breakers,
each finding checked by two independent adversarial skeptics (60 agents, 0
errors) — surfaced a **duplicate-trade family** plus tax/risk gaps. Fixed:

| Root | Deal breaker | Fix |
|------|--------------|-----|
| A | Phantom fill: a `Filled` confirmation with 0 shares recorded a full-qty trade, poisoning FIFO/wash-sale records | fill-confirmer downgrades filled-with-0; executor records nothing + halts |
| B | `placeOrder` throw requeued as "nothing reached IBKR", but a post-accept timeout leaves it live → duplicate next run | ambiguous placement is dropped + halted, not requeued |
| C | No account-level idempotency: a working order from a prior run could be duplicated | `gateway.getLiveOrders()`; executor skips placing any symbol+side already working at IBKR |
| D | `pendingOrders` only written at run end → a crash after fills replayed already-filled orders | incremental `persistRemaining()` shrinks the on-disk queue per order; guarded trade recording |
| E | "skip write if strategist regenerated" could keep a stale queue that re-includes a filled order | removed; the incrementally-persisted queue never contains an executed order → authoritative |
| F | Intermediate drawdown levels (warning/derisking) didn't shrink order sizes on the live path | strategist applies `drawdownExposureMultiplier` to sizing |

The open-order idempotency guard (C) is the linchpin: it makes placement
idempotent against IBKR's own order state, closing most of the cross-run
duplicate paths at a single choke point.

### Residual — fix before the first tax year-end, NOT blocking go-live

These corrupt the bot's **tax ledger** but cannot lose or duplicate a live
trade, and are reconcilable from IBKR's authoritative statements at year-end:

1. **Fill-after-timeout not recorded.** If an order fills in the race between
   the confirmation timeout and the cancel landing, that fill hits the account
   but isn't written to `trade-history.json` — future FIFO/wash-sale for that
   symbol is then off. Needs an executions-based reconciliation pass
   (bezant `/events/orders` history or an IBKR executions endpoint) to backfill.
2. **Opening holdings have no cost basis.** `trade-history.json` starts empty
   but the account already holds ~US$29k of positions; selling one yields
   `matchSellFifo` `matchedQty==0` → no realised P&L and no wash-sale entry.
   Seed opening lots from IBKR position `avgCost` at first run.
3. **`washSales` lost-update race** between execution-bot and tax-optimizer
   (different agents, whole-key `mergeState`). Low probability; make the merge
   element-wise.
4. **Run lock leaks if `connect()` throws** (it's outside the try/finally) —
   wedges execution for 35 min, no money impact. Move `connect()` inside.

## Before unpausing

1. **Market-data reliability.** The strategist occasionally reads
   partial/stale prices on a tick (observed 2026-07-04: one run computed 8%
   max drift, the next 37.6% — the first had missing quotes). Validation-first
   caps the blast radius (one small sell before a confirmed fill), but the
   strategist's queue can still be sized off a stale snapshot. Pre-existing
   (`getMarketPrices`/snapshot timing); worth a look on its own.
2. **First live run is validation-only by design.** With
   `liveExecutionValidatedAt` unset, the first in-window run sells a single
   BRK-B and demands a confirmed fill before unlocking the rest. Watch that
   one fill reconcile (`scripts/show-fills.ts`) before letting the queue run.

The queue was regenerated with correct USD sizing on 2026-07-04 (4 sells,
11 buys).
