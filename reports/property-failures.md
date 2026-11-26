# Property failures

Plan §12.1 requires recording the first property that failed, its fix and the re-run.

## First failure: P1 (exact re-application blocks). The cause was the test harness, not the engine

- **When:** the first run of `packages/testkit/src/properties.test.ts` at 500 runs (2026-11-26, engine workstream, before any commit). P8, P10 and P15 failed in the same run.
- **Property:** P1. An exact re-application has edit score 1.0, and it is blocked when the order meets `min_order_weight`.
- **Counterexample (shrunk by fast-check, after 11 tests):** a Python case with two files. Commit C changed only `pkg/mod1.py`: it added `func_1`. The property called `decide` with `target = files[0]` (`pkg/mod0.py`), a file the order does not cover.
- **Observed:** `outcome: 'allow'` with `fast_path: true`. The expected outcome was `block`.
- **Diagnosis:** the engine was correct. A write to a file that no order covers takes the fast path (§5.4), and the write that re-applied `mod1.py` is scored when it happens. The property's oracle was wrong: it took the target to be the first generated file rather than a file the order covers. P8 and P10 had the same bug.
- **Fix:** the properties now write to a file the order covers (`orderFile(c) = order.units[0].file`). No engine code changed.

## Second failure: P15 (crossing commit, A-heavy split). The cause was the generator, not the engine

- **Counterexample (after 2 tests):** a Python class `Widget` with no attributes, where C added both of its methods. The "A side only" parent was built by applying every `ins` change. The property then expected `iR = 0` and got `iR = 1`.
- **Diagnosis:** the renderer emits `pass` for a class body that would otherwise be empty, so C also *removed* the token `pass`. The "A-only" parent therefore applied the R side too. The engine scored that state correctly.
- **Fix:** generated classes always have at least one attribute (`packages/testkit/src/arbitraries.ts`), so no state renders a placeholder `pass` that C would remove. This keeps P15's "lands only the A side" premise true by construction.

## Re-run

- After both fixes, all 15 property tests pass at the default 500 runs. They also pass at 3,000 runs (`DNR_FC_RUNS=3000`), which is above the 2,000 nightly target, in about 65 s.
- The only failure at 3,000 runs was vitest's 5 s default test timeout. The property suite now sets `testTimeout: 600_000`.

## Engine properties: none failed

No P1–P17 property has found an engine bug so far. The two failures above were oracle and generator mistakes in the tests. This file records them honestly because they are the first failures that occurred. For the video's Kiro chain, use the plan's fallback (spike finding → `hook-contracts.md` decision → hook change → gate fix commit), unless a later phase records a real engine failure here.

| Property | Where | Status |
|---|---|---|
| P1, P2, P3, P4, P5, P7, P8, P10, P12, P14, P15, P17 | `packages/testkit/src/properties.test.ts` (Python and TypeScript generators) | pass, 500 and 3,000 runs |
| P16 | `packages/testkit/src/mutate.test.ts` (move-to-file held-out seeds 3100–3104, Python and TS) | pass |
| P9, P11, P13 | Playwright, gate metric, hook (Phases 5–10), outside the engine | not run here |
