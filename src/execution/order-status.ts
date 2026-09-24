/**
 * Is an order at IBKR still working — could it still fill? Shared by the
 * executor's duplicate guard and the cancel-pending resolver.
 *
 * `Inactive` is the awkward one. IBKR uses it both for an order that is dead
 * (rejected downstream, expired) and for one that is merely parked (held
 * outside hours, awaiting a precondition) and can still go live. It used to
 * count as terminal, so a parked order did not stop the next run placing a
 * duplicate of it. Now it counts as working while it is younger than
 * `inactiveMaxMs` (INACTIVE_WORKING_HOURS, default 6 h), and — failing closed
 * — whenever its age is unknown.
 */
const DEAD = new Set(['filled', 'cancelled', 'rejected']);

export const DEFAULT_INACTIVE_WORKING_MS = 6 * 60 * 60 * 1000;

/** INACTIVE_WORKING_HOURS in ms (default 6 h; 0 restores "Inactive is terminal"). */
export function inactiveWorkingMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INACTIVE_WORKING_HOURS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_INACTIVE_WORKING_MS;
  const h = parseFloat(raw);
  return Number.isFinite(h) && h >= 0 ? h * 60 * 60 * 1000 : DEFAULT_INACTIVE_WORKING_MS;
}

export function isWorkingOrder(
  status: string,
  ageMs?: number,
  inactiveMaxMs: number = DEFAULT_INACTIVE_WORKING_MS,
): boolean {
  const s = status.toLowerCase().replace(/[^a-z]/g, '');
  if (DEAD.has(s)) return false;
  if (s === 'inactive') {
    if (inactiveMaxMs <= 0) return false;
    return ageMs === undefined || !Number.isFinite(ageMs) || ageMs < inactiveMaxMs;
  }
  return true;
}
