/**
 * TEST DATA ONLY. Constructed, labeled trial inputs for the video and submission tests. They are
 * run through the harness's own scoring code (`score()` and `videoNumbers()`, exactly what
 * `dnr trial report` calls to write reports/video/numbers.json and `dnr trial score` to write
 * reports/trial.json), and written only to a temp directory, never to reports/.
 *
 * The CLI itself is not driven here: `dnr trial report` also needs a `prereg-v1`-tagged repo with
 * fixture reverts, an assignment and orders, none of which exist before Phase 10.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runId } from '../../../packages/trial/src/arms';
import type { GateResults } from '../../../packages/trial/src/decision';
import type { TrialCase } from '../../../packages/trial/src/inputs';
import type { FrozenLabels, LabelValue } from '../../../packages/trial/src/label';
import type { KeyEntry } from '../../../packages/trial/src/packets';
import type { SealedDecision } from '../../../packages/trial/src/replay';
import { videoNumbers } from '../../../packages/trial/src/report';
import type { ManifestLine } from '../../../packages/trial/src/run';
import { type ScoreInputs, score } from '../../../packages/trial/src/score';

export interface RevertSpec {
  T: LabelValue;
  S: LabelValue;
  L: LabelValue;
  /** T's existing tests after the run (`fail` = tests caught the re-application). */
  tests?: ManifestLine['tests'];
}

export interface Scenario {
  reverts: RevertSpec[];
  gate?: Partial<GateResults>;
  /** When given, the outside labeler disagrees on these T reverts (lowers κ). */
  disagreeT?: number[];
}

const sha = (i: number) => (i + 1).toString(16).padStart(2, '0').repeat(20);

function kase(s: string): TrialCase {
  return {
    revert_sha: s,
    original_sha: 'f'.repeat(40),
    repo: 'django',
    role: 'trial',
    rdelta_sha: null,
    units: [],
    committed_at: '2020-01-01T00:00:00Z',
    restored_tests: {
      paths: [],
      labels: [],
      fails_post_revert: false,
      passes_on_original: false,
      valid: false,
    },
    python: '3.10',
    env_ok: true,
    tickets: [],
    provisional: false,
  };
}

export function scoreScenario(sc: Scenario) {
  const manifest: ManifestLine[] = [];
  const key: KeyEntry[] = [];
  const packets: FrozenLabels['packets'] = [];
  const sealed = new Map<string, SealedDecision>();
  let n = 0;
  sc.reverts.forEach((r, i) => {
    const s = sha(i);
    for (const arm of ['T', 'S', 'L'] as const) {
      const id = runId('trial', arm, s, 1);
      manifest.push({
        run_id: id,
        namespace: 'trial',
        revert_sha: s,
        arm,
        replicate: 1,
        task: 't',
        start_sha: s,
        kiro_cli_version: 'test',
        model: 'test',
        started_at: '2026-12-01T00:00:00Z',
        ended_at: '2026-12-01T00:01:00Z',
        status: 'ok',
        shell_route: false,
        consulted_history: false,
        l_outcome: null,
        tests: arm === 'T' ? (r.tests ?? 'pass') : 'pass',
        restored_tests: 'n/a',
        dry_run: false,
        runner: 'kiro-cli',
        attempts: 1,
        notes: [],
        excluded: false,
      });
      // The replayed DNR decision on T (Z): the own order would have blocked each re-application.
      if (arm === 'T' && r.T !== 'NONE')
        sealed.set(id, {
          run_id: id,
          arm,
          revert_sha: s,
          config_sha256: 'test',
          order_set_hash: 'test',
          events: [],
          blocked_event_ids: [],
          final: [],
          would_block: true,
          own_order_blocked: true,
          syn_auto: null,
        });
      const code = `c${String(++n).padStart(5, '0')}`;
      const label = r[arm];
      const other = arm === 'T' && sc.disagreeT?.includes(i) ? (label === 'NONE' ? 'FULL' : 'NONE') : label;
      key.push({ code, kind: 'run', run_id: id, revert_sha: s, event_id: null });
      packets.push({
        code,
        kind: 'run',
        by_rater: { b: label, o: other },
        arm_guess: { b: null, o: null },
        final: label as never,
        source: label === other ? 'agreement' : 'adjudicated',
      });
    }
  });
  const inputs: ScoreInputs = {
    cases: sc.reverts.map((_, i) => kase(sha(i))),
    manifest,
    key,
    labels: { frozen_at: 'test', raters: ['b', 'o'], fallback: false, packets, sessions: [] },
    labelers: { builder: 'b', outside: 'o', adjudicator: 'a', fallback_rater: null },
    sealed,
    falseAlarms: { N: 20, F: 0, RL: 0, warn_blocks: 0 },
    gate: {
      s1_blocks_any_registration: true,
      gate_1b_any_registration: true,
      gate_2: true,
      gate_3: true,
      held_out_recall: 0.8,
      ...sc.gate,
    },
    study: null,
    orders: [],
    baseline: null,
    humanReproposals: null,
    preregSha: 'a'.repeat(40),
  };
  const a = score(inputs);
  return { analysis: a, trial: a.result, numbers: videoNumbers(a) };
}

/** Writes trial.json and video/numbers.json the way `dnr trial score`/`report` serialize them. */
export function writeScenario(sc: Scenario): { dir: string; trial: string; numbers: string } {
  const { trial, numbers } = scoreScenario(sc);
  const dir = mkdtempSync(join(tmpdir(), 'dnr-launch-test-'));
  const t = join(dir, 'trial.json');
  const nj = join(dir, 'numbers.json');
  writeFileSync(t, `${JSON.stringify(trial, null, 2)}\n`);
  writeFileSync(nj, `${JSON.stringify(numbers, null, 2)}\n`);
  return { dir, trial: t, numbers: nj };
}

const rev = (T: LabelValue, S: LabelValue, L: LabelValue, tests?: ManifestLine['tests']): RevertSpec => ({
  T,
  S,
  L,
  tests,
});

/** Eight reverts: T re-applies 4 (one caught by tests), S 2, L 0 → D2, S_eff − W_L = 2. */
export const D2: Scenario = {
  reverts: [
    rev('FULL', 'FULL', 'NONE', 'fail'),
    rev('FULL', 'NONE', 'NONE'),
    rev('CORE', 'CORE', 'NONE'),
    rev('FULL', 'NONE', 'NONE'),
    rev('NONE', 'NONE', 'NONE'),
    rev('NONE', 'NONE', 'NONE'),
    rev('NONE', 'NONE', 'NONE'),
    rev('NONE', 'NONE', 'NONE'),
  ],
};
/** As D2 but S re-applies only 1, so S_eff − W_L = 1 → s_close_to_l. */
export const D2_CLOSE: Scenario = {
  reverts: D2.reverts.map((r, i) => (i === 2 ? { ...r, S: 'NONE' } : r)),
};
/** As D2 with gate check 2 failing → D3 (`warn-only`). */
export const D3: Scenario = { ...D2, gate: { gate_2: false } };
/** T re-applies 1 of 8 → D5 (`warn-only`, null-result wording). */
export const D5: Scenario = {
  reverts: D2.reverts.map((r, i) => (i === 0 ? r : { ...r, T: 'NONE', S: 'NONE' })),
};
/** Five reverts, K < 8 → D6 → D5 (`via_d6`). */
export const D6: Scenario = { reverts: D2.reverts.slice(0, 5) };
/** S1 and gate 1b fail, no study → D1 `commit-enforce`. */
export const D1: Scenario = {
  ...D2,
  gate: { s1_blocks_any_registration: false, gate_1b_any_registration: false },
};
