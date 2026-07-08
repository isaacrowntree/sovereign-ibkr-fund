import type { HoldingTarget } from './types.js';

/**
 * SAMPLE model portfolio — an illustrative, diversified ETF template.
 *
 * ⚠️ This is a TEMPLATE, not investment advice and not anyone's real book.
 * It exists so the fund runs out-of-the-box against paper trading. To run your
 * own allocation, drop in a private override (gitignored) — see
 * `portfolios/local.example.ts` — and it takes precedence automatically.
 *
 * Weights must sum to 100 (enforced by `validateTargets()`).
 */
export const SAMPLE_PORTFOLIO: HoldingTarget[] = [
  // Growth
  { symbol: 'QQQ', name: 'Invesco QQQ (Nasdaq-100)',          pct: 20, sleeve: 'tech_growth' },
  // Industrials
  { symbol: 'XLI', name: 'Industrial Select Sector SPDR',     pct: 10, sleeve: 'industrials' },
  // Healthcare
  { symbol: 'XLV', name: 'Health Care Select Sector SPDR',    pct: 10, sleeve: 'healthcare' },
  // Financials
  { symbol: 'XLF', name: 'Financial Select Sector SPDR',      pct: 10, sleeve: 'financials' },
  // Defensive
  { symbol: 'VIG', name: 'Vanguard Dividend Appreciation',    pct: 15, sleeve: 'defensive' },
  { symbol: 'VDC', name: 'Vanguard Consumer Staples',         pct: 10, sleeve: 'defensive' },
  // Hedge / diversifiers
  { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond',    pct: 15, sleeve: 'hedge' },
  { symbol: 'GLD', name: 'SPDR Gold Trust',                   pct: 10, sleeve: 'hedge' },
];
