/**
 * Net capital gain, following the method statement in s102-5 ITAA 1997.
 *
 *   Step 1  Reduce the year's capital gains by the year's capital losses.
 *   Step 2  Reduce what is left by net capital losses carried forward from
 *           earlier years.
 *   Step 3  Apply the 50% discount to discount capital gains still remaining.
 *   Step 5  Add up what is left.
 *
 * The taxpayer chooses which gains the losses reduce. Applying them to
 * NON-discount gains first is always at least as good (a dollar of loss
 * absorbs a whole dollar of taxable gain there, only fifty cents of a
 * discount gain), so both steps take non-discount gains first.
 *
 * The old code offset losses PROPORTIONALLY across short- and long-term gains
 * and knew nothing of carried-forward losses — overstating the gain whenever
 * there were both kinds.
 *
 * Carried-forward losses are a MANUAL input from the owner's lodged return.
 * This account is not the owner's only source of capital gains, so the result
 * is labelled indicative.
 */

export interface CapitalGainComponents {
  /** Gains on parcels held long enough for the discount (before the discount). */
  discountGains: number;
  /** Gains on parcels not eligible for the discount. */
  nonDiscountGains: number;
  /** The year's capital losses, as a positive number. */
  capitalLosses: number;
}

export interface NetCapitalGainResult {
  /** Step 1 split: current-year losses applied to non-discount, then discount gains. */
  currentLossesApplied: { nonDiscount: number; discount: number };
  /** Step 2 split: carried-forward losses applied to non-discount, then discount gains. */
  carriedForwardApplied: { nonDiscount: number; discount: number };
  /** Discount gains left after steps 1-2, before the 50% discount. */
  discountGainsAfterLosses: number;
  nonDiscountGainsAfterLosses: number;
  /** The 50% discount taken (step 3). */
  discount: number;
  /** Step 5. Never negative. */
  netCapitalGain: number;
  /** Losses left over: this year's unused plus carried-forward unused. */
  netCapitalLossToCarryForward: number;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

/** Apply `loss` to (nonDiscount, discount), non-discount first. Returns what each absorbed. */
function applyLoss(loss: number, nonDiscount: number, discount: number): { nd: number; d: number } {
  const nd = Math.min(loss, nonDiscount);
  const d = Math.min(loss - nd, discount);
  return { nd, d };
}

export function computeNetCapitalGain(c: CapitalGainComponents, carriedForwardLosses = 0): NetCapitalGainResult {
  const check = (name: string, v: number) => {
    if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number (got ${v})`);
  };
  check('discountGains', c.discountGains);
  check('nonDiscountGains', c.nonDiscountGains);
  check('capitalLosses', c.capitalLosses);
  check('carriedForwardLosses', carriedForwardLosses);

  let nd = c.nonDiscountGains;
  let d = c.discountGains;

  const s1 = applyLoss(c.capitalLosses, nd, d);
  nd -= s1.nd;
  d -= s1.d;
  const currentUnused = c.capitalLosses - s1.nd - s1.d;

  const s2 = applyLoss(carriedForwardLosses, nd, d);
  nd -= s2.nd;
  d -= s2.d;
  const carriedUnused = carriedForwardLosses - s2.nd - s2.d;

  const discount = d / 2;
  return {
    currentLossesApplied: { nonDiscount: r2(s1.nd), discount: r2(s1.d) },
    carriedForwardApplied: { nonDiscount: r2(s2.nd), discount: r2(s2.d) },
    discountGainsAfterLosses: r2(d),
    nonDiscountGainsAfterLosses: r2(nd),
    discount: r2(discount),
    netCapitalGain: r2(nd + d - discount),
    netCapitalLossToCarryForward: r2(currentUnused + carriedUnused),
  };
}
