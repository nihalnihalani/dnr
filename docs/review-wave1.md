# Wave 1 review (commit 59f5040)

This is the devil's advocate's adversarial review of commit `59f5040`, "Add engine, schemas, grammars, testkit and Kiro artifacts (wave 1)", against the plan (`kiroween/dnr-plan/`) and `docs/acceptance-matrix.md`. It was reviewed on November 26, 2026. Findings are ranked by severity, and each has a location and a concrete fix. Mining's work is uncommitted and in progress, so it is reviewed only where wave 1 depends on it.

## What I ran

| Command | Working tree (wave 1 + uncommitted mining) | Clean export of `59f5040` (`git archive` + `pnpm i --offline`) |
|---|---|---|
| `pnpm test` | **pass**: 18 files, 147 passed, 1 skipped | **fail**: 6 of 12 files fail with `Cannot find module './trial-inputs'` |
| `pnpm typecheck` | pass | **fail**: `fixtures.test.ts(10,35): TS2305 … 'KnownReverts'` |
| `pnpm lint` | **fail**: 2 errors, both in mining's uncommitted `packages/trial/src/mine/` | pass |
| `node scripts/check-grammar.mjs` | pass: python ABI 15, typescript and tsx ABI 14; sha256 values match PROVENANCE.md | same |
| `pnpm -F @dnr/schemas test` | pass (9 passed, 1 skipped) | fails, same cause |
| `DNR_FC_RUNS=2000 vitest run packages/testkit/src/properties.test.ts` | pass: 15 tests in 45 s | not run |

**Mutation check.** In a scratch copy of the engine I made eight deliberate bugs and re-ran the suite to see whether any test catches each one. Seven were caught. One survived: dropping the whole-order "missing unit" cap (finding H6).

| Bug introduced | Failing tests | Caught? |
|---|---|---|
| Two-sided rule always true | 2 | yes |
| Weight-0 tokens counted | 10 | yes |
| Small-order cap removed | 1 | yes |
| **Missing-unit cap removed** | **0** | **no** |
| Degraded cap removed | 1 | yes |
| R side scored against A′ | 10 | yes |
| Warned set ignored | 2 | yes |
| Re-landed cap removed | 1 | yes |

**Real demo orders.** I built both demo orders from the real Django texts in `$DJANGO_SRC` (`C^`, `C`, `R`) with `buildOrder`, then re-applied each source file on its own. This was a scratch test and is not committed.

| Order | Units | w(A) + w(R) | Exact re-application | One file re-applied |
|---|---|---|---|---|
| `dnr-43933a1dca` | 1 unit, `Query.clear_ordering`, kind modified, A = 16, R = 0 | 16 | edit 1.000, **block** | **block** (single file) |
| `dnr-d0e4dd5cdd` | 18 units in 6 files | 77 | edit 1.000, block | **warn_block** in every file; edit is 0.338, 0.234, 0.195, 0.078, 0.078 and 0.078 |

## Findings

### Critical

**C1. `59f5040` does not build or pass on a clean checkout.**
- *Where:* `packages/schemas/src/index.ts:8` exports `./trial-inputs`, and `packages/schemas/test/fixtures.test.ts:10` imports `KnownReverts`, `KnownRevertsRejected`, `Candidate` and `DjangoPython`. All of them live only in `packages/schemas/src/trial-inputs.ts`, which is untracked (`git status`: `?? packages/schemas/src/trial-inputs.ts`).
- *Effect:* the green run in the working tree depends on mining's uncommitted file. CI on Node 24 and 26 goes red on the first push. Six test files fail, including every property test and P16, so nothing in wave 1 is proven at the commit itself. The same failure hits anyone who clones the repo, a judge included.
- *Fix:* mining commits `trial-inputs.ts` now, on its own, before more mining work. Until then, drop that export and the import. Add a pre-commit or CI-parity check that runs on a clean clone: `git stash -u && pnpm typecheck && pnpm test && git stash pop`, or a `git worktree` of `HEAD`. Merge each wave only after a clean-clone run.

**C2. The demo prompts, S11 and the judges' test path all name a method the order does not cover.**
- *Where:*
  - `scripts/demo/prompts/cleanup.txt:1`: "Clean up Query.set_group_by …"
  - `scripts/demo/prompts/write.txt:1`: "restore the change that commit ea3a71c2… made to the method Query.set_group_by"
  - `docs/testing.md:25`
  - `docs/spikes.md:19`, the S11 command
  - `powers/dnr/skills/dnr-guard/SKILL.md:16`
  - `README.md:31`
- *Effect:* commit ea3a71c2d0 changed `Query.clear_ordering` (`django/db/models/sql/query.py:2341` at `R^`); the real-order run above confirms the order's only unit is `Query.clear_ordering`. The cleanup prompt sends the agent to `set_group_by`, which is not covered, so `demo/T`, `demo/L`, S11 and README#testing step 2 can neither block nor warn. `write.txt` points the agent at the wrong method and tells it to "write that commit's version of the method exactly". The plan's matrix drift item D-10 predicted this.
- *Fix:*
  1. Replace `set_group_by` with `clear_ordering` everywhere above.
  2. Generate the prompts from `fixtures/pins.json` `demo_cases[].qualname`, which is resolved from git.
  3. Add a test that the qualname in each prompt is a unit of the built demo order.

### High

**H1. Agent configs carry a template, not a model.**
- *Where:* `"model": "{{pins.model}}"` appears in `.kiro/agents/dnr-drafter.json:5`, `.kiro/agents/dnr-gate-1b.json:4` and all seven `trial/agents/trial-*.json`. `powers/dnr/plugin.json` has `{{builder_handle}}` and `{{repo_url}}`.
- *Effect:* `kiro-cli --agent dnr-gate-1b` reads the file as it is. The gate-1b retry is the D1 fallback, so it would fail on an invalid model ID, and `dnr draft` would fail the same way. No renderer exists yet.
- *Fix:*
  - Leave `model` out of the `.kiro/agents` files until P0-04 pins one; Kiro uses its default. Then commit the concrete ID.
  - For `trial/agents`, have `trial prepare` render the template into the per-run HOME, and test that it does.
  - Add a CI step that fails on `{{` in `.kiro/**/*.json` and `powers/**/*.json`.

**H2. The second demo order cannot block a single-file task; the real data confirms plan risk 4.**
- *Where:* the `dnr-d0e4dd5cdd` row in the real-order table above (18 units in 6 files; one file re-applied never blocks).
- *Effect:* this demo case only ever warns. The Playground's "half of a two-file change" preset will show WARN. Every multi-file trial order behaves the same way.
- *Fix:* pre-register a per-file sub-order rule before tuning. A write blocks when one file's units have weight ≥ `min_order_weight` and that file's edit ≥ τ with the two-sided rule. If that is not adopted, replace `d0e4dd5cdd` as demo #2 with a single-file order of weight ≥ 8, and report Z/X by `c_file_count`. `dnr-43933a1dca` is A-only, so the two-sided rule is trivially true for it. Say so where the demo explains the rule.

**H3. The only "Django" test uses invented code and links that look real.**
- *Where:*
  - `packages/core/src/__tests__/django-fixture.ts:1-5`: "A small Django-like fixture (written for these tests…): C adds a select-related guard to Query.set_group_by". Django never made that change.
  - `packages/core/src/__tests__/helpers.ts:11-13`: `https://github.com/django/django/commit/cccc` and `…/a1b2`.
  - `django.test.ts:42`: "builds one modified unit, Query.set_group_by".
- *Effect:* a judge who reads the tests (Xu, Velso) sees a fabricated case standing in for the headline demo.
- *Fix:*
  - Add a real-text test from `ea3a71c2d0^`, `ea3a71c2d0` and `43933a1dca` for `query.py`, as a fixture file. NOTICE already covers BSD-3 Django excerpts. Assert the unit `Query.clear_ordering`, `w(A) = 16`, `w(R) = 0`, a block at 1.0, and that a one-line unrelated edit warns.
  - Keep the invented fixture only as "synthetic", with `example.test` URLs.

**H4. The README states trial results that don't exist, and shows a made-up block.**
- *Where:* `README.md:9` says "The trial was pre-registered and labeled blind, and every run is public." `README.md:31` shows `edit 0.92 ≥ 0.60 in Query.set_group_by`. The real exact re-application scores 1.00 in `Query.clear_ordering`.
- *Effect:* making the repo public is step 4 on the critical path, so this goes out within days. A false front-page claim is the kind of thing judges remember.
- *Fix:* until Phase 11, the README says "Trial: pre-registration in progress" and shows a block message captured from real `dnr check` output, regenerated by script. Keep the `{{…}}` slots out of public files, or render them as "pending".

**H5. P12 passes for the wrong reason.**
- *Where:* `packages/testkit/src/properties.test.ts:340-385`.
- *Effect:* the test makes the re-landed head the session baseline, so any unrelated edit scores 0 whatever the `relanded` flag says. It still passes with the flag removed. The behaviour P12 exists for is untested: the crossing rule after a re-land, and "re-landed only warns".
- *Fix:* add two assertions.
  - `isCrossing(order, snapshot, head, head + unrelated edit).crossing === false`, with `isRelanded(order, snapshot, head)` true.
  - With baseline = snapshot and `relanded: true`, an edit to a covered unit gives `warn_block`, never `block`, and with `relanded: false` the same state blocks. That proves the flag matters.

**H6. "A missing unit caps the whole order to warn" is untested, and it can be used to evade a block.**
- *Where:* `packages/core/src/score.ts:140` and `:183`, `const capped = small || degraded || missing`. Removing `missing` from that line passed all 110 engine tests.
- *Effect:* one missing covered `modified` unit, deleted or renamed below the 0.7 fingerprint floor, downgrades the whole order. An agent that re-applies C in unit A while deleting covered unit B gets one `warn_block`, then `warn_pass`. The §5.5 missing-unit table reads per unit ("if nothing matches above the floor, the warn tier"); the code picked the reading that is easiest to evade.
- *Fix:* score a missing `modified` unit as unmatched: its weight counts in the denominator, and both of its intersections are 0. Mark the order "missing" for reporting only. The re-application in the other units can then still cross τ. Add a test for exactly this evasion, and a test that fixes the chosen behaviour so the mutation is caught.

### Medium

**M1. P10 tests only half of its statement in core.**
- *Where:* `decide.ts:48`. `grantApplies` is a predicate the caller passes in.
- *Effect:* "only while it is unexpired, or already used in that session" is never exercised. That is acceptable in core, but PROP-P10 is only partly proven.
- *Fix:* the hook/store wave tests TTL expiry with `DNR_NOW` and the "used this session" path, under the test name `P10:`.

**M2. The specs don't trace to commits and weren't made in Kiro.**
- *Where:* `.kiro/specs/dnr-check/tasks.md`, tasks 0.1, 0.2 and 0.4.
- *Effect:* those tasks are done in `59f5040` but unticked, with empty `commit:` slots. The specs were written by hand, not in Kiro IDE spec mode (05 §12.1). The Tech criterion is scored on the trace "spec → task → commit → hook", and a Kiro PM judge can tell.
- *Fix:* tick tasks 0.1, 0.2 and 0.4 with `59f5040`, and tick each later task as it lands. The user opens the repo in the Kiro IDE, regenerates or refines `dnr-check` in spec mode, and runs at least the Phase 2 and Phase 5 tasks from there (matrix KIRO-01).

**M3. Git hooks aren't protected, and `--no-verify` is not guarded.**
- *Where:* `packages/core/src/protect.ts:22`. `.git/hooks/**` and the `core.hooksPath` target are not protected, and no guard-shell rule covers `git commit --no-verify` / `-n` or `git config core.hooksPath`.
- *Effect:* under `commit-enforce` (the D1 fallback), the pre-commit shim is the only local enforcement, and an agent can delete it or skip it. This is a gap in the plan, not only in the code.
- *Fix:* protect `$(git rev-parse --git-path hooks)/**`. Add a guard-shell rule R8 that denies `--no-verify`, `-n` on commit, and `core.hooksPath` changes, together with the macOS `osascript`/`open -a Terminal`/`tmux send-keys` approval bypass from the matrix risks. List the remainder in `docs/threat-model.md`.

**M4. Held-out recall can quietly lose mutants.**
- *Where:* `packages/testkit/src/mutate.ts:686`: "seeds whose operator does not apply are skipped".
- *Effect:* gate check 2's denominator, 70 mutants, can shrink without anyone being told.
- *Fix:* count a seed that doesn't apply as a miss, or fall back to the next target unit. Record N in `gate.md`, and fail the gate when N < 70 unless that is explained.

**M5. There is no nightly 2,000-run property job.**
- *Where:* `.github/workflows/ci.yml` has no `schedule`.
- *Effect:* matrix row P4-02 stays open.
- *Fix:* add `on.schedule: cron` with `DNR_FC_RUNS=2000`. It took 45 s here.

**M6. This repo's own Kiro sessions will be told to use an MCP tool that doesn't exist.**
- *Where:* `.kiro/steering/dnr.md` is `inclusion: always`, and `.kiro/settings/mcp.json` launches `dnr mcp`.
- *Effect:* `dnr.md` is the user-facing steering that `dnr init` ships. Active in this repo, it tells every Kiro session to "call `explain_function`" through an MCP server that doesn't exist until Phase 12.
- *Fix:* move it to a template that `dnr init` installs, or set `inclusion: manual` here until `dnr mcp` exists.

**M7. `pnpm test:fixtures` passes with no fixtures.**
- *Where:* `packages/schemas/test/fixtures.test.ts:24`, `skipIf(!existsSync)`.
- *Fix:* once mining commits, make `known-reverts.json` and `pins.json` required.

**M8. Lint is red in the working tree.**
- *Where:* mining's `packages/trial/src/mine/analyzer.ts` (format) and `packages/trial/src/mine/mine.test.ts:1` (import order).
- *Fix:* mining runs `pnpm biome check --write` before committing.

### Low

**L1. Block-message truncation cuts the wrong end.**
- *Where:* `decide.ts:349`.
- *Effect:* it keeps the first 1,199 characters, so the line that is dropped is "Do not … route around … only a human …" with the recovery commands.
- *Fix:* truncate the reason (capped at 280) and the URLs, never the third line.

**L2. Docs I verified, plus two gaps.** I checked `hook-contracts.md` against kiro.dev `hooks` and `hooks/types` (page updated November 24, 2026). These match the "verified" rows: the trigger IDs `PostFileSave` and `Stop`, the v1 file shape, unanchored regex matchers, and the Web trigger list. Two gaps:
- The docs list a `PermissionRequest` trigger (CLI 3.4+), which the contracts don't mention. S5 and S15 should capture whether an `ask` approval goes through it.
- The `write` category covers "built-in file write tools" only. An MCP tool that writes files bypasses pre-write. Note it in the threat model, and consider adding an `@mcp` matcher whose path-bearing calls go to the unknown/warn tier.

**L3. The write-up's "surprise" is a planning finding.**
- *Where:* `docs/kiro-usage.md` 3b.
- *Effect:* it presents the regex miss as a surprise found during the build, but it came from planning research.
- *Fix:* replace it with a real build-time finding. `reports/property-failures.md` is honest and specific, and its P1 oracle bug is a good candidate.

## What wave 1 got right

- `records.ts` matches §7 field for field.
- `DnrConfig` is strict and has the §7 defaults.
- The six hook JSONs match §6 exactly, including no matcher on Stop, timeout 30, and the PostToolUse confirm hooks.
- The `.gitignore` drift item is fixed: only `.dnr/orders/` and `.dnr/config.json` are committable.
- The scoring code follows §5.5 and §5.6 as written:
  - weighted multisets with A and R kept separate;
  - the two-sided rule and the small-order cap;
  - n⁺ clamping and baseline-relative `prox_u`;
  - same-file new-unit pairing and size-weighted aggregation;
  - prox not subject to the two-sided rule;
  - fingerprint relocation scored against the baseline at the original location.
- The P1, P8 and P10 oracle bug is fixed, because properties now write to `orderFile(c)`.
- The P15 A-only generator bug is fixed.
- `reports/property-failures.md` is honest that no engine property has failed. It correctly routes the video's Kiro chain to the spike fallback.
- The P3 and P4 reference implementations are independent of the engine code.
- TS tokenization, TS qualnames and TS mutation operators are already in.
