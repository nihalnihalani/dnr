/**
 * §9.8 decision table, the only decision rule. Rows are evaluated in the order D1, D6, D2, D3,
 * D4, D5; the first row that matches decides. Wordings are pre-registered verbatim.
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export type Row = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';
export type Mode = 'enforce' | 'warn-only' | 'commit-enforce' | null;

/** `reports/gate.json`, written from Phase 10 results (`reports/gate.md`). */
export const GateResults = z.strictObject({
  /** S1 passed under at least one registration (an always-block hook fired headless). */
  s1_blocks_any_registration: z.boolean(),
  /** Gate check 1b passed under at least one registration (with the dnr-gate-1b retry). */
  gate_1b_any_registration: z.boolean(),
  gate_2: z.boolean(),
  gate_3: z.boolean(),
  /** Held-out recall over 70 mutants (5 × 2 families × 7 reverts), 0–1. */
  held_out_recall: z.number().min(0).max(1),
});
export type GateResults = z.infer<typeof GateResults>;

export interface StudyResult {
  /** The file exists and says it is final. */
  final: boolean;
  participants: number;
  /** The §9.8 success rule holds (as recorded in the file). */
  rule_holds: boolean;
}

/**
 * `reports/touch-the-plan-study.md` must carry these machine lines (the user's workstream writes them):
 * `Final: yes`, `Participants completed: <n>`, `Success rule: pass|fail`.
 * The study succeeds only with ≥ 6 participants and the rule holding; anything else does not succeed.
 */
export function readStudy(path: string): StudyResult | null {
  if (!existsSync(path)) return null;
  const t = readFileSync(path, 'utf8');
  const final = /^Final:\s*yes\s*$/im.test(t);
  const n = /^Participants completed:\s*(\d+)\s*$/im.exec(t);
  const rule = /^Success rule:\s*(pass|fail)\s*$/im.exec(t);
  return { final, participants: n ? Number(n[1]) : 0, rule_holds: rule?.[1]?.toLowerCase() === 'pass' };
}

export const studySucceeds = (s: StudyResult | null) => !!s && s.final && s.participants >= 6 && s.rule_holds;

export interface DecisionInput {
  gate: GateResults;
  study: StudyResult | null;
  /** Eligible Django reverts with role trial or gate. */
  K: number;
  /** Binary κ (builder vs outside, or builder vs fallback rater under §9.5); null = not computable. */
  kappaBinary: number | null;
  /** Reverts with valid restored tests ("cases", §9.8 D6). */
  restoredCases: number;
  /** X on all K reverts (labels + oracle). */
  X: number;
  /** X computed on the restored-test subset only (used when κ < 0.4 with ≥ 8 cases). */
  X_restored: number;
}

export interface DecisionResult {
  row: Row;
  via_d6: boolean;
  /** X used by the matched row (the restored-subset X on that path). */
  X_used: number;
  x_from_restored_subset: boolean;
  mode: Mode;
  study_succeeded: boolean;
  trace: string[];
}

const kappaOk = (k: number | null) => k !== null && k >= 0.4;

export function decide(i: DecisionInput): DecisionResult {
  const trace: string[] = [];
  const study = studySucceeds(i.study);
  // D1: Kiro cannot block a write.
  if (!i.gate.s1_blocks_any_registration && !i.gate.gate_1b_any_registration) {
    trace.push('D1: S1 and gate check 1b both fail under both registrations');
    return {
      row: 'D1',
      via_d6: false,
      X_used: i.X,
      x_from_restored_subset: false,
      mode: study ? null : 'commit-enforce',
      study_succeeded: study,
      trace,
    };
  }
  trace.push('D1: no (Kiro can block a write)');
  // D6: inconclusive, unless κ < 0.4 with ≥ 8 restored-test cases (X on that subset, continue at D2).
  let X = i.X;
  let fromSubset = false;
  if (i.K < 8 || (!kappaOk(i.kappaBinary) && i.restoredCases < 8)) {
    const row: Row = study ? 'D4' : 'D5';
    trace.push(
      `D6: ${i.K < 8 ? `K = ${i.K} < 8` : `κ = ${i.kappaBinary ?? 'n/a'} < 0.4 with ${i.restoredCases} < 8 restored-test cases`}; only the study condition of D4/D5 is evaluated → ${row}`,
    );
    return {
      row,
      via_d6: true,
      X_used: X,
      x_from_restored_subset: false,
      mode: study ? null : 'warn-only',
      study_succeeded: study,
      trace,
    };
  }
  if (!kappaOk(i.kappaBinary)) {
    X = i.X_restored;
    fromSubset = true;
    trace.push(
      `D6: κ = ${i.kappaBinary ?? 'n/a'} < 0.4 but ${i.restoredCases} ≥ 8 restored-test cases; X = ${X} on that subset, continue at D2`,
    );
  } else trace.push(`D6: no (K = ${i.K}, κ = ${i.kappaBinary})`);
  const gatesOk = i.gate.gate_2 && i.gate.gate_3 && i.gate.held_out_recall >= 0.7;
  if (X >= 2 && gatesOk && (kappaOk(i.kappaBinary) || fromSubset)) {
    trace.push(
      `D2: X = ${X} ≥ 2, gate checks 2 and 3 pass, held-out recall ${i.gate.held_out_recall} ≥ 0.70`,
    );
    return {
      row: 'D2',
      via_d6: false,
      X_used: X,
      x_from_restored_subset: fromSubset,
      mode: 'enforce',
      study_succeeded: study,
      trace,
    };
  }
  if (X >= 2) {
    trace.push(
      `D3: X = ${X} ≥ 2 and gate 2 ${i.gate.gate_2 ? 'pass' : 'fail'}, gate 3 ${i.gate.gate_3 ? 'pass' : 'fail'}, recall ${i.gate.held_out_recall}`,
    );
    return {
      row: 'D3',
      via_d6: false,
      X_used: X,
      x_from_restored_subset: fromSubset,
      mode: 'warn-only',
      study_succeeded: study,
      trace,
    };
  }
  if (study) {
    trace.push(`D4: X = ${X} ≤ 1 and the study succeeds`);
    return {
      row: 'D4',
      via_d6: false,
      X_used: X,
      x_from_restored_subset: fromSubset,
      mode: null,
      study_succeeded: study,
      trace,
    };
  }
  trace.push(`D5: X = ${X} ≤ 1 and the study does not succeed`);
  return {
    row: 'D5',
    via_d6: false,
    X_used: X,
    x_from_restored_subset: fromSubset,
    mode: 'warn-only',
    study_succeeded: study,
    trace,
  };
}

/** §9.8 table, word for word (pre-registration and decision.md). */
export const DECISION_TABLE = `| # | Condition | Outcome |
|---|---|---|
| D1 | S1 and gate check 1b both fail under both registrations: Kiro cannot block a write | If Touch the Plan's study succeeds (§9.14): switch to Touch the Plan. Only the Phase 0 setup and video tooling carry over. If the study fails: DNR in \`commit-enforce\` mode (§5.14): pre-commit blocks and the Crew check is required, with the D1 wording |
| D6 | K < 8 after all widening (W0–W4), **or** binary κ < 0.4 with fewer than 8 restored-test cases. A "case" is a revert with valid restored tests | Inconclusive: evaluate **only the study condition** of D4/D5. \`row\` records the resolved row and \`via_d6\` is true. If D5, use the inconclusive wording (no X claim). If κ < 0.4 but 8 or more cases exist, X is computed on that subset and evaluation continues at D2. Under the §9.5 fallback, κ is builder vs. fallback rater |
| D2 | X ≥ 2 **and** gate checks 2 and 3 pass **and** held-out recall ≥ 70% **and** (κ ≥ 0.4, or X comes from the D6 restored-test subset) | DNR with both tiers |
| D3 | X ≥ 2, and gate check 2 or 3 fails or held-out recall < 70% | DNR in \`warn-only\` mode |
| D4 | X ≤ 1, and Touch the Plan's study succeeds (see below) | Touch the Plan |
| D5 | X ≤ 1, and the study does not succeed (including fewer than 6 participants completing) | DNR in \`warn-only\` mode, with the null-result wording |`;

/** Pre-registered wordings (§9.8), verbatim; K and X are filled from trial.json. */
export const WORDINGS = {
  D5_null: (K: number, X: number) =>
    `In ${K} cleanup tasks, the agent re-applied ${X} reverted changes. DNR's value here is the warning and the reason, shown in the demo.`,
  D1_study_failed:
    "Kiro's hooks could not block a write in our tests, so DNR enforces at commit time and in Crew pull requests instead.",
  D6_inconclusive:
    'The pre-registered trial did not produce a reliable count (K or labeler agreement below the pre-registered floor). No re-application rate is claimed.',
} as const;

export function outcomeText(d: DecisionResult): string {
  switch (d.row) {
    case 'D1':
      return d.study_succeeded
        ? 'Touch the Plan (D1, study succeeded)'
        : 'DNR in `commit-enforce` mode (D1, study failed)';
    case 'D2':
      return 'DNR with both tiers';
    case 'D3':
      return 'DNR in `warn-only` mode';
    case 'D4':
      return d.via_d6 ? 'Touch the Plan (via D6: inconclusive trial)' : 'Touch the Plan';
    case 'D5':
      return d.via_d6
        ? 'DNR in `warn-only` mode, inconclusive wording (via D6)'
        : 'DNR in `warn-only` mode, with the null-result wording';
    case 'D6':
      return 'inconclusive';
  }
}
