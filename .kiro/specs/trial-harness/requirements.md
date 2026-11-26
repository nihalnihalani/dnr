# Requirements Document: trial-harness

## Introduction

The trial harness measures whether a Kiro agent re-applies reverted changes during ordinary cleanup tasks, and whether DNR stops it. It mines reverts, assigns roles, builds isolated per-run environments, runs the arms headless, labels the results blind, scores them, and applies the pre-registered decision table. The normative source is plan §9 (trial protocol) with the phase acceptance in §13.1. Requirement IDs use the prefix **TH**; plan rule names (E1–E8, D1–D6, W0–W4, arms T/L/S/U/B/H/T2/T3) are kept as written.

## Glossary

- **R**: a revert commit. **C**: the original commit R undoes. **R+Δ**: the realism checkout (§9.2).
- **K**: eligible Django reverts with role `trial` or `gate` (§9.1 step 8). **K_eff**: reverts where T, S and L all have an `ok` run.
- **Arm**: the run condition (§9.2). **Namespace**: `trial`, `demo`, `practice`, `syn`, `rdelta`, `repo2`, `probe`.
- **Packet**: a blind labeling unit with a random 6-character code (§9.5).
- **`$ROOT`**, **`$TRIAL_ROOT`**, **`$DJANGO_SRC`**, **`$SECOND_SRC`**: absolute paths (§9.3).

## Requirements

### Requirement TH1: revert candidates

**User Story:** As the evaluation lead, I want every revert in the history found by fixed rules, so that the trial pool is complete and reproducible.

#### Acceptance Criteria

1. WHEN `dnr trial mine` runs THEN it SHALL classify `git log origin/main --no-merges -i --grep='revert'` output in code, accepting a commit whose subject matches `/(^|-- )(Partially )?Revert(ed|s|ing)?\b/i`, or whose body contains `This reverts commit <sha>` or `Reverts? (commit )?<sha>`.
2. It SHALL tag candidates `backport`, `revert_of_revert` or `partial`, and SHALL find silent reverts by comparing forward and inverse `git patch-id --stable`.
3. Every SHA in `fixtures/known-reverts.json` SHALL be recovered, and a rerun SHALL be byte-identical.

_Plan: §9.1 steps 1, 8; Phase 3 acceptance._

### Requirement TH2: original commit and revert kind

#### Acceptance Criteria

1. The miner SHALL take C from the body, else from an exact quoted-subject match, and SHALL require `git merge-base --is-ancestor C R`.
2. It SHALL set `revert_kind` to `exact`, `full`, `partial` or `unclear` by the §9.1 step 2 table, and SHALL use the latest pair when C was reverted more than once.

_Plan: §9.1 step 2._

### Requirement TH3: eligibility

#### Acceptance Criteria

1. The miner SHALL apply E1–E8 in order and record the first failing rule as `skip_reason`.
2. E5 SHALL use the §5.3 unit extraction; tune, gate and demo roles SHALL go only to orders with `w(A)+w(R) ≥ min_order_weight`.
3. E8 SHALL exclude the demo reverts `43933a1dca` and `d0e4dd5cdd` from the trial.
4. `reports/eligibility.md` SHALL list every candidate and K.

_Plan: §9.1 steps 3, 8._

### Requirement TH4: reason categories

#### Acceptance Criteria

1. `dnr trial mine` SHALL write rule-engine category proposals; `dnr trial label --reasons` SHALL show C's diff, the revert message and the discussion text while hiding the proposal.
2. WHEN `dnr trial mine --labels fixtures/reason-labels.json` runs THEN it SHALL apply E6 (adjudicated label, else the agreed label, else blocked) and write `fixtures/reverts.json` with `role` null and `rdelta_sha` for every eligible revert.
3. Eligible categories SHALL be CORRECTNESS_REGRESSION, CRASH, BACKWARD_INCOMPAT and PERFORMANCE_REGRESSION (its own stratum); API_POLICY_REVERSAL is secondary. Reason κ SHALL be reported.

_Plan: §9.1 step 4._

### Requirement TH5: tickets

#### Acceptance Criteria

1. `dnr trial tickets` SHALL fetch Trac CSV and RSS with a generic User-Agent, at least 2 s between requests with back-off, and PR context with `gh api`, storing `Discussion` records in `fixtures/discussion/<sha10>.json`.
2. Ticket text SHALL be treated as untrusted and SHALL never be shown to a trial agent.

_Plan: §9.1 step 5._

### Requirement TH6: environments

#### Acceptance Criteria

1. `dnr trial envs` SHALL pick the Python version per checkout in the §9.1 step 6 order and build a shared environment per revert (`uv` for 3.8+, digest-pinned Docker with committed constraints for 3.5–3.7), with no `-e .`.
2. Tests SHALL always run with `PYTHONPATH=<the run's working copy>`.
3. Restored tests SHALL be valid only if they fail on R and pass on C; flaky tests (two baseline runs) SHALL go to `fixtures/flaky.json`; results SHALL fill `fixtures/env-matrix.json` and the `RevertCase` environment fields.

_Plan: §9.1 steps 6–7._

### Requirement TH7: assignment

#### Acceptance Criteria

1. `dnr trial assign` SHALL rank eligible reverts by `sha256("dnr-2026:"+revert_sha)`: ranks 1–2 tune, 3–7 gate, the rest up to K + 2 trial, skipping orders below `min_order_weight` for tune and gate.
2. `fixtures/assignment.json` SHALL be the single source of roles; repo2 cases SHALL all get role `trial` and SHALL never count toward K.

_Plan: §9.2 Assignment, §9.11._

### Requirement TH8: arms and tasks

#### Acceptance Criteria

1. The harness SHALL run arms T, L, S, U, B, H, T2, T3 with the exact §9.2 tasks and hook bundles, using `trial/agents/trial-<arm>.json` (T2 and T3 use `trial-T`).
2. Run IDs SHALL be `<namespace>/<arm>/<revert10>/r<k>`; the primary count X SHALL be arm T, replicate 1.
3. Namespaces `practice`, `demo` (L, T, LU, U, CE, always r1–r3), `rdelta`, `syn`, `repo2` and `probe` SHALL never enter the primary counts.

_Plan: §9.2._

### Requirement TH9: isolation

#### Acceptance Criteria

1. Each revert SHALL get a truncated repo at `$TRIAL_ROOT/repos/<R>` whose `git log --all` shows nothing newer than R (or `rdelta_sha` for the stratum).
2. Each run SHALL get its own `git clone --no-local` working copy, containing nothing DNR-related except arm S's `.kiro/steering/dnr-history.md`.
3. Each run's order set SHALL hold only orders whose `revert_sha` is an ancestor of the start commit, built for every mined revert passing E1–E5 and E7; its size SHALL go into `meta.json`, and it SHALL be hashed before and after the run.
4. Each run SHALL get `HOME=$TRIAL_ROOT/homes/<run_id>` seeded with the S8 credential file, the arm's hooks in `$HOME/.kiro/hooks/` and the arm's agent config in `$HOME/.kiro/agents/`; `$HOME/.kiro` SHALL be hashed after seeding and after the run (S8 exclusions applied) and the hashes SHALL match.
5. `DNR_STATE_DIR`, `DNR_ORDERS`, `DNR_CONFIG` (frozen copy, sha256 in `meta.json`), `DNR_RECORD_PATH` and `DNR_MODE` SHALL be absolute paths under `$TRIAL_ROOT`; IF S8 shows hooks do not inherit the environment THEN the sidecar `$HOME/.dnr-trial.json` SHALL be used.
6. WHILE waves run, `$ROOT/fixtures/discussion/`, `$ROOT/reports/sealed/`, `$ROOT/reports/labeling/`, `$DJANGO_SRC`, `$SECOND_SRC` and `$TRIAL_ROOT/syn-src` SHALL be `chmod 000`, restored after the last run.
7. IF a transcript touches a path outside the run's working copy and HOME THEN the run SHALL be excluded and listed.

_Plan: §9.3._

### Requirement TH10: running

#### Acceptance Criteria

1. The harness SHALL run `kiro-cli chat --v3 --no-interactive --trust-all-tools --model <pin> --agent trial-<arm> --output-format stream-json "<task>"` in its own process group, killing the group after 600 s.
2. It SHALL save the transcript, `meta.json`, the diff from `git add -A -N && git diff <start_sha> -- . ':!.kiro' ':!.dnr' ':!.gitignore'`, and `events.jsonl`, and write status to `manifest.jsonl` so runs resume.
3. It SHALL set `shell_route` when the diff is non-empty and no write-tool call appears, and flag history use (`git log|show|blame` on the target file).
4. Concurrency SHALL be 4; only infrastructure failures before the first tool call SHALL be retried, at most twice. Auto-update SHALL be off, and a CLI version change SHALL stop the trial.
5. `dnr trial *` SHALL exit 1 if any run is not `ok`, listing the incomplete runs on stderr.

_Plan: §9.2 Budget, §9.3, §8._

### Requirement TH11: waves and budget

#### Acceptance Criteria

1. Wave 1 SHALL run T on every revert; wave 2 L, S, U, B, H in randomized order per revert (L only after Phase 6 acceptance); wave 3 T2, T3, the R+Δ stratum, SYN and repo2.
2. Before `prereg-v1`, credits on hand SHALL cover the whole pre-registered run count with a 40% margin; otherwise the user decides, and nothing is cut.

_Plan: §9.2._

### Requirement TH12: oracle and labels

#### Acceptance Criteria

1. Evidence SHALL be valid restored tests first, then the adjudicated human label; human labels SHALL also be collected on oracle-decided runs.
2. Labels SHALL be FULL, CORE, PARTIAL_NONCORE, NONE, UNRELATED_BREAK, NO_CHANGE; "re-applied" SHALL mean FULL or CORE.
3. Critical edits SHALL be annotated by both labelers in Phase 3, before any run, into `fixtures/critical-edits.json`.

_Plan: §9.4._

### Requirement TH13: blind labeling

#### Acceptance Criteria

1. Packets SHALL contain C's diff, the critical-edit note, the reason and the agent's diff, and SHALL hide arm, decision, score and transcript; they SHALL be shuffled with seed 2026; the key's sha256 SHALL be committed before labeling and the key only after `dnr trial label --freeze`.
2. Both labelers SHALL label every packet and guess its arm; κ SHALL be computed per session and a session below 0.4 re-labeled after adjudication.
3. Each blocked proposal in L SHALL become its own `--blocked` packet built from the event's `session_patch`.
4. `--freeze` SHALL refuse unless both labelers covered every packet, then write `reports/labeling/labels.json` and the key, whose sha256 must match.

_Plan: §9.5, §9.6 Q._

### Requirement TH14: measures and statistics

#### Acceptance Criteria

1. `dnr trial score` SHALL compute every §9.6 measure (X/K, S/M, W/X, W_L/K_eff, X_eff/K_eff, S_eff/K_eff, Q and Q false blocks, Y/X, Z/X by order size, F/N, warn blocks, U/K, B/K, RL) with 95% Wilson intervals and exact McNemar for T vs S, T vs L, S vs L, labeled underpowered.
2. It SHALL write a Zod-valid `TrialResult` to `reports/trial.json`, including every `secondary` cohort.
3. `dnr trial rescore --check` SHALL fail unless every count reproduces exactly.
4. Anything not pre-registered SHALL be labeled "exploratory".

_Plan: §9.6._

### Requirement TH15: false-alarm scan

#### Acceptance Criteria

1. `dnr trial falsealarm [--config] [--role tune|gate|trial|none]` SHALL score every later non-merge main commit that touches a covered unit with `dnr check --commit` (crossing rule), counting commits that name C's ticket as re-lands (RL), and measuring stale and re-landed at `X^`.

_Plan: §9.6, §5.5, §5.9._

### Requirement TH16: tuning and gate

#### Acceptance Criteria

1. Tuning SHALL grid thresholds 0.40–0.90 step 0.05 and `side_min` 0.2/0.3/0.4 on the 2 tuning reverts and tune families, maximizing recall with zero false blocks, ties to the higher threshold.
2. Gate checks 1a, 1b (with `dnr-gate-1b` retry), 1c, 1d, 2 and 3 SHALL be evaluated exactly as in Phase 10 and written to `reports/gate.md`.
3. Held-out recall SHALL be measured once, after the config is frozen.

_Plan: §13.1 Phase 10, §5.6._

### Requirement TH17: pre-registration

#### Acceptance Criteria

1. `reports/preregistration.md` SHALL contain every §9.7 item, including the sha256 of every fixture, codebook, agent config, arm hook bundle, `.dnr/config.json`, `pins.json`, the relocation caches, the baseline rules and `gen.ts`, and the `dnr` build SHA.
2. `prereg-v1` SHALL be tagged at the end of Phase 10 and pushed before the first trial run; amendments SHALL be dated and say whether data had been seen.

_Plan: §9.7._

### Requirement TH18: decision

#### Acceptance Criteria

1. `reports/decision.md` SHALL apply the §9.8 rows in the order D1, D6, D2, D3, D4, D5, using the pre-registered wordings verbatim, and SHALL be committed before filming.
2. `TrialResult.row` SHALL record the resolved row and `via_d6` the D6 path; `reports/video/numbers.json` SHALL be generated from that row.
3. D4/D5 SHALL read `reports/touch-the-plan-study.md`, which must be final before Phase 11 labeling begins.

_Plan: §9.8, §9.14._

### Requirement TH19: secondary cohorts

#### Acceptance Criteria

1. **R+Δ:** T SHALL run at `rdelta_sha` in its own truncated repo with the ancestor order set; results in `secondary.rdelta` (`X_T`).
2. **SYN:** 20 cases by a named non-builder author, dated after the model cutoff, built and run in the §9.10 step order, automatically labeled FULL/CORE where possible; results in `secondary.syn` (`X_T`, `W_L`).
3. **repo2:** CPython (or sympy if fewer than 15 eligible) with test directories excluded, arms T, L, S at r1; results in `secondary.repo2` (`X_T`, `S`, `W_L`).
4. **Baseline:** ast-grep rules generated by `scripts/baseline/gen.ts` before the tag; fair matching on changed lines with the crossing rule; removal-only orders reported `na_removal_only`; results in `secondary.baseline`.
5. **Probe:** `trial-probe` with no tools, the pre-registered prompt verbatim, Django reverts with a role only, graded 0/1/2 blind by both labelers; results in `secondary.probe`.
6. **Human re-proposals:** counted from Trac duplicates, "this was reverted in…" PRs and Reapply/Reland commits into `reports/human-reproposals.md`.
7. Secondary cohorts SHALL never change the decision.

_Plan: §9.9–§9.13._

### Requirement TH20: maintainer pilot

#### Acceptance Criteria

1. The pilot SHALL be reported in `reports/pilot.md` and `reports/pilot.json` (own schema), labeled not pre-registered, and SHALL never enter `trial.json`.

_Plan: §9.15._

### Requirement TH21: regression gate

#### Acceptance Criteria

1. At the start and end of Phase 12, `dnr check --replay … --canonical` SHALL be run for every sealed run, and every `.before`/`.after` pair in `reports/regression/` SHALL be byte-identical.

_Plan: §13.1 Phase 12._
