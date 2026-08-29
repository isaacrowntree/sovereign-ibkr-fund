/**
 * Risk Manager
 * VaR/CVaR, drawdown control, volatility targeting, correlation monitoring.
 */
import { connect, disconnect, getAccountSummary, getMarketPrices , requestDelayedData } from '../connection/gateway.js';
import { TARGET_PORTFOLIO, config } from '../config.js';
import { historicalVaR, conditionalVaR } from '../risk/var.js';
import { assessDrawdown, maxDrawdown, type DrawdownLimits, type DrawdownState } from '../risk/drawdown.js';
import { ewmaVolatility, annualizeVol, volTargetLeverage } from '../risk/volatility.js';
import { correlationStressTest } from '../risk/stress-test.js';
import { sampleCovMatrix } from '../portfolio/covariance.js';
import { marketDate } from '../quant/price-history.js';
import { computeIntradayDrawdownFromEvents } from '../observability/intraday-pnl.js';
import { loadState, mergeState, loadObservedEvents, type ObservedEventState } from '../state/store.js';
import { notify } from '../notify/slack.js';
import { storeHooks } from '../notify/store-hooks.js';
import { log, logError } from '../log.js';

const AGENT = 'RiskManager';

/**
 * One dedupe key for the whole drawdown ladder, fingerprinted on the level.
 * Sharing the key across levels is what makes every transition — including the
 * recovery back to normal — a change rather than a separate always-fires alert.
 */
const DD_KEY = 'risk:drawdown-level';

const usd = (n: number): string => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** Order drawdown levels by severity and return the worse of two. */
const DD_RANK: Record<DrawdownState['level'], number> = { normal: 0, warning: 1, derisking: 2, stopped: 3 };
function worseDrawdownLevel(a: DrawdownState['level'], b: DrawdownState['level']): DrawdownState['level'] {
  return DD_RANK[a] >= DD_RANK[b] ? a : b;
}
const TARGET_VOL = config.risk.targetVol;
const DD_LIMITS: DrawdownLimits = {
  warningPct: config.risk.drawdownWarningPct,
  deriskPct: config.risk.drawdownDeriskPct,
  hardStopPct: config.risk.drawdownHardStopPct,
};

export async function run(): Promise<void> {
  log('Risk assessment starting', AGENT);
  await connect();
  requestDelayedData();

  try {
    const account = await getAccountSummary();
    const symbols = TARGET_PORTFOLIO.map(t => t.symbol);
    const prices = await getMarketPrices(symbols);

    const state = loadState();
    // Set only when the stress test is genuinely recomputed this run.
    let stressComputedAt: string | null = null;
    let navHistory = (state.navHistory || []) as number[];
    // Read before we overwrite it below — the recovery alert needs to know what
    // we're recovering FROM.
    const previousLevel = state.drawdownLevel as DrawdownState['level'] | undefined;

    // Phantom-drawdown guard: if the historical peak is implausibly higher
    // than current NAV (>3x), the most plausible explanation is a capital
    // withdrawal — not a market drawdown — so the legacy peak is meaningless
    // for risk gating. Drop history older than the discontinuity and rebuild
    // peak from the current account state.
    let phantomReset: { oldPeak: number; nav: number } | null = null;
    if (navHistory.length > 0) {
      const oldPeak = Math.max(...navHistory);
      if (oldPeak > account.netLiquidation * 3) {
        log(
          `Phantom drawdown detected (oldPeak=$${oldPeak.toFixed(0)}, currentNAV=$${account.netLiquidation.toFixed(0)}); resetting navHistory — likely a capital withdrawal.`,
          AGENT,
        );
        phantomReset = { oldPeak, nav: account.netLiquidation };
        navHistory = [];
      }
    }

    // ONE SAMPLE PER TRADING DAY. This was `navHistory.push(...)` on every run —
    // the identical run-vs-day conflation fixed in src/quant/price-history.ts, and
    // missed here when that fix went in. At a 4h cadence it oversampled ~6x, so
    // annualizeVol()'s sqrt(252) at :103 understated annualized vol by ~sqrt(6)
    // (the live DB read realizedVol 4.35% for a 17-name single-stock book).
    //
    // The 500-entry cap made it worse than a reporting bug: at 6 samples/day it
    // was a rolling ~83-day window, so `peak` below FORGOT any high-water mark
    // older than that and the drawdown ladder under-triggered in a slow bear
    // market. At one sample per day the same cap is ~2 years.
    const navDate = marketDate();
    const navDates = (state.navHistoryDates || []) as string[];
    let dates = phantomReset ? [] : [...navDates];
    if (navDate !== null) {
      if (dates[dates.length - 1] !== navDate || navHistory.length === 0) {
        navHistory.push(account.netLiquidation);
        dates.push(navDate);
      } else {
        navHistory[navHistory.length - 1] = account.netLiquidation;
      }
    } else if (navHistory.length === 0) {
      // Weekend with no history at all — seed one point so the peak exists.
      navHistory.push(account.netLiquidation);
    }
    if (navHistory.length > 500) navHistory.splice(0, navHistory.length - 500);
    if (dates.length > 500) dates = dates.slice(-500);

    log(`NAV: $${account.netLiquidation.toFixed(2)}`, AGENT);

    // Drawdown
    const peak = Math.max(...navHistory);
    const dd = assessDrawdown(account.netLiquidation, peak, DD_LIMITS);
    log(`Drawdown: ${dd.drawdownPct.toFixed(2)}% (${dd.level}) | Peak: $${dd.peak.toFixed(2)}`, AGENT);
    // Effective level starts from the snapshot; the intraday WS block below may
    // escalate it if a sharp mid-session drop is worse than the agent-cadence
    // snapshots see. This is what actually gates execution.
    let effectiveLevel = dd.level;

    // Max drawdown
    if (navHistory.length >= 10) {
      const mdd = maxDrawdown(navHistory);
      log(`Max drawdown (history): ${mdd.toFixed(2)}%`, AGENT);
    }

    // VaR from NAV returns
    if (navHistory.length >= 20) {
      const returns = navHistory.slice(1).map((v, i) => (v - navHistory[i]) / navHistory[i]);
      const var95 = historicalVaR(returns, 0.95);
      const cvar95 = conditionalVaR(returns, 0.95);
      log(`VaR(95%): ${(var95 * 100).toFixed(2)}% | CVaR(95%): ${(cvar95 * 100).toFixed(2)}%`, AGENT);

      // Volatility-target leverage — TELEMETRY ONLY. Nothing reads this back
      // into sizing: the strategist's exposure is regimeExposure × drawdown
      // multiplier, deliberately (see config.strategy.enableVolTargeting).
      // Logged so a vol spike is visible in the run feed, not so it acts.
      const vol = ewmaVolatility(returns.slice(-60));
      const annVol = annualizeVol(vol);
      const leverage = volTargetLeverage(annVol, TARGET_VOL, config.risk.maxLeverage);
      log(`Realized vol: ${(annVol * 100).toFixed(1)}% | Target: ${(TARGET_VOL * 100).toFixed(0)}% | Leverage: ${leverage.toFixed(2)}x`, AGENT);

      state.riskMetrics = {
        drawdown: dd,
        var95: var95 * 100,
        cvar95: cvar95 * 100,
        realizedVol: annVol * 100,
        volTargetLeverage: leverage,
      };

      // Correlation stress test using portfolio weights and covariance
      const historicalReturns = state.historicalReturns as number[][] | undefined;
      // Keyed by weightSource since 2026-08-19, so `static` appears here when the
      // optimizer is gated off. Stress the weights the fund is ACTUALLY targeting
      // — a static book is just as stressable, and reading only `hrp` meant the
      // test silently stopped running whenever the gate closed.
      // Prefer HRP — backtest shows Risk Parity degenerates with high vol dispersion
      const optimizedWeights = state.optimizedWeights as
        { hrp?: number[] | null; riskParity?: number[] | null; static?: number[] | null } | undefined;
      const weights = optimizedWeights?.hrp || optimizedWeights?.riskParity || optimizedWeights?.static;

      // `historicalReturns.length` is the ASSET count, not the observation count —
      // this used to build a 17x17 covariance from 3 observations, exactly the
      // input portfolio-strategist now refuses.
      const stressObs = historicalReturns?.[0]?.length ?? 0;
      const STRESS_MIN_OBS = Math.max(30, symbols.length * 2);

      if (historicalReturns && historicalReturns.length >= 2 && stressObs >= STRESS_MIN_OBS && weights) {
        const cov = sampleCovMatrix(historicalReturns);
        const stress = correlationStressTest(weights, cov, account.netLiquidation);
        log(`Stress test: baseline VaR $${stress.baselineVaR.toFixed(2)} → stressed VaR $${stress.stressedVaR.toFixed(2)} (corr=0.9)`, AGENT);
        state.stressTest = {
          baselineVol: stress.baselineVol,
          stressedVol: stress.stressedVol,
          baselineVaR: stress.baselineVaR,
          stressedVaR: stress.stressedVaR,
          portfolioValue: stress.portfolioValue,
          timestamp: (stressComputedAt = new Date().toISOString()),
        };
      }
    }

    // WS-derived intraday drawdown enrichment. Only used when the
    // observer agent has been populating state.observedEvents — when
    // empty, we fall back to the snapshot-based DD above.
    // Rows now, and only the topic this needs — previously it deserialised the
    // entire 1.3MB history to filter for 'pnl'.
    const observed = loadObservedEvents({ topic: 'pnl' });
    if (observed.length > 0) {
      const sessionStart = new Date();
      sessionStart.setUTCHours(13, 30, 0, 0); // 09:30 ET as a reasonable session anchor
      const intraday = computeIntradayDrawdownFromEvents(
        observed
          .filter((e) => e.topic === 'pnl')
          .map((e) => ({
            cursor: e.cursor,
            topic: e.topic,
            receivedAt: e.receivedAt,
            resetEpoch: e.resetEpoch,
            payload: e.payload as Record<string, unknown>,
          })),
        peak,
        { sessionStartedAt: sessionStart.toISOString() },
      );
      if (intraday.samples > 0) {
        log(
          `Intraday DD (WS): ${intraday.drawdownPct.toFixed(2)}% over ${intraday.samples} samples ` +
            `(peak=$${intraday.peakNav.toFixed(2)} trough=$${intraday.troughNav.toFixed(2)})`,
          AGENT,
        );
        // Escalate the effective drawdown level from the intraday trough, so
        // a sharp mid-session drop actually triggers the gate instead of only
        // being logged (a snapshot between agent runs can miss the trough).
        const intradayLevel = assessDrawdown(
          intraday.troughNav,
          Math.max(peak, intraday.peakNav),
          DD_LIMITS,
        ).level;
        effectiveLevel = worseDrawdownLevel(effectiveLevel, intradayLevel);
        if (intraday.drawdownPct > dd.drawdownPct + 0.5) {
          log(
            `Intraday WS-DD ${intraday.drawdownPct.toFixed(2)}% worse than snapshot DD ` +
              `${dd.drawdownPct.toFixed(2)}% → effective level ${effectiveLevel}`,
            AGENT,
          );
        }
        const updatesIntraday: Record<string, unknown> = {
          intradayDrawdown: {
            peakNav: intraday.peakNav,
            troughNav: intraday.troughNav,
            drawdownPct: intraday.drawdownPct,
            samples: intraday.samples,
          },
        };
        mergeState(updatesIntraday);
      }
    }

    // Fix #7: Persist the EFFECTIVE drawdown level (snapshot ⊔ intraday) so the
    // execution bot can enforce it.
    //
    // This MUST happen before any notification. The gate is enforced by
    // execution-bot reading `drawdownLevel`/`lastRiskAt` from state; if an
    // alert throws first, this write is skipped, and because RISK_STALE_MS (5h)
    // exceeds the agent cadence (4h) the staleness fail-safe does NOT fire —
    // execution-bot reads a stale `normal` and trades a drawdown book. Gate
    // state must never be downstream of an I/O call.
    const updates: Record<string, unknown> = {
      drawdownLevel: effectiveLevel,
      navHistory,
      lastRiskAt: new Date().toISOString(),
    };
    updates.navHistoryDates = dates;
    if (state.riskMetrics) updates.riskMetrics = state.riskMetrics;
    // Carry a stressTest forward only if it was recomputed THIS run; otherwise
    // CLEAR it. It used to be re-persisted unconditionally, and since its gate
    // requires historicalReturns (null while the optimizer is gated off) it could
    // never self-correct — the daily Slack digest kept reporting VaR derived from
    // the bad 2026-08-18 run. Explicit null matters: mergeState is a per-key
    // upsert, so simply omitting the key leaves the stale row in place forever.
    // daily-summary.ts:108 checks the fields, so null drops the line entirely —
    // no number is better than a wrong one.
    updates.stressTest =
      state.stressTest && (state.stressTest as { timestamp?: string }).timestamp === stressComputedAt
        ? state.stressTest
        : null;
    mergeState(updates);

    // A capital withdrawal silently wipes NAV history and rebuilds the peak —
    // that resets the drawdown baseline, so it must not be a log-only event.
    // Fingerprinted on the CLASS, not the NAV: NAV moves every run, so a
    // value-based fingerprint would never match and this would alert on every
    // cycle forever.
    if (phantomReset) {
      await notify(
        {
          severity: 'warn',
          title: 'NAV history reset — suspected capital withdrawal',
          body:
            'The historical peak was implausibly far above current NAV, so the drawdown baseline has been rebuilt ' +
            'from the current account state. If this was NOT a withdrawal, the drawdown gate is now measuring from ' +
            'the wrong peak.',
          fields: [
            { label: 'Old peak', value: usd(phantomReset.oldPeak) },
            { label: 'Current NAV', value: usd(phantomReset.nav) },
          ],
          agent: AGENT,
          dedupe: { key: 'risk:phantom-drawdown', fingerprint: 'nav-reset' },
        },
        storeHooks,
      );
    }

    // Drawdown level. Fingerprinted on the level itself, so this alerts on
    // TRANSITIONS (normal → warning → derisking → stopped) rather than on every
    // run, and re-nags only once the ttl lapses on a stuck condition.
    const ddFields = [
      { label: 'Drawdown', value: `${dd.drawdownPct.toFixed(1)}%` },
      { label: 'Peak NAV', value: usd(dd.peak) },
      { label: 'Current NAV', value: usd(account.netLiquidation) },
    ];

    if (effectiveLevel === 'stopped') {
      log('HARD STOP: Portfolio drawdown exceeds limit', AGENT);
      await notify(
        {
          severity: 'critical',
          title: `HARD STOP — drawdown ${dd.drawdownPct.toFixed(1)}% (limit ${DD_LIMITS.hardStopPct}%)`,
          // NOT "manual review required": assessDrawdown recomputes the level
          // from navHistory every run, so the stop CLEARS ITSELF once NAV
          // recovers. Nothing waits for a human. Saying otherwise sends you
          // looking for a button that doesn't exist.
          body:
            'Execution is blocked and the pending queue has been cleared. This gate re-evaluates every run and ' +
            'lifts on its own if NAV recovers — you will get a recovery alert if it does.',
          fields: ddFields,
          agent: AGENT,
          dedupe: { key: DD_KEY, fingerprint: effectiveLevel },
        },
        storeHooks,
      );
    } else if (effectiveLevel === 'derisking') {
      log('DE-RISKING: Reducing exposure to 50%', AGENT);
      await notify(
        {
          severity: 'warn',
          title: `DE-RISKING — drawdown ${dd.drawdownPct.toFixed(1)}% (limit ${DD_LIMITS.deriskPct}%)`,
          body: 'Exposure cut to 50%.',
          fields: ddFields,
          agent: AGENT,
          dedupe: { key: DD_KEY, fingerprint: effectiveLevel },
        },
        storeHooks,
      );
    } else if (effectiveLevel === 'warning') {
      // Previously log-only, which meant the FIRST threshold you cross was
      // silent and you only heard at the de-risk level.
      log('WARNING: Tightening risk limits', AGENT);
      await notify(
        {
          severity: 'warn',
          title: `Drawdown warning — ${dd.drawdownPct.toFixed(1)}% (limit ${DD_LIMITS.warningPct}%)`,
          body: 'Risk limits tightened. Execution is still permitted.',
          fields: ddFields,
          agent: AGENT,
          dedupe: { key: DD_KEY, fingerprint: effectiveLevel },
        },
        storeHooks,
      );
    } else if (previousLevel && previousLevel !== 'normal') {
      // Recovery. The gate lifting is the counterpart to the alert that raised
      // it — without this you are told trading stopped and never told it resumed.
      await notify(
        {
          severity: 'recovery',
          title: `Drawdown recovered to normal — ${dd.drawdownPct.toFixed(1)}%`,
          body: `Was ${previousLevel}. Execution is unblocked.`,
          fields: ddFields,
          agent: AGENT,
          dedupe: { key: DD_KEY, fingerprint: effectiveLevel },
        },
        storeHooks,
      );
    }

  } finally {
    disconnect();
  }
  log('Risk assessment complete', AGENT);
}

if (process.argv.includes('--once')) {
  run().then(() => process.exit(0)).catch(e => { logError('Fatal', e, AGENT); process.exit(1); });
}
