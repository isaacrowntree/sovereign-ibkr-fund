/** A single target holding in the fund's model portfolio. */
export interface HoldingTarget {
  symbol: string;
  name: string;
  /** Target weight as a percentage of NAV. All targets must sum to 100. */
  pct: number;
  sleeve: 'tech_growth' | 'industrials' | 'healthcare' | 'financials' | 'defensive' | 'hedge';
}
