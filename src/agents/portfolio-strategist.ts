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
import { navSanityViolation, priceSanityViolations } from '../risk/data-sanity.js';
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

    // HRP / Risk Parity / Black-Litterman gate. Minimum of 20 days (set down
    // from 30 to let the algorithm fire sooner — when symbols are recently
    // added, accumulating 30 days takes a full month). Below 60 we emit a
    // visibility warning since covariance estimates on short windows are
    // unstable. Proper fix: pre-seed price history from IBKR historical
    // bars. Tracked separately.
    const HRP_MIN_DAYS = parseInt(process.env.HRP_MIN_DAYS || '20', 10);
    const HRP_STABLE_DAYS = parseInt(process.env.HRP_STABLE_DAYS || '60', 10);

    if (historicalReturns && historicalReturns.length >= 2 && historicalReturns[0].length >= HRP_MIN_DAYS) {
      const priceHistory = state.priceHistory as Record<string, number[]> | undefined;
      const priceArrays = priceHistory
        ? symbols.map(s => priceHistory[s] || [])
        : [];

      const result = computeTargetWeights(
        historicalReturns, symbols, priceArrays, config.strategy.optimizer,
      );
      targetWeights = result.weights;
      weightSource = result.source;

      const days = historicalReturns[0].length;
      const stability = days >= HRP_STABLE_DAYS
        ? 'stable'
        : `thin (only ${days}d, recommend >=${HRP_STABLE_DAYS}d for stable covariance)`;
      log(`${weightSource} weights [${stability}]:`, AGENT);
      symbols.forEach((s, i) => log(`  ${s}: ${(targetWeights[i] * 100).toFixed(1)}%`, AGENT));
    } else {
      const haveDays = historicalReturns?.[0]?.length ?? 0;
      log(`Insufficient historical data (${haveDays}/${HRP_MIN_DAYS} days) — using static target weights`, AGENT);
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
      optimizedWeights: { hrp: targetWeights },
      lastStrategyAt: new Date().toISOString(),
      lastNavUsd: navUsd, // baseline for the next cycle's NAV-move sanity check
    };
    if (pendingOrders.length > 0) {
      updates.pendingOrders = pendingOrders;
      updates.lastRebalanceAt = new Date().toISOString();
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
