---
inclusion: fileMatch
fileMatchPattern: ["packages/trial/**", "reports/**", "fixtures/**"]
---
# Trial integrity

The trial is pre-registered (plan §9.7). These rules keep it honest. When in doubt, stop and ask the user.

- **Never edit trial orders or frozen inputs.** After `prereg-v1` is tagged, do not change `reports/orders/`, `fixtures/drafts/`, `fixtures/assignment.json`, `fixtures/critical-edits.json`, `fixtures/reverts.json`, `fixtures/syn/`, `fixtures/constraints/`, `trial/agents/*.json`, the arm hook bundles, `$TRIAL_ROOT/config.json` or `scripts/baseline/rules/`. Their sha256 values are in the tag. A needed change is a dated amendment in `reports/preregistration.md` that says whether data had been seen.
- **Label before replay.** Blind labels are frozen with `dnr trial label --freeze` before `dnr trial replay` and `dnr trial score --unseal`. Never read `reports/sealed/`, the packet key or arm assignments while labeling. Packets hide arm, decision, score and transcript.
- **No DNR files in worktrees.** Run working copies under `$TRIAL_ROOT/runs/` contain nothing from DNR. Hooks, orders, state and config live in the run's HOME and under `$TRIAL_ROOT`. The only exception is arm S's `.kiro/steering/dnr-history.md`.
- **No future history.** Each run's repo is truncated at R (or R+Δ). `git log --all` must show nothing newer than `start_sha`.
- **Tickets never reach trial agents.** `fixtures/discussion/` is shown only to labelers and the drafter, and is `chmod 000` while waves run.
- **Report counts, always.** Every exclusion (infrastructure failure, out-of-tree access, `error_open`, flaky test) is listed with its run ID. Model no-ops count as NONE. Nothing is dropped silently.
- **Decision rule.** Only the §9.8 table decides, rows in the order D1, D6, D2, D3, D4, D5. Wordings are used verbatim.
- **Reproducible.** `dnr trial rescore --check` must reproduce every count exactly. Anything not pre-registered is labeled "exploratory".
