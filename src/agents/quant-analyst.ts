/**
 * Quant Analyst
 * Generates factor signals, detects market regime, feeds data to the strategist.
 */
import { connect, disconnect, getMarketPrices , requestDelayedData } from '../connection/gateway.js';
import { TARGET_PORTFOLIO } from '../config.js';
import { trendSignal, trendStrengthSignal, momentumBreadthSignal, volRegimeSignal, volExpansionSignal, correlationSignal, compositeRegime } from '../quant/regime.js';
import { realizedVolatility, annualizeVol } from '../risk/volatility.js';
import { sampleCovMatrix, covToCorr } from '../portfolio/covariance.js';
import { olsRegression } from '../quant/regression.js';
import { loadState, mergeState } from '../state/store.js';
import { log, logError } from '../log.js';

const AGENT = 'QuantAnalyst';

async function run(): Promise<void> {
  log('Quant analysis starting', AGENT);
  await connect();
  requestDelayedData();

  try {
    const symbols = TARGET_PORTFOLIO.map(t => t.symbol);
    const prices = await getMarketPrices(symbols);

    const state = loadState();
    const priceHistory = (state.priceHistory || {}) as Record<string, number[]>;

    // Update price history
    for (const [sym, price] of prices) {
      if (!priceHistory[sym]) priceHistory[sym] = [];
      priceHistory[sym].push(price);
      if (priceHistory[sym].length > 500) priceHistory[sym] = priceHistory[sym].slice(-500); // ~2yr at daily
    }

    // Compute regime signals from portfolio-wide average (not single proxy)
    const symbolsWithHistory = symbols.filter(s => (priceHistory[s] || []).length >= 200);

    let regime;
    if (symbolsWithHistory.length > 0) {
      // Build average price series across all symbols with sufficient history
      const minLen = Math.min(...symbolsWithHistory.map(s => priceHistory[s].length));
      const avgPrices: number[] = [];
      for (let i = 0; i < minLen; i++) {
        let sum = 0;
        for (const s of symbolsWithHistory) sum += priceHistory[s][priceHistory[s].length - minLen + i];
        avgPrices.push(sum / symbolsWithHistory.length);
      }

      const trend = trendSignal(avgPrices);

      // Per-stock ADX breadth (close-only — IBKR gateway doesn't provide OHLC history)
      const perStockPrices = symbolsWithHistory.map(s => priceHistory[s].slice(-250));
      const ts = trendStrengthSignal(perStockPrices);

      // Momentum breadth: % of stocks above 50-day MA
      const mom = momentumBreadthSignal(perStockPrices);

      const returns = avgPrices.slice(1).map((p, i) => (p - avgPrices[i]) / avgPrices[i]);
      const vol = annualizeVol(realizedVolatility(returns.slice(-60)));
      const volSignal = volRegimeSignal(vol * 100);
      const ve = volExpansionSignal(returns);

      // Correlation signal from covariance matrix
      const historicalReturns = state.historicalReturns as number[][] | undefined;
      let corrSignal: 1 | 0 | -1 = 0;
      if (historicalReturns && historicalReturns.length >= 2) {
        const cov = sampleCovMatrix(historicalReturns);
        if (cov.length > 0) corrSignal = correlationSignal(covToCorr(cov));
      }

      regime = compositeRegime({ trend, trendStrength: ts, momentum: mom, volatility: volSignal, volExpansion: ve, correlation: corrSignal });
      log(`Regime: ${regime.composite} (score: ${regime.score}) [${symbolsWithHistory.length} symbols]`, AGENT);
      log(`  Trend: ${trend}, Strength: ${ts}, Momentum: ${mom}, Vol: ${volSignal}, VolExp: ${ve}, Corr: ${corrSignal}`, AGENT);
    } else {
      const maxLen = Math.max(0, ...symbols.map(s => (priceHistory[s] || []).length));
      log(`Insufficient price history (${maxLen}/200 days) — regime unknown`, AGENT);
    }

    // Factor regression: build returns from price history and run OLS
    const MIN_REGRESSION_OBS = 30;
    const allSymbolReturns: Record<string, number[]> = {};
    for (const sym of symbols) {
      const ph = priceHistory[sym] || [];
      if (ph.length >= MIN_REGRESSION_OBS + 1) {
        allSymbolReturns[sym] = ph.slice(1).map((p, i) => (p - ph[i]) / ph[i]);
      }
    }

    // Use first symbol as dependent (portfolio proxy), rest as factors
    if (symbols.length >= 2 && allSymbolReturns[symbols[0]]) {
      const dependentReturns = allSymbolReturns[symbols[0]];
      const factorSymbols = symbols.slice(1).filter(s => allSymbolReturns[s]);

      if (factorSymbols.length > 0) {
        // Align lengths to shortest series
        const minLen = Math.min(dependentReturns.length, ...factorSymbols.map(s => allSymbolReturns[s].length));

        if (minLen > factorSymbols.length + 1) {
          const y = dependentReturns.slice(-minLen);
          const X = Array.from({ length: minLen }, (_, i) =>
            factorSymbols.map(s => allSymbolReturns[s].slice(-minLen)[i])
          );

          try {
            const reg = olsRegression(y, X, factorSymbols);
            log(`Factor regression (${symbols[0]} ~ ${factorSymbols.join(' + ')}):`, AGENT);
            log(`  Alpha: ${(reg.alpha * 10000).toFixed(2)} bps/day | R²: ${(reg.rSquared * 100).toFixed(1)}%`, AGENT);
            factorSymbols.forEach((s, i) => {
              log(`  Beta(${s}): ${reg.betas[i].toFixed(3)} (t=${reg.tStatistics[i + 1].toFixed(2)})`, AGENT);
            });

            state.factorRegression = {
              dependent: symbols[0],
              factors: factorSymbols,
              alpha: reg.alpha,
              betas: reg.betas,
              rSquared: reg.rSquared,
              adjustedRSquared: reg.adjustedRSquared,
              tStatistics: reg.tStatistics,
            };
          } catch (err) {
            log(`Factor regression skipped: ${err instanceof Error ? err.message : String(err)}`, AGENT);
          }
        }
      }
    }

    // Build historicalReturns matrix for Portfolio Strategist and Risk Manager.
    // Shape: returns[asset_index][time_index] — each row is one asset's return series.
    // This matches sampleCovMatrix() which expects "each row = asset, each col = time".
    const minLen = Math.min(...symbols.map(s => (priceHistory[s] || []).length));
    let historicalReturns: number[][] | undefined;
    if (minLen >= 3) {
      historicalReturns = symbols.map(s => {
        const ph = priceHistory[s];
        const returns: number[] = [];
        for (let i = 1; i < minLen; i++) {
          returns.push((ph[i] - ph[i - 1]) / ph[i - 1]);
        }
        return returns;
      });
    }

    mergeState({
      priceHistory,
      regime: regime || null,
      historicalReturns: historicalReturns || null,
      ...(state.factorRegression ? { factorRegression: state.factorRegression } : {}),
      lastQuantAt: new Date().toISOString(),
    });

  } finally {
    disconnect();
  }
  log('Quant analysis complete', AGENT);
}

if (process.argv.includes('--once')) {
  run().then(() => process.exit(0)).catch(e => { logError('Fatal', e, AGENT); process.exit(1); });
}
