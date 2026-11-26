# Design Document: trial-harness

## Overview

`packages/trial` implements every `dnr trial *` command (plan §8) on top of `@dnr/core`, `@dnr/git`, `@dnr/store` and `@dnr/schemas`. Data moves through committed fixtures (`fixtures/`), sealed and public reports (`reports/`), and an untracked work area (`$TRIAL_ROOT`) that holds truncated repos, per-run working copies, HOMEs, state and environments. The design keeps three properties: no agent sees future history or ticket text, no labeler sees the arm, and every count reproduces from committed files.

## Architecture

```mermaid
flowchart TD
  DJ[$DJANGO_SRC / $SECOND_SRC / syn-src] --> MINE[mine: candidates + proposals]
  MINE --> TIX[tickets: fixtures/discussion]
  TIX --> LR[label --reasons]
  LR --> MINE2[mine --labels: fixtures/reverts.json]
  MINE2 --> ASSIGN[assign: fixtures/assignment.json]
  ASSIGN --> ENVS[envs: env-matrix, restored tests]
  ENVS --> CE[label --critical-edits]
  ASSIGN --> OB[orders build / approve / draft]
  OB --> PREP[prepare: repos, runs, homes, orders, S steering]
  CE --> PREP
  PREP --> TAG{{prereg-v1}}
  TAG --> RUN[run: waves 1-3, namespaces]
  RUN --> PROBE[probe]
  RUN --> BASE[baseline --score]
  RUN --> LABEL[label: run, --blocked, --probe packets]
  LABEL --> FREEZE[label --freeze]
  FREEZE --> REPLAY[replay: reports/sealed]
  REPLAY --> FA[falsealarm --role trial]
  FA --> SCORE[score --unseal: reports/trial.json]
  SCORE --> RESCORE[rescore --check]
  RESCORE --> REPORT[report: trial.md, video/numbers.json]
  REPORT --> DEC[reports/decision.md (§9.8)]
```

## Components and Interfaces

| Module (`packages/trial/src/`) | Command                                                                               | Inputs                                              | Outputs                                                                                     | Requirement     |
| ------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------- |
| `mine.ts`                      | `trial mine [--labels] [--repo]`                                                      | git history                                         | candidates, `candidates.jsonl` proposals, `fixtures/reverts.json`, `reports/eligibility.md` | TH1–TH4         |
| `tickets.ts`                   | `trial tickets [--repo]`                                                              | ticket IDs                                          | `fixtures/discussion/<sha10>.json`                                                          | TH5             |
| `envs.ts`                      | `trial envs [--repo] [--stratum rdelta]`                                              | reverts, Python table                               | `$TRIAL_ROOT/envs/`, Docker images, `env-matrix.json`, `flaky.json`                         | TH6             |
| `assign.ts`                    | `trial assign [--repo]`                                                               | reverts                                             | `fixtures/assignment.json`                                                                  | TH7             |
| `prepare.ts`                   | `trial prepare [--namespace] [--stratum] [--cohort]`                                  | assignment, orders, agent configs, arm hook bundles | `$TRIAL_ROOT/{repos,runs,homes,orders,state}/`, `config.json`                               | TH9             |
| `run.ts`                       | `trial run --wave … \| --namespace … [--concurrency --resume --dry-run --only]`       | prepared runs                                       | transcripts, `meta.json`, diffs, `events.jsonl`, `manifest.jsonl`                           | TH8, TH10, TH11 |
| `label.ts`                     | `trial label --labeler [--probe\|--reasons\|--critical-edits\|--blocked]`, `--freeze` | packets in `dnr-labeling`                           | labels, `reports/labeling/labels.json`, key                                                 | TH12, TH13      |
| `replay.ts`                    | `trial replay`                                                                        | sealed events                                       | `reports/sealed/` decisions                                                                 | TH14            |
| `falsealarm.ts`                | `trial falsealarm [--config] [--role]`                                                | later commits                                       | false-alarm records                                                                         | TH15            |
| `score.ts`                     | `trial score [--unseal]`, `trial rescore --check`                                     | labels, replays, oracle                             | `reports/trial.json` (`TrialResult`)                                                        | TH14            |
| `report.ts`                    | `trial report`                                                                        | `trial.json`                                        | `reports/trial.md`, `reports/video/numbers.json`                                            | TH18            |
| `probe.ts`                     | `trial probe [--dry-run --only]`                                                      | assigned Django reverts                             | probe transcripts, probe packets                                                            | TH19            |
| `baseline.ts`                  | `trial baseline --generate\|--score`                                                  | orders, `scripts/baseline/gen.ts`                   | `scripts/baseline/rules/`, `reports/baseline.json`                                          | TH19            |

### `$TRIAL_ROOT` layout

```
$TRIAL_ROOT/
├── repos/<R>/            truncated repo per revert (and repos/<rdelta_sha>/)
├── runs/<run_id>/        per-run working copy (git clone --no-local)
├── homes/<run_id>/       HOME: credential file (S8), .kiro/hooks/ (arm bundle), .kiro/agents/trial-<arm>.json
├── orders/<run_id>/      ancestor order set
├── state/<run_id>/       DNR_STATE_DIR (cache/fingerprints.json seeded in Phase 10)
├── envs/<sha10>/         uv environments
├── repo2-build/<sha10>/  CPython builds
├── syn-src/              SYN fork clone
└── config.json           frozen copy of $ROOT/.dnr/config.json
```

`$TRIAL_ROOT` is neither inside `$ROOT` nor a sibling of it.

### Arm bundles

| Arm                | Agent config                                       | `$HOME/.kiro/hooks/`                                                  | `DNR_MODE`                      |
| ------------------ | -------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------- |
| T, T2, T3, U, B, H | `trial-T` / `trial-U` / `trial-B` / `trial-H`      | pre-write and post-shell in record mode (no blocking)                 | `record`                        |
| L                  | `trial-L`                                          | pre-write, guard-shell, post-shell, session-start, Stop (deny format) | `enforce`                       |
| S                  | `trial-S`                                          | none                                                                  | —                               |
| demo/LU            | `trial-U`                                          | L's bundle                                                            | `enforce`                       |
| demo/CE            | `trial-T`, then a captured maintainer `git commit` | T's bundle; pre-commit under `commit-enforce`                         | `record`, then `commit-enforce` |
| probe              | `trial-probe`                                      | none                                                                  | —                               |

The plan says only "record-only" for these arms: hooks that observe writes and never block. This design proposes pre-write and post-shell under `DNR_MODE=record`, so `session_patch` and touched files exist for T as well as L (`shell_route` itself comes from the transcript and the diff). The exact list is decided before `prereg-v1` and hashed in it.

### Run lifecycle (`run.ts`)

1. Check `manifest.jsonl`; skip `ok` runs when `--resume`.
2. Hash the order set and `$HOME/.kiro`.
3. Spawn `kiro-cli chat --v3 --no-interactive --trust-all-tools --model <pin> --agent trial-<arm> --output-format stream-json "<task>"` with `cwd` = working copy, `HOME`, and the `DNR_*` variables (or the sidecar), in a new process group; start the 600 s timer; kill the group on expiry → `timeout`.
4. Save the transcript, diff, `events.jsonl` (copied from `DNR_RECORD_PATH`), and `meta.json` (CLI version, model, config sha256, order-set size and hashes, flags).
5. Re-hash and compare; mismatch → `error` with reason.
6. Classify: infrastructure failure before the first tool call → `infra_retry` (≤ 2); otherwise `ok`, `timeout` or `error`.
7. Flag `shell_route`, `consulted_history`, out-of-tree access, any grant created during the run.

### Packets

Packets are generated per run (all arms), per blocked proposal in L (`session_patch` diff), per probe answer, per reason candidate and per critical-edit candidate. Codes are random 6-character strings; order is a seeded shuffle (2026). The key maps code → run ID and kind; its sha256 is committed before labeling.

### Scoring

`score.ts` joins the oracle (restored tests first, then adjudicated labels) with runs and replayed decisions, computes K_eff and every §9.6 measure, applies the denominator rules (infrastructure failures dropped and listed, model no-ops count as NONE), and writes `TrialResult` with `content_hash`. `rescore --check` recomputes from committed inputs and diffs against `trial.json`.

## Data Models

`RevertCase`, `RunRecord`, `Label`, `ProbeGrade`, `Ratio`, `TrialResult`, `KnownRevert`, `KnownRevertRejected`, `Pins`, `Assignment`, `EnvMatrix`, `Flaky`, `Proposal`, `Discussion`, `ReasonLabel`, `CriticalEdit`, `SynCase` (plan §7). All fixture schemas are strict and validated by `pnpm test:fixtures`.

## Error Handling

- Any run not `ok` → `dnr trial *` exits 1 and lists it.
- A CLI version change between runs stops the wave.
- A HOME-hash or order-set-hash mismatch marks the run `error` and lists it.
- A labeling session with κ < 0.4 is re-labeled after adjudication.
- Rate-limited ticket fetches back off; a fetch that keeps failing leaves the discussion file absent and is listed.

## Testing Strategy

- Mining: every `known-reverts.json` SHA recovered; byte-identical rerun.
- Dry runs (Phase 9): `trial run --wave 1 --dry-run --only <revert>` builds the truncated repo, seeds HOME, checks hashes, writes `manifest.jsonl` and round-trips a packet; the same for `rdelta`, `syn`, `repo2`, `demo`, `practice`, the probe, and the two-file `session_patch` dry run.
- Determinism: `rescore --check` and the Phase 12 regression gate.
- Isolation: `git log --all` in each truncated repo shows nothing newer than `start_sha`.

## Traceability

| Requirement | Plan                  | Phase                      |
| ----------- | --------------------- | -------------------------- |
| TH1–TH7     | §9.1, §9.2 Assignment | 0 (known reverts), 3       |
| TH8–TH11    | §9.2, §9.3            | 9, 10 (demo, practice), 11 |
| TH12, TH13  | §9.4, §9.5            | 3, 9, 11                   |
| TH14, TH15  | §9.6                  | 5 (falsealarm), 10, 11     |
| TH16        | Phase 10              | 10                         |
| TH17        | §9.7                  | 10                         |
| TH18        | §9.8, §9.14           | 11                         |
| TH19        | §9.9–§9.13            | 3, 9, 10, 11               |
| TH20        | §9.15                 | 13                         |
| TH21        | Phase 12              | 12                         |
