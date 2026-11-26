import { ELIGIBLE_REASONS, type ReasonCategory, type ReasonLabel } from '@dnr/schemas';

export type RuleState = 'pass' | 'fail' | 'pending' | 'n/a';
export type RuleId = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8';
export const RULE_IDS: readonly RuleId[] = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8'];

/** The two demo reverts (§9.1 E8). */
export const DEMO_REVERTS: readonly string[] = [
  '43933a1dca07047e95ec990d9289d0212668009e',
  'd0e4dd5cdd743a5c43c4ccc2c8fa29d3982eaa71',
];

/** §9.1 E5 floor on whole-order w(A)+w(R). */
export const MIN_E5_WEIGHT = 3;

/** Skip-reason codebook. Every skip_reason is `<rule>:<code>` from this table, or `pending:<rules>`. */
export const SKIP_CODES: Readonly<Record<string, string>> = {
  'window:out-of-range': 'revert committed outside 2015–2025 (not in W0–W4)',
  'E1:backport': 'backport commit (`[X.Y.x]` subject or "Backport of … from main")',
  'E1:not-first-parent': 'not on the first-parent chain of main',
  'E2:no-original':
    'original commit C not found (no resolvable SHA in the body, no exact quoted-subject match)',
  'E2:not-ancestor': 'C is not an ancestor of R',
  'E2:superseded': 'C was reverted again later; the latest pair is used',
  'E3:partial': 'R undoes only part of C',
  'E3:unclear': 'neither patch-id equality nor `git revert` reproduction; a person decides',
  'E4:no-source-unit': 'C changes no .py file under the source root (`django/`)',
  'E5:low-weight': 'whole-order w(A)+w(R) < 3',
  'E6:ineligible-reason': 'reason category is not eligible',
  'E6:secondary-reason': 'API_POLICY_REVERSAL (secondary stratum, outside K)',
  'E6:unadjudicated': 'labelers disagree and no adjudicated label exists',
  'E7:unit-missing': 'none of the units C changed exists at R',
  'E8:demo': 'demo revert',
};

export interface RuleInputs {
  inWindow: boolean;
  backport: boolean;
  onFirstParent: boolean;
  originalFound: boolean;
  originalIsAncestor: boolean;
  superseded: boolean;
  revertKind: 'exact' | 'full' | 'partial' | 'unclear' | null;
  sourceUnits: number;
  orderWeight: number | null;
  reason: { state: 'pending' } | { state: 'labeled'; category: ReasonCategory } | { state: 'unadjudicated' };
  unitsAtR: number | null;
  isDemo: boolean;
}

export interface RuleOutcome {
  rules: Record<RuleId, RuleState>;
  skip_reason: string | null;
  /** True when no rule failed (pending rules allowed). */
  provisional: boolean;
  /** True when every rule passed. */
  eligible: boolean;
}

/**
 * Applies E1–E8 in order (§9.1 step 3). The first failing rule is the skip reason. A rule that
 * cannot be decided yet is `pending`; if a pending rule precedes the first failure the skip
 * reason is `pending:<ids>` because the failure might not be the first one.
 */
export function applyRules(x: RuleInputs): RuleOutcome {
  const rules: Record<RuleId, RuleState> = {
    E1: 'n/a',
    E2: 'n/a',
    E3: 'n/a',
    E4: 'n/a',
    E5: 'n/a',
    E6: 'n/a',
    E7: 'n/a',
    E8: 'n/a',
  };
  const codes: Partial<Record<RuleId, string>> = {};
  const fail = (id: RuleId, code: string) => {
    rules[id] = 'fail';
    codes[id] = code;
  };
  // E1
  if (x.backport) fail('E1', 'E1:backport');
  else if (!x.onFirstParent) fail('E1', 'E1:not-first-parent');
  else rules.E1 = 'pass';
  // E2
  if (!x.originalFound) fail('E2', 'E2:no-original');
  else if (!x.originalIsAncestor) fail('E2', 'E2:not-ancestor');
  else if (x.superseded) fail('E2', 'E2:superseded');
  else rules.E2 = 'pass';
  // E3
  if (x.revertKind === 'exact' || x.revertKind === 'full') rules.E3 = 'pass';
  else if (x.revertKind === 'partial') fail('E3', 'E3:partial');
  else if (x.revertKind === 'unclear') fail('E3', 'E3:unclear');
  // E4
  if (x.originalFound) {
    if (x.sourceUnits > 0) rules.E4 = 'pass';
    else fail('E4', 'E4:no-source-unit');
  }
  // E5
  if (rules.E4 === 'pass') {
    if (x.orderWeight === null) rules.E5 = 'pending';
    else if (x.orderWeight >= MIN_E5_WEIGHT) rules.E5 = 'pass';
    else fail('E5', 'E5:low-weight');
  }
  // E6
  if (x.reason.state === 'pending') rules.E6 = 'pending';
  else if (x.reason.state === 'unadjudicated') fail('E6', 'E6:unadjudicated');
  else if (ELIGIBLE_REASONS.includes(x.reason.category)) rules.E6 = 'pass';
  else if (x.reason.category === 'API_POLICY_REVERSAL') fail('E6', 'E6:secondary-reason');
  else fail('E6', 'E6:ineligible-reason');
  // E7
  if (x.unitsAtR !== null) {
    if (x.unitsAtR > 0) rules.E7 = 'pass';
    else fail('E7', 'E7:unit-missing');
  }
  // E8
  if (x.isDemo) fail('E8', 'E8:demo');
  else rules.E8 = 'pass';

  let skip: string | null = null;
  const pend: RuleId[] = [];
  if (!x.inWindow) skip = 'window:out-of-range';
  else {
    for (const id of RULE_IDS) {
      if (rules[id] === 'pending') pend.push(id);
      if (rules[id] === 'fail') {
        skip = pend.length > 0 ? `pending:${pend.join(',')}` : (codes[id] as string);
        break;
      }
    }
    if (skip === null && pend.length > 0) skip = `pending:${pend.join(',')}`;
  }
  const anyFail = RULE_IDS.some((id) => rules[id] === 'fail');
  const allPass = RULE_IDS.every((id) => rules[id] === 'pass');
  return { rules, skip_reason: skip, provisional: x.inWindow && !anyFail, eligible: x.inWindow && allPass };
}

/** The first failing rule's code regardless of pending rules (for reporting). */
export function firstFailure(rules: Record<RuleId, RuleState>): RuleId | null {
  for (const id of RULE_IDS) if (rules[id] === 'fail') return id;
  return null;
}

/**
 * E6 input (§7 comment on ReasonLabel): the adjudicated label if present, else the label both
 * labelers agree on; otherwise blocked until adjudicated.
 */
export function resolveReason(
  revertSha: string,
  labels: readonly ReasonLabel[] | null,
): RuleInputs['reason'] {
  if (!labels) return { state: 'pending' };
  const mine = labels.filter((l) => l.revert_sha === revertSha);
  const adj = mine.filter((l) => l.adjudicated);
  if (adj.length > 0) {
    const cats = new Set(adj.map((l) => l.category));
    if (cats.size === 1) return { state: 'labeled', category: adj[0]?.category as ReasonCategory };
    return { state: 'unadjudicated' };
  }
  const labelers = new Set(mine.map((l) => l.labeler));
  if (labelers.size < 2) return { state: 'pending' };
  const cats = new Set(mine.map((l) => l.category));
  if (cats.size === 1) return { state: 'labeled', category: mine[0]?.category as ReasonCategory };
  return { state: 'unadjudicated' };
}
