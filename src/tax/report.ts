/**
 * Australian tax report for the fund, per financial year, in AUD.
 *
 * What it contains, and what it deliberately does not:
 *
 *   - CGT schedule: every disposal parcel from the lot engine (lots.ts), with
 *     cost base and capital proceeds in AUD at IBKR's per-trade rates, the
 *     exchange trade date as the CGT event date, and the discount test.
 *   - Discount gains, non-discount gains and losses SEPARATELY — they are what
 *     the return asks for — then a net capital gain per s102-5 using any
 *     carried-forward losses supplied. That net figure is INDICATIVE: the
 *     owner's other CGT events belong in the same calculation.
 *   - Dividends: gross, US withholding, net, in AUD at the payment-date rate,
 *     and the foreign income tax offset figure.
 *   - Division 775 (forex): the RECORDS only — each AUD<->USD conversion and
 *     the AUD value of each USD spend. No gain or loss is computed; that needs
 *     an election and a method the accountant chooses.
 *   - Everything split by beneficial owner (owners.ts).
 *
 * Commission is inside the cost base and proceeds; it is shown once, as an
 * "included" figure, never deducted again (the old report listed it beside
 * totals that already contained it).
 */
import type { TradeRecord } from '../state/store.js';
import { loadTradeHistory } from '../state/store.js';
import { runLotEngine, type Disposal, type FxFallback } from './lots.js';
import { computeNetCapitalGain, type NetCapitalGainResult } from './net-capital-gain.js';
import { financialYearBounds, financialYearOf, tradeDateOf } from './au-dates.js';
import { DEFAULT_OWNER_SHARES, ownershipStatement, type AccountRegistration, type OwnerShare } from './owners.js';
import type { DividendRecord } from './dividends.js';
import type { FxConversion } from '../connection/ibkr-history.js';

export const INDICATIVE_LABEL = 'indicative — combine with your other CGT events';

export interface AuTaxReportInput {
  trades: TradeRecord[];
  /** Financial year label, e.g. "FY2026". */
  financialYear: string;
  dividends?: DividendRecord[];
  fxConversions?: FxConversion[];
  owners?: OwnerShare[];
  registration?: AccountRegistration;
  /** Net capital losses carried forward INTO this year, per owner name, AUD (from the lodged return). */
  carriedForwardLossesAud?: Record<string, number>;
  fxFallback?: FxFallback;
}

export interface CgtTotals {
  discountGains: number;
  nonDiscountGains: number;
  capitalLosses: number;
  capitalProceeds: number;
  costBase: number;
  /** Brokerage already INCLUDED in the cost base and proceeds above (USD). Informational. */
  brokerageIncludedUsd: number;
}

export interface OwnerSection {
  name: string;
  share: number;
  cgt: Omit<CgtTotals, 'brokerageIncludedUsd'>;
  carriedForwardLossesIn: number;
  net: NetCapitalGainResult;
  dividends: { grossAud: number; withholdingAud: number; netAud: number; foreignIncomeTaxOffsetAud: number };
}

export interface UsdSpend {
  date: string;
  symbol: string;
  usd: number;
  audPerUsd: number | null;
  aud: number | null;
}

export interface AuTaxReport {
  financialYear: string;
  period: { start: string; end: string };
  ownership: string;
  disposals: Disposal[];
  totals: CgtTotals;
  owners: OwnerSection[];
  dividends: DividendRecord[];
  div775: { conversions: FxConversion[]; usdSpends: UsdSpend[]; note: string };
  /** False when any disposal lacks an AUD figure — totals are then understated. */
  complete: boolean;
  issues: string[];
  notes: string[];
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

function cgtTotals(disposals: Disposal[]): CgtTotals {
  const t: CgtTotals = {
    discountGains: 0, nonDiscountGains: 0, capitalLosses: 0,
    capitalProceeds: 0, costBase: 0, brokerageIncludedUsd: 0,
  };
  for (const d of disposals) {
    if (d.gainAud == null || d.costAud == null || d.proceedsAud == null) continue;
    t.capitalProceeds += d.proceedsAud;
    t.costBase += d.costAud;
    if (d.gainAud > 0) {
      if (d.discountEligible) t.discountGains += d.gainAud;
      else t.nonDiscountGains += d.gainAud;
    } else {
      t.capitalLosses += -d.gainAud;
    }
  }
  // Brokerage per parcel, recovered from the records it came from.
  for (const d of disposals) {
    const b = d.buyRecord;
    const s = d.sellRecord;
    if (b.commission) t.brokerageIncludedUsd += (Math.abs(b.commission) * d.qty) / b.qty;
    if (s.commission) t.brokerageIncludedUsd += (Math.abs(s.commission) * d.qty) / s.qty;
  }
  return {
    discountGains: r2(t.discountGains), nonDiscountGains: r2(t.nonDiscountGains),
    capitalLosses: r2(t.capitalLosses), capitalProceeds: r2(t.capitalProceeds),
    costBase: r2(t.costBase), brokerageIncludedUsd: r2(t.brokerageIncludedUsd),
  };
}

export function buildAuTaxReport(input: AuTaxReportInput): AuTaxReport {
  const fy = input.financialYear;
  const period = financialYearBounds(fy);
  const owners = input.owners ?? DEFAULT_OWNER_SHARES;
  const registration = input.registration ?? 'individual';
  const engine = runLotEngine(input.trades, { fxFallback: input.fxFallback });

  const disposals = engine.disposals.filter((d) => d.financialYear === fy);
  const totals = cgtTotals(disposals);
  const dividends = (input.dividends ?? []).filter((d) => d.financialYear === fy);
  const divTotals = dividends.reduce(
    (s, d) => ({ grossAud: s.grossAud + d.grossAud, withholdingAud: s.withholdingAud + d.withholdingAud, netAud: s.netAud + d.netAud }),
    { grossAud: 0, withholdingAud: 0, netAud: 0 },
  );

  const ownerSections: OwnerSection[] = owners.map((o) => {
    const cgt = {
      discountGains: r2(totals.discountGains * o.share),
      nonDiscountGains: r2(totals.nonDiscountGains * o.share),
      capitalLosses: r2(totals.capitalLosses * o.share),
      capitalProceeds: r2(totals.capitalProceeds * o.share),
      costBase: r2(totals.costBase * o.share),
    };
    const cf = input.carriedForwardLossesAud?.[o.name] ?? 0;
    return {
      name: o.name,
      share: o.share,
      cgt,
      carriedForwardLossesIn: cf,
      net: computeNetCapitalGain(cgt, cf),
      dividends: {
        grossAud: r2(divTotals.grossAud * o.share),
        withholdingAud: r2(divTotals.withholdingAud * o.share),
        netAud: r2(divTotals.netAud * o.share),
        foreignIncomeTaxOffsetAud: r2(divTotals.withholdingAud * o.share),
      },
    };
  });
  const unknownCf = Object.keys(input.carriedForwardLossesAud ?? {}).filter((n) => !owners.some((o) => o.name === n));

  const inFy = (date: string | undefined) => !!date && date >= period.start && date <= period.end;
  const conversions = (input.fxConversions ?? []).filter((c) => inFy(c.tradeDate));
  const usdSpends: UsdSpend[] = input.trades
    .filter((t) => t.action === 'BUY' && inFy(tradeDateOf(t)))
    .map((t) => {
      const price = t.fillPrice && t.fillPrice > 0 ? t.fillPrice : t.estimatedValue / t.qty;
      const usd = r2(price * t.qty + Math.abs(t.commission ?? 0));
      const rate = t.audPerUsd && t.audPerUsd > 0 ? t.audPerUsd : null;
      return { date: tradeDateOf(t)!, symbol: t.symbol, usd, audPerUsd: rate, aud: rate ? r2(usd * rate) : null };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // Ledger-wide: an unmatched sale in any year means the parcels are wrong in every later one.
  const issues = [...engine.issues];
  const complete = disposals.every((d) => d.gainAud != null);
  if (!complete) issues.unshift('Some disposals have no AUD rate — CGT totals are INCOMPLETE until the ledger is annotated.');
  const estimated = disposals.filter((d) => d.flags.some((f) => /commission-estimated|commission-missing/.test(f)));
  if (estimated.length > 0) issues.push(`${estimated.length} disposal parcel(s) use estimated or missing brokerage.`);
  const inferred = disposals.filter((d) => d.flags.some((f) => /price-inferred|price-estimated/.test(f)));
  if (inferred.length > 0) issues.push(`${inferred.length} disposal parcel(s) use an inferred price — check against the IBKR statement.`);
  if (dividends.some((d) => d.withholdingEstimated)) {
    issues.push('US withholding on dividends is ESTIMATED at the 15% treaty rate — the IBKR statement figure wins.');
  }
  for (const n of unknownCf) issues.push(`Carried-forward losses given for "${n}", who is not an owner — ignored.`);

  return {
    financialYear: fy,
    period,
    ownership: ownershipStatement(owners, registration),
    disposals,
    totals,
    owners: ownerSections,
    dividends,
    div775: {
      conversions,
      usdSpends,
      note:
        'Records only, for the accountant: each AUD<->USD conversion and the AUD value of each USD spend ' +
        '(at IBKR\'s rate on the day). No Division 775 gain or loss is computed here. Conversions are ' +
        'captured from the date this record began; earlier ones are on the IBKR statements.',
    },
    complete,
    issues,
    notes: [
      `Net capital gain is ${INDICATIVE_LABEL}.`,
      'CGT event date = US exchange trade date. Discount iff sold on or after buy date + 1 year + 1 day.',
      'AUD at IBKR\'s per-trade FX rate (as on the broker statements); RBA F11 only where IBKR has none (flagged).',
      'Cost base includes buy brokerage; capital proceeds are net of sell brokerage (s110-35).',
      'Losses applied to non-discount gains first, then discount gains; 50% discount last (s102-5).',
      'Parcels matched FIFO — set IBKR\'s lot-matching method to FIFO so statements agree.',
    ],
  };
}

const money = (x: number | null): string =>
  x == null ? 'n/a' : x.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function renderAuTaxReport(r: AuTaxReport): string {
  const L: string[] = [];
  L.push(`AUSTRALIAN TAX REPORT — ${r.financialYear} (${r.period.start} to ${r.period.end})`);
  L.push(r.ownership);
  if (!r.complete) L.push('!! INCOMPLETE — see issues.');
  L.push('');
  L.push('CGT SCHEDULE (AUD)');
  L.push('symbol   qty      bought      sold        disc  cost base      proceeds       gain/loss');
  for (const d of r.disposals) {
    L.push(
      `${d.symbol.padEnd(8)} ${String(d.qty).padStart(6)}  ${d.buyDate}  ${d.sellDate}  ${d.discountEligible ? 'yes ' : 'no  '}` +
        `${money(d.costAud).padStart(13)} ${money(d.proceedsAud).padStart(13)} ${money(d.gainAud).padStart(14)}` +
        (d.flags.length ? `  [${d.flags.join(', ')}]` : ''),
    );
  }
  L.push('');
  L.push(`Capital proceeds ${money(r.totals.capitalProceeds)}; cost base ${money(r.totals.costBase)} ` +
    `(brokerage included in both: USD ${money(r.totals.brokerageIncludedUsd)} — not deductible again)`);
  for (const o of r.owners) {
    L.push('');
    L.push(`${o.name} — ${(o.share * 100).toFixed(2)}% beneficial interest`);
    L.push(`  Discount capital gains (before discount)  ${money(o.cgt.discountGains)}`);
    L.push(`  Non-discount capital gains                ${money(o.cgt.nonDiscountGains)}`);
    L.push(`  Capital losses this year                  ${money(o.cgt.capitalLosses)}`);
    L.push(`  Carried-forward losses applied (input)    ${money(o.carriedForwardLossesIn)}`);
    L.push(`  Net capital gain (${INDICATIVE_LABEL})  ${money(o.net.netCapitalGain)}`);
    L.push(`  Net capital loss to carry forward         ${money(o.net.netCapitalLossToCarryForward)}`);
    L.push(`  Foreign dividends: gross ${money(o.dividends.grossAud)}, US tax withheld ${money(o.dividends.withholdingAud)}, ` +
      `net ${money(o.dividends.netAud)}`);
    L.push(`  Foreign income tax offset (tax paid)      ${money(o.dividends.foreignIncomeTaxOffsetAud)}`);
  }
  if (r.dividends.length > 0) {
    L.push('');
    L.push('DIVIDENDS (AUD at payment-date rate)');
    for (const d of r.dividends) {
      L.push(`  ${d.payDate}  ${(d.symbol ?? String(d.conid)).padEnd(8)} gross ${money(d.grossAud).padStart(10)}  ` +
        `withheld ${money(d.withholdingAud).padStart(8)}${d.withholdingEstimated ? ' (est.)' : ''}  net ${money(d.netAud).padStart(10)}`);
    }
  }
  L.push('');
  L.push('DIVISION 775 RECORDS');
  L.push(`  ${r.div775.note}`);
  for (const c of r.div775.conversions) {
    L.push(`  ${c.tradeDate}  ${c.side} ${money(c.baseAmount)} ${c.baseCurrency} @ ${c.price} = ${money(c.quoteAmount)} ${c.quoteCurrency}`);
  }
  for (const s of r.div775.usdSpends) {
    L.push(`  ${s.date}  spent USD ${money(s.usd)} on ${s.symbol} = AUD ${money(s.aud)} @ ${s.audPerUsd ?? 'n/a'}`);
  }
  if (r.issues.length) {
    L.push('');
    L.push('ISSUES');
    for (const i of r.issues) L.push(`  - ${i}`);
  }
  L.push('');
  L.push('NOTES');
  for (const n of r.notes) L.push(`  - ${n}`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Currency-neutral summary, for backtests (validation/after-tax.ts).
//
// Backtests have no FX, so this runs the same lot engine and the same s102-5
// ordering in the trades' own currency. The live report above is the one to
// file from.
// ---------------------------------------------------------------------------

export interface TaxSummary {
  financialYear: string;
  totalProceeds: number;
  totalCostBasis: number;
  /** Brokerage already inside the two figures above. Do not deduct it again. */
  totalCommissions: number;
  grossGain: number;
  grossLoss: number;
  netGain: number;
  /** Discount-eligible gains, before the discount. */
  longTermGain: number;
  /** Non-discount gains. */
  shortTermGain: number;
  /** Net capital gain per s102-5 (no carried-forward losses). */
  taxableGain: number;
  lots: Disposal[];
}

export function generateTaxSummary(trades?: TradeRecord[]): TaxSummary[] {
  const all = trades ?? loadTradeHistory();
  // Currency-neutral: every trade converts at 1.
  const neutral = all.map((t) => ({ ...t, audPerUsd: 1, fxSource: undefined }));
  const { disposals } = runLotEngine(neutral);
  const byFy = new Map<string, Disposal[]>();
  for (const d of disposals) byFy.set(d.financialYear, [...(byFy.get(d.financialYear) ?? []), d]);

  const out: TaxSummary[] = [];
  for (const [fy, ds] of byFy) {
    const t = cgtTotals(ds);
    const net = computeNetCapitalGain(t);
    out.push({
      financialYear: fy,
      totalProceeds: t.capitalProceeds,
      totalCostBasis: t.costBase,
      totalCommissions: t.brokerageIncludedUsd,
      grossGain: r2(t.discountGains + t.nonDiscountGains),
      grossLoss: -t.capitalLosses,
      netGain: r2(t.discountGains + t.nonDiscountGains - t.capitalLosses),
      longTermGain: t.discountGains,
      shortTermGain: t.nonDiscountGains,
      taxableGain: net.netCapitalGain,
      lots: ds,
    });
  }
  return out.sort((a, b) => a.financialYear.localeCompare(b.financialYear));
}

/**
 * Disposal parcels, currency-neutral, with `longTerm` = discount-eligible.
 * Kept for the backtest studies that count short-term disposals.
 */
export function computeTaxLots(trades: TradeRecord[]): Array<Disposal & { longTerm: boolean }> {
  return runLotEngine(trades.map((t) => ({ ...t, audPerUsd: 1, fxSource: undefined }))).disposals
    .map((d) => ({ ...d, longTerm: d.discountEligible }));
}

/** Financial year of a trade, by exchange trade date. */
export function financialYearOfTrade(t: TradeRecord): string | undefined {
  const d = tradeDateOf(t);
  return d ? financialYearOf(d) : undefined;
}
