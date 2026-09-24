/**
 * Who the tax report is prepared for.
 *
 * Australian tax follows BENEFICIAL ownership, not the names on the account.
 * An account registered in joint names whose money belongs to one person is
 * that person's for tax: she reports all of the gains, dividends and foreign
 * tax. So the split is configuration, not an assumption about the account's
 * registration.
 *
 *   TAX_OWNER_SHARES="Owner A:100"            one beneficial owner (the default)
 *   TAX_OWNER_SHARES="Owner A:60,Owner B:40"  a genuine split
 *   TAX_ACCOUNT_REGISTRATION=joint            say so in the report
 *
 * Names live only in the host's environment. This public repo ships a
 * placeholder.
 */

export interface OwnerShare {
  name: string;
  /** Fraction of the beneficial interest, 0..1. */
  share: number;
}

export const DEFAULT_OWNER_SHARES: OwnerShare[] = [{ name: 'Beneficial owner', share: 1 }];

/** Parse "Name:pct,Name:pct". Percentages must sum to 100. Throws on anything else. */
export function parseOwnerShares(spec: string | undefined | null): OwnerShare[] {
  if (!spec || !spec.trim()) return DEFAULT_OWNER_SHARES;
  const owners: OwnerShare[] = [];
  for (const part of spec.split(',')) {
    const at = part.lastIndexOf(':');
    const name = part.slice(0, at).trim();
    const pct = Number(part.slice(at + 1));
    if (at <= 0 || !name || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new Error(`TAX_OWNER_SHARES: cannot read "${part}" — expected "Name:percent"`);
    }
    if (owners.some((o) => o.name === name)) throw new Error(`TAX_OWNER_SHARES: "${name}" listed twice`);
    owners.push({ name, share: pct / 100 });
  }
  const total = owners.reduce((s, o) => s + o.share, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`TAX_OWNER_SHARES: shares sum to ${(total * 100).toFixed(4)}%, not 100%`);
  }
  return owners.filter((o) => o.share > 0);
}

export type AccountRegistration = 'individual' | 'joint';

export function ownersFromEnv(env: NodeJS.ProcessEnv = process.env): {
  owners: OwnerShare[];
  registration: AccountRegistration;
} {
  const reg = (env.TAX_ACCOUNT_REGISTRATION || 'individual').toLowerCase();
  if (reg !== 'individual' && reg !== 'joint') {
    throw new Error(`TAX_ACCOUNT_REGISTRATION must be "individual" or "joint" (got "${reg}")`);
  }
  return { owners: parseOwnerShares(env.TAX_OWNER_SHARES), registration: reg };
}

/** One sentence stating whose report this is and why. */
export function ownershipStatement(owners: OwnerShare[], registration: AccountRegistration): string {
  const list = owners.map((o) => `${o.name} (${(o.share * 100).toFixed(2).replace(/\.00$/, '')}%)`).join(', ');
  if (registration === 'joint' && owners.length === 1) {
    return (
      `This report covers an account registered in joint names but held beneficially by one owner, ` +
      `${list}. Australian tax follows beneficial ownership, so all gains, losses, dividends and foreign ` +
      'tax below are that owner\'s to report. Keep evidence that the funds were theirs (e.g. deposit records).'
    );
  }
  if (owners.length === 1) return `Prepared for the beneficial owner, ${list}.`;
  return (
    `Prepared for the beneficial owners in these shares: ${list}. Each figure below is split by beneficial ` +
    'interest; each owner reports only their own share.'
  );
}
