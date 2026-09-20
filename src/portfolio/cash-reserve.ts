/**
 * The cash the cash-flow path keeps back, resolved to USD.
 *
 * The strategist sizes in USD but IBKR reports the account in its base
 * currency, so an operator who reads "cash: $1,427" in the digest and sets a
 * reserve is thinking in base. A base-currency reserve is converted with the
 * ledger's rate; without a rate it cannot be honoured, so the USD figure is
 * used instead — never a silent zero, which would deploy the whole balance.
 */
export function resolveCashReserveUsd(i: {
  reserveUsd: number;
  reserveBase: number | null;
  baseRatePerUsd: number | null;
}): { reserveUsd: number; source: 'base' | 'usd' } {
  if (i.reserveBase !== null && Number.isFinite(i.reserveBase) && i.reserveBase >= 0
      && i.baseRatePerUsd !== null && i.baseRatePerUsd > 0) {
    return { reserveUsd: i.reserveBase / i.baseRatePerUsd, source: 'base' };
  }
  const usd = Number.isFinite(i.reserveUsd) && i.reserveUsd >= 0 ? i.reserveUsd : 1000;
  return { reserveUsd: usd, source: 'usd' };
}
