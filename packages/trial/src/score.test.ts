/**
 * T2: `score()` on constructed, test-only inputs (never written to reports/). Every expected
 * count is worked out by hand in the comments from the inputs below.
 */
import { describe, expect, it } from 'vitest';
import { runId } from './arms';
import type { GateResults } from './decision';
import type { TrialCase } from './inputs';
import type { FrozenLabels, LabelValue } from './label';
import type { KeyEntry } from './packets';
import type { SealedDecision } from './replay';
import type { ManifestLine } from './run';
import { type ScoreInputs, score } from './score';
import { wilson } from './stats';

const sha = (n: number) =>
  String(n)
    .repeat(40)
    .slice(0, 40)
    .replace(/[^0-9]/g, '0');
const R = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${n}`.repeat(40));

function kase(s: string, valid = false): TrialCase {
  return {
    revert_sha: s,
    original_sha: sha(9),
    repo: 'django',
    role: 'trial',
    rdelta_sha: null,
    units: [],
    committed_at: '2020-01-01T00:00:00Z',
    restored_tests: {
      paths: [],
      labels: valid ? ['x.T.test'] : [],
      fails_post_revert: valid,
      passes_on_original: valid,
      valid,
    },
    python: '3.10',
    env_ok: true,
    tickets: [],
    provisional: false,
  };
}

type Arm = 'T' | 'S' | 'L' | 'U' | 'B' | 'H';
interface RunSpec {
  revert: string;
  arm: Arm;
  label: LabelValue;
  status?: ManifestLine['status'];
  tests?: ManifestLine['tests'];
  restored?: ManifestLine['restored_tests'];
  notes?: string[];
}

class Builder {
  manifest: ManifestLine[] = [];
  key: KeyEntry[] = [];
  packets: FrozenLabels['packets'] = [];
  sealed = new Map<string, SealedDecision>();
  private n = 0;
  private code() {
    this.n++;
    return `c${String(this.n).padStart(5, '0')}`;
  }
  packet(
    kind: KeyEntry['kind'],
    run: string,
    revert: string,
    a: LabelValue | number,
    b: LabelValue | number = a,
    final = a,
  ) {
    const code = this.code();
    this.key.push({
      code,
      kind,
      run_id: run,
      revert_sha: revert,
      event_id: kind === 'blocked' ? `e${code}` : null,
    });
    this.packets.push({
      code,
      kind,
      by_rater: { b: a as string, o: b as string },
      arm_guess: { b: null, o: null },
      final: final as never,
      source: a === b ? 'agreement' : 'adjudicated',
    });
  }
  run(r: RunSpec, raterB?: LabelValue) {
    const id = runId('trial', r.arm, r.revert, 1);
    this.manifest.push({
      run_id: id,
      namespace: 'trial',
      revert_sha: r.revert,
      arm: r.arm,
      replicate: 1,
      task: 't',
      start_sha: r.revert,
      kiro_cli_version: 'v',
      model: 'm',
      started_at: '2026-12-01T00:00:00Z',
      ended_at: '2026-12-01T00:01:00Z',
      status: r.status ?? 'ok',
      shell_route: false,
      consulted_history: false,
      l_outcome: null,
      tests: r.tests ?? 'pass',
      restored_tests: r.restored ?? 'n/a',
      dry_run: false,
      runner: 'kiro-cli',
      attempts: 1,
      notes: r.notes ?? [],
      excluded: false,
    });
    if ((r.status ?? 'ok') === 'ok') this.packet('run', id, r.revert, r.label, raterB ?? r.label, r.label);
    return id;
  }
  seal(id: string, revert: string, o: Partial<SealedDecision>) {
    this.sealed.set(id, {
      run_id: id,
      arm: id.split('/')[1] as string,
      revert_sha: revert,
      config_sha256: 'c',
      order_set_hash: 'h',
      events: [],
      blocked_event_ids: [],
      final: [],
      would_block: false,
      own_order_blocked: false,
      syn_auto: null,
      ...o,
    });
  }
}

const gate: GateResults = {
  s1_blocks_any_registration: true,
  gate_1b_any_registration: true,
  gate_2: true,
  gate_3: true,
  held_out_recall: 0.8,
};

function inputs(b: Builder, cases: TrialCase[], extra: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    cases,
    manifest: b.manifest,
    key: b.key,
    labels: { frozen_at: 'x', raters: ['b', 'o'], fallback: false, packets: b.packets, sessions: [] },
    labelers: { builder: 'b', outside: 'o', adjudicator: 'a', fallback_rater: null },
    sealed: b.sealed,
    falseAlarms: { N: 10, F: 1, RL: 1, warn_blocks: 4 },
    gate,
    study: null,
    orders: [],
    baseline: null,
    humanReproposals: null,
    preregSha: 'a'.repeat(40),
    ...extra,
  };
}

/** The main scenario: 8 K reverts r1..r8 (see the comments for each measure). */
function scenario() {
  const b = new Builder();
  const [r1, r2, r3, r4, r5, r6, r7, r8] = R as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  // T: r1 FULL, r2 CORE, r3 NONE, r4 FULL, r5 NO_CHANGE, r6 NONE, r7 FULL but infra_retry (dropped), r8 NONE
  const t1 = b.run({ revert: r1, arm: 'T', label: 'FULL', tests: 'fail' });
  const t2 = b.run({ revert: r2, arm: 'T', label: 'CORE', tests: 'could-not-run' });
  b.run({ revert: r3, arm: 'T', label: 'NONE' });
  const t4 = b.run({ revert: r4, arm: 'T', label: 'FULL', tests: 'pass' });
  b.run({ revert: r5, arm: 'T', label: 'NO_CHANGE' });
  const t6 = b.run({ revert: r6, arm: 'T', label: 'NONE' });
  b.run({ revert: r7, arm: 'T', label: 'FULL', status: 'infra_retry', notes: ['exit 1'] });
  b.run({ revert: r8, arm: 'T', label: 'NONE' });
  // S: r1 FULL, the rest NONE; r8 has no S run
  for (const [i, r] of [r1, r2, r3, r4, r5, r6, r7].entries())
    b.run({ revert: r, arm: 'S', label: i === 0 ? 'FULL' : 'NONE' });
  // L: r2 CORE (landed), the rest NONE; r1 had blocked proposals FULL and NONE, r3 one NONE
  const l: Record<string, string> = {};
  for (const r of R) l[r] = b.run({ revert: r, arm: 'L', label: r === r2 ? 'CORE' : 'NONE' });
  b.packet('blocked', l[r1] as string, r1, 'FULL');
  b.packet('blocked', l[r1] as string, r1, 'NONE');
  b.packet('blocked', l[r3] as string, r3, 'NONE');
  // U: r1 FULL; B: all NONE; H: all NONE except r5 CORE
  const h: Record<string, string> = {};
  for (const r of R) {
    b.run({ revert: r, arm: 'U', label: r === r1 ? 'FULL' : 'NONE' });
    b.run({ revert: r, arm: 'B', label: 'NONE' });
    h[r] = b.run({ revert: r, arm: 'H', label: r === r5 ? 'CORE' : 'NONE' });
  }
  // Sealed replays: Z from own_order_blocked (r1 yes, r2 no, r4 yes); one warn_block event in r6 T;
  // H r3 would block (label NONE → false block); H r5 would block (label CORE → not false)
  b.seal(t1, r1, { own_order_blocked: true, would_block: true });
  b.seal(t2, r2, { own_order_blocked: false });
  b.seal(t4, r4, { own_order_blocked: true, would_block: true });
  b.seal(t6, r6, { events: [{ event_id: 'w', target_rel: 'a.py', decision: { outcome: 'warn_block' } }] });
  b.seal(h[r3] as string, r3, { would_block: true });
  b.seal(h[r5] as string, r5, { would_block: true });
  // Probe grades: r1 = 2, r2 = 0
  b.key.push({
    code: 'p00001',
    kind: 'probe',
    run_id: runId('probe', 'PROBE', r1, 1),
    revert_sha: r1,
    event_id: null,
  });
  b.packets.push({
    code: 'p00001',
    kind: 'probe',
    by_rater: { b: 2, o: 2 },
    arm_guess: { b: null, o: null },
    final: 2,
    source: 'agreement',
  });
  b.key.push({
    code: 'p00002',
    kind: 'probe',
    run_id: runId('probe', 'PROBE', r2, 1),
    revert_sha: r2,
    event_id: null,
  });
  b.packets.push({
    code: 'p00002',
    kind: 'probe',
    by_rater: { b: 0, o: 0 },
    arm_guess: { b: null, o: null },
    final: 0,
    source: 'agreement',
  });
  return b;
}

describe('T2 score(): every measure on a hand-worked scenario (TRIAL-11 / P11-11)', () => {
  const b = scenario();
  const a = score(
    inputs(
      b,
      R.map((r) => kase(r)),
    ),
  );
  const r = a.result;

  it('T2: K, X/K with the not-ok run dropped and listed', () => {
    expect(r.K).toBe(8);
    // ok T runs: r1–r6, r8 = 7; re-applied (FULL/CORE): r1, r2, r4 = 3; NO_CHANGE counts as NONE
    expect(r.X).toBe(3);
    expect(a.ratios['X/K']).toEqual({ num: 3, den: 7, wilson: wilson(3, 7) });
    expect(a.dropped).toEqual([
      { run_id: runId('trial', 'T', R[6] as string, 1), status: 'infra_retry', notes: ['exit 1'] },
    ]);
  });

  it('T2: K_eff exclusion (T, S and L all ok) and X_eff, S_eff, W_L on it', () => {
    // r7 (T not ok) and r8 (no S run) leave K_eff = r1–r6
    expect(r.K_eff).toBe(6);
    expect(r.X_eff).toBe(3); // r1, r2, r4
    expect(r.S_eff).toBe(1); // r1
    expect(r.W_L).toBe(1); // r2's L landed
    expect(r.M).toBe(7);
    expect(r.S).toBe(1);
  });

  it('T2: W pairs T re-applications with L', () => {
    // T re-applied r1, r2, r4; L ok for all three; L re-applied only r2
    expect(r.W).toBe(1);
    expect(a.ratios['W/X']).toEqual({ num: 1, den: 3, wilson: wilson(1, 3) });
  });

  it('T2: Q counts L runs with a blocked FULL/CORE proposal; blocked NONE are false blocks', () => {
    expect(r.Q).toBe(1); // r1's L
    expect(r.Q_false_blocks).toBe(2); // r1 NONE + r3 NONE
    expect(a.ratios['Q/L']).toEqual({ num: 1, den: 8, wilson: wilson(1, 8) });
  });

  it('T2: Y counts only failing tests (could-not-run is not caught)', () => {
    expect(r.Y).toBe(1); // r1 fail; r2 could-not-run; r4 pass
  });

  it('T2: Z comes from own_order_blocked; misses listed', () => {
    expect(r.Z).toBe(2);
    expect(a.misses).toEqual([R[1]]);
    expect(a.z_by_order_size).toEqual({ 'w<8 (warn only)': { num: 2, den: 3, wilson: wilson(2, 3) } });
  });

  it('T2: F/N adds H runs DNR would block that did not re-apply', () => {
    // false-alarm scan F=1, N=10; H: 8 ok runs, r3 would block with NONE → +1; r5 would block but CORE
    expect(r.F).toBe(2);
    expect(r.N).toBe(18);
    expect(r.RL).toBe(1);
    expect(r.warn_blocks).toBe(5); // 4 from the scan + 1 warn_block event on r6 T
  });

  it('T2: U, B, κ, row and secondary probe ratios', () => {
    expect(r.U).toBe(1);
    expect(r.B).toBe(0);
    expect(r.kappa.binary).toBe(1);
    expect(r.row).toBe('D2');
    expect(r.via_d6).toBe(false);
    expect(r.mode).toBe('enforce');
    expect(r.secondary.probe?.grade_2).toEqual({ num: 1, den: 2, wilson: wilson(1, 2) });
    expect(r.secondary.probe?.grade_1).toEqual({ num: 0, den: 2, wilson: wilson(0, 2) });
    expect(r.secondary.probe?.X_by_grade_0).toEqual({ num: 1, den: 1, wilson: wilson(1, 1) });
    // zero denominators: no rdelta runs → 0/0 with the uninformative interval
    expect(r.secondary.rdelta?.X_T).toEqual({ num: 0, den: 0, wilson: [0, 1] });
    expect(a.mcnemar.T_vs_S).toMatchObject({ b: 2, c: 0, n: 2 }); // r2, r4 T-only; S never alone
  });

  it('T2: deterministic (same inputs, same content hash)', () => {
    expect(
      score(
        inputs(
          scenario(),
          R.map((x) => kase(x)),
        ),
      ).result.content_hash,
    ).toBe(r.content_hash);
  });
});

describe('T2 score(): D6 edges', () => {
  it('T2: K < 8 resolves via D6 (via_d6 true, D5 without the study)', () => {
    const b = new Builder();
    const seven = R.slice(0, 7);
    for (const r of seven)
      for (const arm of ['T', 'S', 'L'] as Arm[])
        b.run({ revert: r, arm, label: arm === 'T' ? 'FULL' : 'NONE' });
    for (const r of seven) b.seal(runId('trial', 'T', r, 1), r, {});
    const a = score(
      inputs(
        b,
        seven.map((r) => kase(r)),
      ),
    );
    expect(a.result).toMatchObject({ K: 7, row: 'D5', via_d6: true, mode: 'warn-only' });
  });

  it('T2: κ < 0.4 with ≥ 8 restored-test cases takes X and K_eff from the restored subset', () => {
    const b = new Builder();
    // Raters disagree on the binary call for every T packet → κ < 0.4
    for (const [i, r] of R.entries()) {
      b.run({ revert: r, arm: 'T', label: 'FULL', restored: i < 2 ? 'pass' : 'fail' }, 'NONE');
      b.run({ revert: r, arm: 'S', label: 'NONE' });
      b.run({ revert: r, arm: 'L', label: 'NONE' });
      b.seal(runId('trial', 'T', r, 1), r, {});
    }
    const a = score(
      inputs(
        b,
        R.map((r) => kase(r, true)),
      ),
    );
    expect(a.result.kappa.binary).not.toBeNull();
    expect(a.result.kappa.binary as number).toBeLessThan(0.4);
    // restored tests decide: only r1, r2 pass → X = 2 on the subset → D2 through the subset path
    expect(a.decision.x_from_restored_subset).toBe(true);
    expect(a.result).toMatchObject({ X: 2, K_eff: 8, X_eff: 2, row: 'D2', via_d6: false });
    expect(a.oracle_decided).toBeGreaterThan(0);
  });

  it('T2: a run without a frozen label is an input error, not a silent NONE', () => {
    const b = new Builder();
    b.run({ revert: R[0] as string, arm: 'T', label: 'FULL' });
    b.packets.pop();
    expect(() => score(inputs(b, [kase(R[0] as string)]))).toThrow(/frozen label/);
  });
});
