/**
 * Daily Summary — the post-close digest.
 *
 * This is where everything advisory lives. Real-time alerts are reserved for
 * things a human must act on now (hard stop, de-risk, ledger divergence); the
 * price movers, hedge suggestions and harvest candidates that used to be
 * log-only — or were slated to become their own interrupts — land here instead.
 * Three agents were building notification payloads and dropping them on the
 * floor; nothing read `marketAlerts`, `hedgeActions` or `harvestCandidates`
 * back. Now something does.
 *
 * Reads state only — no IBKR connection, no recomputation. Every field is
 * already persisted by the agent that computes it (risk-manager → stressTest /
 * drawdownLevel / navHistory, quant-analyst → factorRegression, execution-bot →
 * shortfallMetrics, managing-partner → lastSnapshot / lastNav / lastCash).
 * That makes this cheap enough to run on a timer with no gateway dependency.
 *
 * Trading-day scoped, in America/New_York — NOT the host's local date. The Pi
 * runs AEST, where the US close lands on the following local morning, so a
 * host-local date key would name the wrong session and could double-fire or
 * skip across the dateline.
 */
import { loadState, loadTradeHistory, type TradeRecord } from '../state/store.js';
import { notify, type NotifyField } from '../notify/slack.js';
import { storeHooks } from '../notify/store-hooks.js';
import { log, logError } from '../log.js';

const AGENT = 'DailySummary';

/** Sign OUTSIDE the symbol: `-$300`, not `$-300`. Realised P&L is often negative. */
const usd = (n: number): string =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/**
 * The US trading date for an instant, as YYYY-MM-DD.
 * `en-CA` yields ISO-ordered parts, so this needs no manual assembly.
 */
export function tradingDate(at: Date): string {
  return at.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Trades whose timestamp falls on the given US trading date. */
export function tradesOn(history: TradeRecord[], date: string): TradeRecord[] {
  return history.filter((t) => {
    if (!t.timestamp) return false;
    const d = new Date(t.timestamp);
    return !Number.isNaN(d.getTime()) && tradingDate(d) === date;
  });
}

interface Holding {
  symbol: string;
  sleeve?: string;
  targetPct: number;
  currentPct: number;
  currentValue: number;
}

/** Holdings furthest from target, worst first. */
function topDrift(holdings: Holding[], n: number): Holding[] {
  return [...holdings]
    .sort((a, b) => Math.abs(b.currentPct - b.targetPct) - Math.abs(a.currentPct - a.targetPct))
    .slice(0, n);
}

export function buildDigest(
  state: Record<string, unknown>,
  history: TradeRecord[],
  date: string,
): { title: string; body: string; fields: NotifyField[] } {
  const fills = tradesOn(history, date);
  const nav = state.lastNav as number | undefined;
  const cash = state.lastCash as number | undefined;
  const level = (state.drawdownLevel as string | undefined) ?? 'unknown';

  const navHistory = (state.navHistory as number[] | undefined) ?? [];
  const peak = navHistory.length ? Math.max(...navHistory) : undefined;
  const ddPct = peak && nav && peak > 0 ? ((peak - nav) / peak) * 100 : undefined;

  const fields: NotifyField[] = [];
  if (nav !== undefined) fields.push({ label: 'NAV', value: usd(nav) });
  if (cash !== undefined) fields.push({ label: 'Cash', value: usd(cash) });
  fields.push({
    label: 'Drawdown',
    value: ddPct !== undefined ? `${ddPct.toFixed(1)}% (${level})` : level,
  });

  // Realised P&L and execution cost are derived from the DAY'S TRADES, not from
  // state.shortfallMetrics — execution-bot overwrites that key each run rather
  // than accumulating, so it holds the last run's fills, not the day's.
  const realised = fills.reduce((s, t) => s + (t.realisedPnlUsd ?? 0), 0);
  if (fills.length) {
    fields.push({ label: 'Fills', value: String(fills.length) });
    const notional = fills.reduce((s, t) => s + Math.abs(t.estimatedValue ?? 0), 0);
    fields.push({ label: 'Traded', value: usd(notional) });
    if (fills.some((t) => t.realisedPnlUsd !== undefined)) {
      fields.push({ label: 'Realised P&L', value: `${realised > 0 ? '+' : ''}${usd(realised)}` });
    }
  }

  const stress = state.stressTest as { baselineVaR?: number; stressedVaR?: number } | undefined;
  if (stress?.baselineVaR !== undefined && stress?.stressedVaR !== undefined) {
    fields.push({
      label: 'VaR (base → stressed)',
      value: `${usd(stress.baselineVaR)} → ${usd(stress.stressedVaR)}`,
    });
  }

  const factor = state.factorRegression as { rSquared?: number; alpha?: number } | undefined;
  if (factor?.alpha !== undefined) {
    fields.push({
      label: 'Alpha',
      value: `${(factor.alpha * 10_000).toFixed(1)} bps/day (R² ${((factor.rSquared ?? 0) * 100).toFixed(0)}%)`,
    });
  }

  const body: string[] = [];

  if (fills.length) {
    body.push(
      '*Fills*\n' +
        fills
          .map((t) => {
            const px = t.fillPrice !== undefined ? ` @ $${t.fillPrice.toFixed(2)}` : '';
            const pnl =
              t.realisedPnlUsd !== undefined
                ? ` (${t.realisedPnlUsd > 0 ? '+' : ''}${usd(t.realisedPnlUsd)}${t.longTermHolding ? ', LT' : ''})`
                : '';
            return `• ${t.action} ${t.qty} ${t.symbol}${px}${pnl}`;
          })
          .join('\n'),
    );
  } else {
    body.push('_No fills._');
  }

  const holdings = (state.lastSnapshot as { holdings?: Holding[] } | undefined)?.holdings ?? [];
  if (holdings.length) {
    body.push(
      '*Drift (worst 5)*\n' +
        topDrift(holdings, 5)
          .map((h) => {
            const d = h.currentPct - h.targetPct;
            return `• ${h.symbol}: ${h.currentPct.toFixed(1)}% vs ${h.targetPct}% target (${d >= 0 ? '+' : ''}${d.toFixed(1)})`;
          })
          .join('\n'),
    );
  }

  const movers = (state.marketAlerts as string[] | undefined) ?? [];
  if (movers.length) body.push(`*Movers*\n${movers.map((m) => `• ${m}`).join('\n')}`);

  const harvest = (state.harvestCandidates as Array<{ symbol?: string; loss?: number }> | undefined) ?? [];
  if (harvest.length) {
    body.push(
      '*Tax-loss harvest candidates*\n' +
        harvest
          .map((c) => `• ${c.symbol ?? '?'}${c.loss !== undefined ? ` — ${usd(Math.abs(c.loss))} loss` : ''}`)
          .join('\n'),
    );
  }

  const hedges = (state.hedgeActions as Array<{ hedgeType?: string; symbol?: string }> | undefined) ?? [];
  if (hedges.length) {
    body.push(
      '*Hedge suggestions*\n' + hedges.map((h) => `• ${h.hedgeType ?? 'hedge'} ${h.symbol ?? ''}`.trim()).join('\n'),
    );
  }

  const pnlSuffix =
    fills.length && fills.some((t) => t.realisedPnlUsd !== undefined)
      ? ` · ${realised > 0 ? '+' : ''}${usd(realised)} realised`
      : '';

  return {
    title: `Daily summary ${date} — ${nav !== undefined ? usd(nav) : 'NAV unknown'}${pnlSuffix}`,
    body: body.join('\n\n'),
    fields,
  };
}

export async function run(): Promise<void> {
  log('Building daily summary', AGENT);

  const state = loadState() as Record<string, unknown>;
  const date = tradingDate(new Date());
  const digest = buildDigest(state, loadTradeHistory(), date);

  await notify(
    {
      severity: 'info',
      title: digest.title,
      body: digest.body,
      fields: digest.fields,
      agent: AGENT,
      // Once per trading day, ever. The date IS the identity, so there is
      // nothing to re-nag about — hence no ttl.
      dedupe: { key: `digest:${date}`, ttlMs: Infinity },
    },
    storeHooks,
  );

  log(`Daily summary sent for ${date}`, AGENT);
}

if (process.argv.includes('--once')) {
  run().then(() => process.exit(0)).catch(e => { logError('Fatal', e, AGENT); process.exit(1); });
}
