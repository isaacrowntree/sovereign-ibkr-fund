/**
 * Portfolio Strategist
 * Computes target weights, detects drift, generates rebalance orders.
 * Uses shared rebalance logic from portfolio/rebalance.ts (same as backtest engine).
 */
import { connect, disconnect, getAccountSummary, getUsdBalances, getMarketPrices, requestDelayedData } from '../connection/gateway.js';
import { TARGET_PORTFOLIO, validateTargets, config } from '../config.js';
import { allocateCashFlow } from '../portfolio/cashflow-rebalance.js';
import {
  computeTargetWeights,
  computeDrift,
  decideRebalance,
  generateRebalanceOrders,
  dailyReturns,
  type PortfolioSnapshot,
} from '../portfolio/rebalance.js';
import { regimeExposure, type RegimeState } from '../quant/regime.js';
import { drawdownExposureMultiplier, type DrawdownState } from '../risk/drawdown.js';
import { navSanityViolation, priceSanityViolations, marketDataFreshness } from '../risk/data-sanity.js';
import { isStrategistWindow, describeWindow, STRATEGIST_WINDOW } from '../strategy/market-hours.js';
import { loadState, mergeState } from '../state/store.js';
import { notify } from '../notify/slack.js';
import { storeHooks } from '../notify/store-hooks.js';
import { log, logError } from '../log.js';

const AGENT = 'PortfolioStrategist';

/** Format a dollar amount. Named `fmtUsd` — `usd` is taken by the balances read in run(). */
const fmtUsd = (n: number): string => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/**
 * Collapse a navSanityViolation message to its CLASS, for use as a dedupe
 * fingerprint. The message embeds live NAV figures, so fingerprinting on the
 * message itself would change every run and defeat the dedupe entirely.
 */
function navViolationClass(reason: string): string {
  if (reason.includes('non-positive/NaN')) return 'nav-nan';
  if (reason.includes('below floor')) return 'nav-floor';
  if (reason.includes('moved')) return 'nav-move';
  return 'nav-other';
}

async function run(): Promise<void> {
  log('Portfolio strategy analysis starting', AGENT);
  validateTargets();
  await connect();
  requestDelayedData();

  try {
    const account = await getAccountSummary();
    const symbols = TARGET_PORTFOLIO.map(t => t.symbol);
    const prices = await getMarketPrices(symbols);

    // Prices are USD; the account is AUD-base. Size and weight everything in
    // USD so `shares*price` (USD) and NAV/cash share one currency — otherwise
    // weights and order quantities are skewed by the AUD/USD rate (~1.44x).
    // See getUsdBalances / execution risk register.
    const usd = await getUsdBalances();
    const navUsd = usd.usdNav;
    const cashUsd = usd.usdCash;

    log(`NAV(USD): $${navUsd.toFixed(2)}, Cash(USD): $${cashUsd.toFixed(2)} [base AUD NAV $${account.netLiquidation.toFixed(2)}]`, AGENT);

    const state = loadState();
    const historicalReturns = state.historicalReturns as number[][] | undefined;

    // ── Market-data sanity gate ──────────────────────────────────────────
    // A garbled bezant read (zeroed NAV, a 100x-low price tick) must NOT be
    // turned into orders — that is how a full liquidation or a huge share
    // quantity gets queued. If the data looks suspect, log/alert and bail
    // WITHOUT touching pendingOrders (the prior queue stays untouched).
    const lastNavUsd = state.lastNavUsd as number | undefined;
    const navBad = navSanityViolation(navUsd, lastNavUsd, config.dataSanity);
    if (navBad) {
      log(`SUSPECT NAV — skipping order generation: ${navBad}`, AGENT);
      mergeState({ lastStrategyAt: new Date().toISOString() });
      // NOTE: this path deliberately does NOT advance lastNavUsd (the price
      // path below does). So the same comparison recurs every cycle and the
      // strategist stays skipped until a human intervenes — there is no
      // self-clearing path. That is arguably right for a suspect NAV, but it
      // means this alert is the ONLY signal you are wedged, so it must re-nag.
      //
      // Fingerprint on the violation CLASS, never the NAV value: NAV moves
      // every run, so a value-based fingerprint would never match and this
      // would fire on every single cycle instead of re-nagging on its ttl.
      await notify(
        {
          severity: 'warn',
          title: 'Strategist skipped — suspect NAV read',
          body:
            `${navBad}. No orders were generated and the existing queue is untouched. This does not clear on its ` +
            'own: the strategist will keep skipping until the NAV read is sane or the stored baseline is corrected.',
          fields: [
            { label: 'NAV', value: fmtUsd(navUsd) },
            { label: 'Baseline', value: lastNavUsd === undefined ? 'none' : fmtUsd(lastNavUsd) },
          ],
          agent: AGENT,
          dedupe: { key: 'strategist:nav-suspect', fingerprint: navViolationClass(navBad) },
        },
        storeHooks,
      );
      return;
    }
    // ── Market-data freshness gate ───────────────────────────────────────
    // Ordering matters: this runs BEFORE the price sanity check below, because
    // that check validates live quotes against `priceHistory`'s last element. If
    // the history is stale, the sanity check is comparing today's prices to old
    // ones — it stops being able to catch a bad tick exactly when it matters, and
    // would itself start firing spuriously on legitimate multi-day moves.
    const freshness = marketDataFreshness({
      lastQuantAt: state.lastQuantAt as string | undefined,
      priceHistoryDates: state.priceHistoryDates as string[] | undefined,
      now: new Date(),
      maxQuantAgeMs: config.dataSanity.maxQuantAgeMs,
      maxHistoryGapDays: config.dataSanity.maxHistoryGapDays,
    });
    if (!freshness.fresh) {
      log(`STALE MARKET DATA — skipping order generation: ${freshness.detail}`, AGENT);
      mergeState({ lastStrategyAt: new Date().toISOString() });
      await notify(
        {
          severity: 'warn',
          title: 'Strategist skipped — market data is stale',
          body:
            `${freshness.detail}. No orders were generated and the existing queue is untouched. ` +
            'Order sizing derives from quant-analyst\'s price history, so this blocks rather than ' +
            'trades on a frozen covariance matrix. Check that quant-analyst is still running.',
          fields: [
            { label: 'Reason', value: freshness.reason },
            { label: 'Last quant run', value: (state.lastQuantAt as string | undefined) ?? 'never' },
          ],
          agent: AGENT,
          // Fingerprint on the REASON, not the age: the age changes every run, so
          // a value-based fingerprint would never dedupe and this would alert on
          // every 4h cycle instead of re-nagging on its ttl.
          dedupe: { key: 'strategist:market-data-stale', fingerprint: freshness.reason },
        },
        storeHooks,
      );
      return;
    }

    const lastPrices = new Map<string, number>(
      Object.entries((state.priceHistory as Record<string, number[]> | undefined) ?? {})
        .map(([s, arr]) => [s, arr[arr.length - 1]])
        .filter(([, p]) => typeof p === 'number') as Array<[string, number]>,
    );
    const priceBad = priceSanityViolations(prices, lastPrices, config.dataSanity.maxPriceMovePct);
    if (priceBad.length > 0) {
      const detail = priceBad.map(b => `${b.symbol}(${b.reason})`).join(', ');
      log(`SUSPECT PRICES — skipping order generation: ${detail}`, AGENT);
      mergeState({ lastStrategyAt: new Date().toISOString(), lastNavUsd: navUsd });
      await notify(
        {
          severity: 'warn',
          title: `Strategist skipped — suspect prices on ${priceBad.length} symbol${priceBad.length === 1 ? '' : 's'}`,
          // `detail` is an unbounded join over every violating symbol — 17 of
          // them would be the likeliest thing in this system to breach Slack's
          // 3000-char section limit. The renderer truncates rather than letting
          // Slack 400 the whole post.
          body: detail,
          fields: [{ label: 'Symbols', value: priceBad.map(b => b.symbol).join(', ') }],
          agent: AGENT,
          // Fingerprint on WHICH symbols, not their prices — prices move every
          // run. Sorted so ordering churn isn't mistaken for a new condition.
          dedupe: {
            key: 'strategist:prices-suspect',
            fingerprint: priceBad.map(b => b.symbol).sort().join(','),
          },
        },
        storeHooks,
      );
      return;
    }

    // Compute target weights using shared module
    let targetWeights: number[] = TARGET_PORTFOLIO.map(t => t.pct / 100);
    let weightSource = 'static';

    // HRP / Risk Parity / Black-Litterman gate.
    //
    // The floor is the STABILITY floor, not a lower "minimum". It used to admit
    // 20 days and merely LOG anything under 60 as `thin` — a warning that went to
    // a log nobody reads while the weights it described moved a live book. On
    // 2026-08-18 that rebalanced the real account off a covariance matrix built
    // from ~6 calendar days of 4-hourly samples. Refusing is the safe direction:
    // the static model portfolio is a deliberate allocation, so falling back to
    // it is a real answer, not a degraded one.
    //
    // RANK_FLOOR is about ESTIMATION ERROR, not singularity. An earlier comment
    // here claimed the covariance matrix would be singular and its inverse
    // meaningless; that is wrong for the default optimizer. HRP never inverts the
    // matrix (it clusters the correlation matrix and weights on inverse VARIANCE,
    // i.e. the diagonal), and computeTargetWeights always applies Ledoit-Wolf
    // shrinkage toward a scaled identity, which is non-singular by construction.
    // Only black_litterman actually inverts. T = 2N is still a floor worth having
    // — it is far below the conventional T >= 10N rule of thumb — but it is a
    // backstop, not the binding constraint at default settings.
    const envInt = (name: string, fallback: number): number => {
      const raw = process.env[name];
      if (raw === undefined || raw === '') return fallback;
      const n = parseInt(raw, 10);
      // A typo used to poison the gate silently: HRP_MIN_DAYS defaults to
      // HRP_STABLE_DAYS, so one bad value made both NaN, and `>= NaN` is false
      // forever — disabling the optimizer permanently with no error.
      if (!Number.isFinite(n) || n < 0) {
        log(`${name}='${raw}' is not a valid day count — using ${fallback}`, AGENT);
        return fallback;
      }
      return n;
    };
    const HRP_STABLE_DAYS = envInt('HRP_STABLE_DAYS', 60);
    const HRP_MIN_DAYS = envInt('HRP_MIN_DAYS', HRP_STABLE_DAYS);
    const RANK_FLOOR = symbols.length * 2;
    const requiredDays = Math.max(HRP_MIN_DAYS, RANK_FLOOR);

    // The matrix dimension must match the symbol count, or targetWeightMap ends up
    // with `undefined` for the unmatched names and computeDrift returns NaN — which
    // decideRebalance reads as `within-threshold`, silently stopping drift-based
    // rebalancing. Reachable between adding a holding and the next quant run.
    const returnsMatchSymbols = historicalReturns?.length === symbols.length;
    const observations = historicalReturns?.[0]?.length ?? 0;

    if (config.strategy.optimizer === 'static') {
      // No estimate required, so no gate applies: the model portfolio IS the target.
      log(`Static model portfolio (${symbols.length} holdings) — optimizer disabled by config`, AGENT);
    } else if (historicalReturns && returnsMatchSymbols && symbols.length >= 2 && observations >= requiredDays) {
      const priceHistory = state.priceHistory as Record<string, number[]> | undefined;
      const priceArrays = priceHistory
        ? symbols.map(s => priceHistory[s] || [])
        : [];

      const result = computeTargetWeights(
        historicalReturns, symbols, priceArrays, config.strategy.optimizer,
      );
      targetWeights = result.weights;
      weightSource = result.source;

      // Do not hardcode the word: with HRP_MIN_DAYS overridden below the stability
      // floor this is the only signal that the estimate is still short.
      const stability = observations >= HRP_STABLE_DAYS
        ? 'stable'
        : `THIN — under the ${HRP_STABLE_DAYS}d stability floor`;
      log(`${weightSource} weights [${observations}d, ${stability}]:`, AGENT);
      symbols.forEach((s, i) => log(`  ${s}: ${(targetWeights[i] * 100).toFixed(1)}%`, AGENT));
    } else if (historicalReturns && !returnsMatchSymbols) {
      log(
        `Return matrix covers ${historicalReturns.length} assets but the portfolio has ` +
          `${symbols.length} — using static target weights until quant-analyst catches up.`,
        AGENT,
      );
    } else {
      const detail = RANK_FLOOR > HRP_MIN_DAYS
        ? `${observations}/${requiredDays} days (rank floor: ${symbols.length} assets need >=${RANK_FLOOR} observations)`
        : `${observations}/${requiredDays} days`;
      log(`Insufficient historical data — ${detail}. Using static target weights.`, AGENT);
    }

    // Apply regime exposure
    const regime = state.regime as { composite: RegimeState } | null;
    let exposureMultiplier = 1.0;
    if (regime && config.strategy.enableRegimeOverlay) {
      exposureMultiplier = regimeExposure(regime.composite);
      log(`Regime: ${regime.composite} → exposure ${(exposureMultiplier * 100).toFixed(0)}%`, AGENT);
    }

    // Apply the risk-manager's drawdown de-risking to order sizing, not just
    // the binary 'stopped' block in execution-bot. 'warning'→0.75, 'derisking'
    // →0.5, 'stopped'→0.0 shrink target weights so a rebalance during a
    // drawdown trims toward a smaller book instead of buying back to full size.
    const ddLevel = (state.drawdownLevel as DrawdownState['level'] | undefined) ?? 'normal';
    const ddMultiplier = drawdownExposureMultiplier(ddLevel);
    if (ddMultiplier < 1.0) {
      log(`Drawdown level '${ddLevel}' → exposure ${(ddMultiplier * 100).toFixed(0)}% (order sizing shrunk)`, AGENT);
    }

    const adjustedWeights = targetWeights.map(w => w * exposureMultiplier * ddMultiplier);

    // Build snapshot for shared drift/order logic — all USD.
    const nav = navUsd;
    const currentShares = new Map<string, number>();
    for (const sym of symbols) {
      const pos = account.positions.find((p: { symbol: string }) => p.symbol === sym);
      currentShares.set(sym, pos?.qty ?? 0);
    }
    const snapshot: PortfolioSnapshot = {
      symbols, prices, currentShares, nav,
      cash: cashUsd, peakNav: nav,
    };

    const targetWeightMap = new Map<string, number>();
    symbols.forEach((s, i) => targetWeightMap.set(s, adjustedWeights[i]));

    // Use shared drift calculation
    const maxDrift = computeDrift(snapshot, targetWeightMap);
    log(`Max drift: ${maxDrift.toFixed(1)}% (threshold: ${config.rebalance.driftThreshold}%)`, AGENT);

    for (let i = 0; i < symbols.length; i++) {
      const s = symbols[i];
      const shares = currentShares.get(s) ?? 0;
      const price = prices.get(s) ?? 0;
      const curPct = nav > 0 ? (shares * price / nav * 100) : 0;
      const tgtPct = adjustedWeights[i] * 100;
      const arrow = curPct < tgtPct - 1 ? '↑' : curPct > tgtPct + 1 ? '↓' : '=';
      log(`  ${s.padEnd(6)} ${curPct.toFixed(1).padStart(5)}% → ${tgtPct.toFixed(1).padStart(5)}% ${arrow}`, AGENT);
    }

    // Rebalance frequency gate
    const lastRebalance = state.lastRebalanceAt as string | undefined;
    const daysSince = lastRebalance
      ? (Date.now() - new Date(lastRebalance).getTime()) / (24 * 60 * 60 * 1000)
      : Infinity;

    let pendingOrders: Array<{ symbol: string; action: 'BUY' | 'SELL'; qty: number; estimatedValue: number; reason: string }> = [];

    // Build avgCost map for tax-aware loss-first SELL ordering. Positions
    // come back from IBKR with avgCost already populated.
    const avgCostsMap = new Map<string, number>();
    for (const p of account.positions) {
      avgCostsMap.set(p.symbol, p.avgCost);
    }

    // Active wash-sale entries (within 31 days of a loss-SELL). Drops
    // BUYs for those symbols in generateRebalanceOrders so we don't
    // undo a harvested loss within the ATO's wash-sale window. Expired
    // entries are pruned by the tax-optimizer agent; we filter here
    // again as a defence in depth.
    const allWashSales = ((state.washSales as Array<{ symbol: string; soldAt: string; expiresAt: string }> | undefined) ?? []);
    const activeWashSales = allWashSales.filter(w => new Date(w.expiresAt) > new Date());
    if (activeWashSales.length > 0) {
      log(`Active wash-sale entries: ${activeWashSales.map(w => w.symbol).join(', ')}`, AGENT);
    }

    const rebalanceOptions = {
      cashBufferPct: config.rebalance.cashBufferPct,
      fillMode: config.rebalance.fillMode,
      avgCosts: avgCostsMap,
      washSales: activeWashSales,
    };

    const decision = decideRebalance(maxDrift, daysSince, {
      driftThreshold: config.rebalance.driftThreshold,
      urgentDriftThreshold: config.rebalance.urgentDriftThreshold,
      frequencyDays: config.rebalance.frequencyDays,
    });

    // Hard-stop drawdown: do NOT generate orders. At 'stopped' the exposure
    // multiplier is 0, which would make every target weight 0 and turn a
    // rebalance into a full-portfolio LIQUIDATION queue — dangerous if the
    // level later relaxes and that stale queue executes. 'stopped' means
    // "halt + manual review" (execution-bot also blocks it), not "sell
    // everything". The de-risking multiplier still shrinks sizing for
    // 'warning'/'derisking'.
    if (ddLevel === 'stopped') {
      log('Drawdown level STOPPED — not generating rebalance orders (manual review)', AGENT);
    } else if (!isStrategistWindow()) {
      log(
        `Outside US RTH (${describeWindow(STRATEGIST_WINDOW)}) — analysis logged but no orders queued`,
        AGENT,
      );
    } else if (decision === 'urgent' || decision === 'regular') {
      const trigger = decision === 'urgent'
        ? `URGENT: drift ${maxDrift.toFixed(1)}% >= urgent threshold ${config.rebalance.urgentDriftThreshold}% (cooldown bypassed)`
        : `Rebalancing: drift ${maxDrift.toFixed(1)}% >= ${config.rebalance.driftThreshold}%`;
      log(trigger, AGENT);

      // Use shared order generation with cash buffer + fill mode + tax-aware sells
      const orders = generateRebalanceOrders(
        snapshot,
        targetWeightMap,
        weightSource,
        config.rebalance.minTradeUsd,
        rebalanceOptions,
      );
      pendingOrders = orders.map(o => ({
        symbol: o.symbol, action: o.action, qty: o.shares,
        estimatedValue: o.estimatedValue, reason: o.reason,
      }));

      if (pendingOrders.length > 0) {
        log(`Generated ${pendingOrders.length} rebalance orders (fillMode=${config.rebalance.fillMode}, cashBuffer=${config.rebalance.cashBufferPct}%):`, AGENT);
        for (const o of pendingOrders) {
          log(`  ${o.action} ${o.qty} ${o.symbol} ($${o.estimatedValue.toFixed(0)}) — ${o.reason}`, AGENT);
        }
      }
    } else if (decision === 'within-threshold') {
      log('Portfolio within drift threshold — no rebalance needed', AGENT);

      // Cash-flow rebalancing for deposits (USD cash — buys are USD).
      const CASH_THRESHOLD = 1000;
      if (cashUsd > CASH_THRESHOLD) {
        const holdings = TARGET_PORTFOLIO.map((t, i) => ({
          symbol: t.symbol,
          currentValue: (currentShares.get(t.symbol) ?? 0) * (prices.get(t.symbol) ?? 0),
          targetPct: adjustedWeights[i] * 100,
        }));

        const cashOrders = allocateCashFlow(holdings, cashUsd - CASH_THRESHOLD, 100, prices);
        for (const o of cashOrders) {
          log(`  Cash flow: BUY ${o.shares} ${o.symbol} ($${o.amountUsd.toFixed(2)})`, AGENT);
          pendingOrders.push({
            symbol: o.symbol, action: 'BUY', qty: o.shares,
            estimatedValue: o.amountUsd, reason: 'cash_flow_rebalance',
          });
        }
      }
    } else {
      log(`Drift ${maxDrift.toFixed(1)}% but only ${daysSince.toFixed(0)}d since last rebalance (min ${config.rebalance.frequencyDays}d)`, AGENT);
    }

    const updates: Record<string, unknown> = {
      // Key by what actually produced these weights. Writing {hrp: ...}
      // unconditionally meant a static fallback was stored under `hrp`, and
      // risk-manager could no longer tell optimizer output from the fallback.
      optimizedWeights: weightSource === 'static'
        ? { static: targetWeights, hrp: null }
        : { [weightSource]: targetWeights },
      lastStrategyAt: new Date().toISOString(),
      lastNavUsd: navUsd, // baseline for the next cycle's NAV-move sanity check
    };
    if (pendingOrders.length > 0) {
      updates.pendingOrders = pendingOrders;
      // Only a real rebalance restarts the frequencyDays cooldown. This used to
      // fire for ANY order, including cash_flow_rebalance — which is buy-only
      // (allocateCashFlow never sells). So a small cash deployment reset the
      // 45-day clock on the only mechanism that can SELL an overweight, and
      // because those buys grow the denominator they also push drift further
      // below the threshold that would have triggered the sell. An overweight
      // created by a bad rebalance could therefore become permanent, with the
      // fund quietly buying around it forever.
      if (decision === 'urgent' || decision === 'regular') {
        updates.lastRebalanceAt = new Date().toISOString();
      }
    }
    mergeState(updates);

  } finally {
    disconnect();
  }
  log('Portfolio strategy analysis complete', AGENT);
}

if (process.argv.includes('--once')) {
  run().then(() => process.exit(0)).catch(e => { logError('Fatal', e, AGENT); process.exit(1); });
}
