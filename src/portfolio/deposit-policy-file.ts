/**
 * Loading the standing instruction from disk.
 *
 * Kept apart from `deposit-policy.ts` so the decision itself stays pure and
 * testable with no filesystem — same split as the model resolver.
 *
 * Fails CLOSED in the direction that matters: a policy file that is present
 * but malformed does NOT quietly fall through to the ordinary cash-flow path.
 * Falling through would deploy the deposit against pro-rata deficits while the
 * operator believes their directed instruction is in force — the money would
 * move, into the wrong names, and nothing would say so. Absent is different
 * and is simply "no instruction": the ordinary path, unchanged.
 */
import { readFileSync } from 'node:fs';
import { parseDepositPolicy, type DepositPolicy } from './deposit-policy.js';

let cached: { path: string; policy: DepositPolicy | null } | null = null;

/**
 * The policy in force, or null when none is configured or present.
 *
 * @throws if the file exists and cannot be read or parsed. The caller is an
 * agent that is about to stage orders, so refusing to run is the right
 * outcome — the operator wrote an instruction and it is not being followed.
 */
export function loadDepositPolicy(): DepositPolicy | null {
  const path = process.env.DEPOSIT_POLICY_FILE || '';
  if (!path) return null;
  if (cached && cached.path === path) return cached.policy;

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      cached = { path, policy: null };
      return null;
    }
    throw new Error(`${path}: deposit policy could not be read (${(e as Error).message})`);
  }
  if (!text.trim()) {
    cached = { path, policy: null };
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: deposit policy is not valid JSON (${(e as Error).message})`);
  }
  const policy = parseDepositPolicy(raw, path);
  cached = { path, policy };
  return policy;
}

/** Test seam: drop the per-process cache. */
export function resetDepositPolicyCache(): void {
  cached = null;
}
