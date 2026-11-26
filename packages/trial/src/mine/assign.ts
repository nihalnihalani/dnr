import type { Assignment } from '@dnr/schemas';
import { DEMO_REVERTS } from './eligibility';
import { TARGET_K } from './report';
import { seedKey } from './seed';

export interface AssignInput {
  revert_sha: string;
  repo: Assignment[number]['repo'];
  /** Whole-order w(A)+w(R); null means unknown. */
  order_weight: number | null;
}

export interface AssignOptions {
  minOrderWeight: number;
  targetK?: number;
  /** Demo reverts (role demo); they are E8-ineligible so they are not in `eligible`. */
  demos?: ReadonlyArray<{
    revert_sha: string;
    repo: Assignment[number]['repo'];
    order_weight: number | null;
  }>;
}

export interface AssignResult {
  assignment: Assignment;
  K: number;
  /** Reverts ranked but not selected because K reached the target. */
  unselected: string[];
  warnings: string[];
}

/**
 * §9.2 Assignment. Rank eligible reverts by sha256("dnr-2026:"+sha) ascending (rank 1 = smallest).
 * Ranks are walked in order: the first 2 reverts with weight ≥ min_order_weight become tune, the
 * next 5 such become gate, everything else becomes trial, until gate+trial reaches the target K
 * (lowest ranks kept). Demo reverts get role demo with rank 0.
 */
export function assignRoles(eligible: readonly AssignInput[], opts: AssignOptions): AssignResult {
  const target = opts.targetK ?? TARGET_K;
  const warnings: string[] = [];
  for (const e of eligible) {
    if (e.order_weight === null)
      throw new Error(`order_weight unknown for ${e.revert_sha}; run mining with the engine analyzer first`);
    if (DEMO_REVERTS.includes(e.revert_sha))
      throw new Error(`demo revert ${e.revert_sha} must not be in the eligible set (E8)`);
  }
  const ranked = [...eligible]
    .map((e) => ({ ...e, key: seedKey(e.revert_sha) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out: Assignment = [];
  const unselected: string[] = [];
  let tune = 0;
  let gate = 0;
  let k = 0;
  ranked.forEach((e, i) => {
    const rank = i + 1;
    const heavy = (e.order_weight as number) >= opts.minOrderWeight;
    if (heavy && tune < 2) {
      tune++;
      out.push({ revert_sha: e.revert_sha, repo: e.repo, role: 'tune', rank });
      return;
    }
    if (k >= target) {
      unselected.push(e.revert_sha);
      return;
    }
    if (heavy && gate < 5) {
      gate++;
      k++;
      out.push({ revert_sha: e.revert_sha, repo: e.repo, role: 'gate', rank });
      return;
    }
    k++;
    out.push({ revert_sha: e.revert_sha, repo: e.repo, role: 'trial', rank });
  });
  if (tune < 2) warnings.push(`only ${tune} tune reverts meet min_order_weight=${opts.minOrderWeight}`);
  if (gate < 5) warnings.push(`only ${gate} gate reverts meet min_order_weight=${opts.minOrderWeight}`);
  for (const d of opts.demos ?? []) {
    if (d.order_weight !== null && d.order_weight < opts.minOrderWeight) {
      warnings.push(
        `demo ${d.revert_sha.slice(0, 10)} has order weight ${d.order_weight} < min_order_weight=${opts.minOrderWeight}`,
      );
    }
    out.push({ revert_sha: d.revert_sha, repo: d.repo, role: 'demo', rank: 0 });
  }
  // K counts only the primary repo's trial and gate roles (§9.1 step 8).
  const K = out.filter((a) => a.repo === 'django' && (a.role === 'trial' || a.role === 'gate')).length;
  return { assignment: out, K, unselected, warnings };
}
