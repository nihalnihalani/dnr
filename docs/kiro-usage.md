# How Kiro built DNR

This is the Devpost write-up (plan §11). Each statement below links to the file or commit it rests on. Commit links are relative, so they resolve once the repository is on GitHub. Anything that doesn't exist yet is marked **pending**, with what will produce it. It is never filled with a sample value (AGENTS.md).

## 1. Problem

> **"Your repository remembers why. Your agent doesn't."**

A change that was tried and reverted looks like a reasonable cleanup to an agent that never read the ticket. In Django, `ea3a71c2d0` changed `Query.clear_ordering` and `43933a1dca` reverted it, because "self.group_by contains Cols, not aliases" ([reports/orders/README.md](../reports/orders/README.md)). An agent asked to tidy that method has nothing telling it so.

- **Pending:** how often agents re-apply reverted changes, and how often existing tests catch it. This is the pre-registered trial's X/K and Y/X (Phase 11, `reports/trial.json`).
- **Pending:** how often people re-propose reverted changes. Draft text-match counts are in [reports/human-reproposals.md](../reports/human-reproposals.md), and each hit still needs a person to confirm it (§9.9).
- **Pending:** the GIF of a live block. It comes from the filmed `demo/L` run (Phases 10 and 14).

## 2. Audience and evidence

DNR is for maintainers of repositories that accept AI-agent changes ([.kiro/steering/product.md](../.kiro/steering/product.md)). The motivating study is Al Hasan and Biswas, ["What Breaks When LLMs Code?"](https://arxiv.org/html/2605.30777v3) (arXiv 2605.30777), which confirmed 547 coding-agent safety failures.

**Pending:** the maintainer pilot (§9.15, Phase 13, `reports/pilot.md`).

## 3. How it works

When a Kiro agent's write would bring a reverted change back, the PreToolUse hook [`.kiro/hooks/dnr-pre-write.json`](../.kiro/hooks/dnr-pre-write.json) runs `dnr check --stdin --hook kiro`. On a match it exits 2, with the reason and links to the original commit, the revert and the ticket.

This works end to end on the real Django case. The re-application of `43933a1dca` exits 2 with edit score 1.00 in `Query.clear_ordering`. The full stderr is in [reports/orders/README.md](../reports/orders/README.md), and the `R1:` test in [packages/hook/test/golden.test.ts](../packages/hook/test/golden.test.ts) checks it (hook path built in [b6f3a09](../../../commit/b6f3a09)).

Re-landing a fixed version takes one human approval, through `dnr board` or `dnr allow`. The diagram is in [docs/architecture.md](architecture.md).

### 3a. Why Frankenstein

DNR stitches four things into one write path: the human arguments in a mid-2000s bug tracker (Django's Trac), deterministic syntax trees (tree-sitter, [vendor/grammars/](../vendor/grammars/)), git's revert graph ([packages/git/](../packages/git/)) and a nondeterministic 2026 agent.

### 3b. What surprised us during the build

Only findings that came up while building go here, each linked to its evidence.

- **Test hunks diluted the real order.** Building the real `dnr-43933a1dca` order from Django history pulled in C's test hunk in `tests/aggregation_regress/tests.py` as well as the code change. Orders now skip `test_globs` paths, so the order is the single unit `Query.clear_ordering` (w(A) = 16, R empty), and an exact re-application scores 1.00. Pinned by a test on the real Django texts in [53bb4d7](../../../commit/53bb4d7); see [reports/orders/README.md](../reports/orders/README.md).
- **The plan named the wrong method.** The plan said the demo revert changes `Query.set_group_by`. Building the order showed it changes `Query.clear_ordering`, so every prompt and doc was corrected ([9a951a2](../../../commit/9a951a2), [reports/orders/README.md](../reports/orders/README.md)).
- **A case-insensitive path bypass on macOS.** Writing `Django/db/…` instead of `django/db/…` re-applied the change with no block and no Stop. Paths are now resolved to their on-disk casing and case-folded on case-insensitive file systems. Fixed with regression tests in [b3f4301](../../../commit/b3f4301); listed in [docs/threat-model.md](threat-model.md).
- **Kiro's own permission policy as a second layer.** The wave-3 re-attack showed that a same-user hook can always be worked around. So `dnr init` now offers Kiro `permissions.yaml` deny rules on DNR's own files, with a y/N at the terminal ([88b81bf](../../../commit/88b81bf)). Whether Kiro enforces them headless is spike S17 ([91f5e51](../../../commit/91f5e51), [docs/spikes.md](spikes.md)), which is **pending**.
- **The first failing property was in our test, not the engine.** P1 failed on its first run because its oracle wrote to a file the order doesn't cover. The engine was right. The fix and the re-run at 500 and 3,000 runs are recorded in [reports/property-failures.md](../reports/property-failures.md).
- **Browser–hook parity caught a real bug.** The P9 test runs the built `dnr check --file` for every Playground preset on Chromium, Firefox and WebKit. It caught a bug in the matched-units listing ([292e43b](../../../commit/292e43b)).
- **Pending:** spike findings S1–S17, which need `kiro-cli` ([docs/spikes.md](spikes.md)).

## 4. Trial

**Pending.** The trial has not run. The harness is built ([3d50c72](../../../commit/3d50c72), [.kiro/specs/trial-harness/](../.kiro/specs/trial-harness/)), and so is the decision table, which matches plan §9.8 word for word ([packages/trial/src/decision.ts](../packages/trial/src/decision.ts)). The following appear only after a real run (Phase 11), in `reports/trial.json` and `reports/decision.md`:

- the `prereg-v1` tag;
- the arm results (T, S, L over K_eff);
- κ;
- held-out recall.

## 5. How Kiro built it

| Surface | What exists | Status |
|---|---|---|
| Specs | Two specs with EARS requirements, R1–R15 and P1–P17, designs and tasks traced to commits: [.kiro/specs/dnr-check/](../.kiro/specs/dnr-check/) and [.kiro/specs/trial-harness/](../.kiro/specs/trial-harness/) | Written outside Kiro IDE spec mode so far. Refining them and running tasks in spec mode is **pending** (user, Kiro IDE) |
| Hooks | Six DNR hook files plus one dev hook in [.kiro/hooks/](../.kiro/hooks/), matching plan §6; the commands they call are in [packages/hook/](../packages/hook/) ([b6f3a09](../../../commit/b6f3a09)) | Tested by piping hook-event JSON into the built `dnr` ([packages/hook/test/](../packages/hook/test/)). The event fixtures are provisional until spike S2 captures real ones, and a live Kiro run is **pending** (spike S1, needs `kiro-cli`) |
| Steering | [product.md](../.kiro/steering/product.md), [tech.md](../.kiro/steering/tech.md), [hook-contracts.md](../.kiro/steering/hook-contracts.md) (verified vs spike-pending contracts) and [trial-integrity.md](../.kiro/steering/trial-integrity.md); the shipped user steering is [packages/cli/templates/steering/dnr.md](../packages/cli/templates/steering/dnr.md) | In place |
| Custom agents | [.kiro/agents/dnr-drafter.json](../.kiro/agents/dnr-drafter.json) (no tools; prompt [.kiro/prompts/drafter.md](../.kiro/prompts/drafter.md)) and [dnr-gate-1b.json](../.kiro/agents/dnr-gate-1b.json) (gate 1b retry); seven trial agents in [trial/agents/](../trial/agents/) | Model pin **pending** (Phase 0). Agent-config hook behavior is **pending** spike S10 |
| MCP | [packages/mcp/](../packages/mcp/), with two read-only tools, `explain_function` and `list_orders_for_file`, registered in [.kiro/settings/mcp.json](../.kiro/settings/mcp.json); stdio tests in [packages/mcp/test/mcp.test.ts](../packages/mcp/test/mcp.test.ts) | A live session calling `explain_function` is **pending** (Phase 12) |
| Power | [powers/dnr/](../powers/dnr/): `plugin.json`, `mcp.json`, `POWER.md`, `skills/dnr-guard/SKILL.md` | Which format loads is **pending** spike S9 |
| Property tests | P1–P17 with fast-check in [packages/testkit/src/properties.test.ts](../packages/testkit/src/properties.test.ts), 2,000 runs nightly ([.github/workflows/ci.yml](../.github/workflows/ci.yml)); failure record in [reports/property-failures.md](../reports/property-failures.md) | Passing |
| Dev hook | [.kiro/hooks/dev-core-tests-on-save.json](../.kiro/hooks/dev-core-tests-on-save.json) runs the core tests when the agent saves under `packages/core/` | Firing in the IDE is **pending** spike S14 |
| Web and IDE | — | **Pending** spike S14 |
| Crew bot | Built in a separate `dnr-crew` repo (local commits only) | Public repo, GitHub App and Crew acceptance are **pending** (Phase 12, spike S16) |

## 6. Try it

- **Hosted Playground:** https://nihalnihalani.github.io/dnr/ (GitHub Pages, deployed from `main` by `.github/workflows/deploy-playground.yml`).
- **The real hook offline:** `dnr demo --live` ([docs/testing.md](testing.md)).
- **Your repository:** `dnr init`, built from source until the npm package is published. The package name is **pending** (Phase 0, `fixtures/pins.json`).

## 7. Limits

[docs/threat-model.md](threat-model.md) lists what DNR defends and its known limits. A hostile process running as the same OS user can always defeat a same-user hook. DNR's goal is that a careless or misled agent cannot re-apply a reverted change without a visible, recorded human decision.
