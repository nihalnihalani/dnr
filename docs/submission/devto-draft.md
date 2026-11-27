# dev.to draft (not published)

> **Draft. Not published.** The maintainer publishes it on dev.to during the submission window, then sets `devto_url` in [links.json](links.json) (plan Phase 14, P14-01). Every fact below comes from a file or commit in this repo, linked inline. Trial numbers don't exist yet, so they're marked **pending**. Before publishing, replace each pending marker with the generated text from [pitch.md](pitch.md), or delete the sentence. Never put a number there by hand.

Suggested tags: `kiro`, `ai`, `git`, `devtools`.

---

## Some changes should stay dead: building DNR with Kiro

*I wrote this post for the Kiroween Hackathon 2026. DNR is our entry in the Frankenstein category.*

A change that was tried and reverted looks like a reasonable cleanup to an agent that never read the ticket. Here's a real Django example. Commit `ea3a71c2d0` changed `Query.clear_ordering`, and `43933a1dca` reverted it, because "self.group_by contains Cols, not aliases" ([reports/orders/README.md](../../reports/orders/README.md)). Ask an agent to tidy that method and nothing tells it the change has been tried before.

**DNR (Do Not Resurrect)** turns a repository's reverts into *do-not-resurrect orders*. A maintainer approves each order. When a Kiro agent's write would bring a reverted change back, a PreToolUse hook ([`.kiro/hooks/dnr-pre-write.json`](../../.kiro/hooks/dnr-pre-write.json)) refuses the write before the file changes. It shows the reason and links to the original commit, the revert and the ticket. Re-landing a fixed version takes one human approval.

On the real Django case, re-applying the change reverted in `43933a1dca` exits 2 with edit score 1.00 in `Query.clear_ordering`. The full stderr is in [reports/orders/README.md](../../reports/orders/README.md), and the `R1:` test in [packages/hook/test/golden.test.ts](../../packages/hook/test/golden.test.ts) pins it.

You can try the matcher in your browser, with no login, at **https://nihalnihalani.github.io/dnr/**. It runs the same `@dnr/core` engine as the hook, compiled for the browser.

### Why Frankenstein

DNR stitches four things that were never meant to meet into one write path:
- the human arguments in a mid-2000s bug tracker (Django's Trac);
- deterministic syntax trees (tree-sitter, [vendor/grammars/](../../vendor/grammars/));
- git's revert graph ([packages/git/](../../packages/git/));
- a nondeterministic 2026 agent.

### How Kiro shaped the build

The repo keeps its Kiro artifacts at the root, tracked in git:
- **Specs.** Two specs, [dnr-check](../../.kiro/specs/dnr-check/) and [trial-harness](../../.kiro/specs/trial-harness/), with EARS requirements R1–R15 and properties P1–P17. Their tasks are ticked only with the SHA of the commit that passed.
- **Steering.** [hook-contracts.md](../../.kiro/steering/hook-contracts.md) keeps two kinds of hook behavior apart: what Kiro's docs verify, and what still needs a spike. [trial-integrity.md](../../.kiro/steering/trial-integrity.md) keeps any agent from touching sealed trial data.
- **Hooks.** Six DNR hooks (pre-write, post-write, guard-shell, post-shell, Stop and session start) plus one dev hook that runs the core tests on save ([.kiro/hooks/](../../.kiro/hooks/)).
- **Custom agents.** A tool-less drafter, [dnr-drafter.json](../../.kiro/agents/dnr-drafter.json), writes one-sentence reasons, and seven trial agents live in [trial/agents/](../../trial/agents/).
- **MCP and a power.** A read-only MCP server with `explain_function` and `list_orders_for_file` ([packages/mcp/](../../packages/mcp/)), packaged as a power in [powers/dnr/](../../powers/dnr/).

To be honest about where this stands: the specs were written outside Kiro IDE spec mode, and the live `kiro-cli` spikes S1–S17 are still pending ([docs/spikes.md](../spikes.md), [docs/kiro-usage.md](../kiro-usage.md)). The hooks are tested today by piping hook-event JSON into the built `dnr` binary.

**Pending:** what the first live headless block under `kiro-cli` showed (spike S1, gate check 1b).

### Our first failing property was our own bug

The spec's properties run under fast-check ([packages/testkit/src/properties.test.ts](../../packages/testkit/src/properties.test.ts)). P1 says an exact re-application scores 1.0 and is blocked. It failed on its very first run, at 500 runs. Shrunk after 11 tests, the counterexample was a Python case with two files, where C changed only `pkg/mod1.py`. The property, though, wrote to `pkg/mod0.py`, a file the order doesn't cover. The engine correctly took the fast path and allowed the write. The property's oracle was wrong, and P8 and P10 had the same bug.

So the first counterexample found a bug in the test, not in the matcher. We wrote that down rather than dressing it up ([reports/property-failures.md](../../reports/property-failures.md)). A second failure, in P15, was also in the generator: an empty Python class renders as `pass`, which C then "removed". After both fixes, the suite passes at 500 and at 3,000 runs.

### The regex surprise came from planning, not the build

While planning, the research showed that a "This reverts commit" search misses most of Django's reverts. Django's usual subject is `Fixed #N -- Reverted "…"`. Searching for "Reverted" finds about twice as many commits per year (17 vs 7 in 2025, by `gh api search/commits`, recorded in the plan's research file `dnr-plan/01-research.md`, which is outside this repo). The fixed query is in [packages/trial/src/mine/known-reverts.ts](../../packages/trial/src/mine/known-reverts.ts). An internal review caught us calling this a build surprise when it was a planning finding ([docs/review-wave1.md](../review-wave1.md), L3), so this post files it under planning.

### What building it turned up

- **Test hunks diluted the real order.** Building the `dnr-43933a1dca` order from Django history pulled in a test hunk as well as the code change. Orders now skip `test_globs` paths, and an exact re-application scores 1.00 ([53bb4d7](https://github.com/nihalnihalani/dnr/commit/53bb4d7)).
- **The plan named the wrong method.** It said `Query.set_group_by`, but the real order says `Query.clear_ordering`, so every prompt and doc was corrected ([9a951a2](https://github.com/nihalnihalani/dnr/commit/9a951a2)).
- **A case-insensitive path bypass on macOS.** Writing `Django/db/…` instead of `django/db/…` slipped past. Paths are now resolved to their on-disk casing ([b3f4301](https://github.com/nihalnihalani/dnr/commit/b3f4301)).
- **Browser–hook parity caught a real bug.** A Playwright test runs the built `dnr check --file` for every Playground preset on Chromium, Firefox and WebKit, and it caught a bug in the matched-units listing ([292e43b](https://github.com/nihalnihalani/dnr/commit/292e43b)).

### Does it matter? The pre-registered trial

The trial is pre-registered ([reports/preregistration.md](../../reports/preregistration.md)) and labeled blind. It compares three arms on the same cleanup tasks: no DNR, a steering file generated from history (our build of New Math Data's approach), and DNR live.

**Pending:** the results: how many runs landed a reverted change in each arm, how often existing tests caught it, and κ. They come from `reports/video/numbers.json` after the trial runs (Phase 11) and are pasted from [pitch.md](pitch.md).

### Limits

A hostile process running as the same OS user can always defeat a same-user hook. DNR's goal is narrower: a careless or misled agent can't re-apply a reverted change without a visible, recorded human decision. The known gaps are listed in [docs/threat-model.md](../threat-model.md#known-limits).

Code: https://github.com/nihalnihalani/dnr (MIT).
