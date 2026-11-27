# Reason codebook

The codebook both labelers use for blind reason-category labeling (plan §9.1 step 4, §9.5). Each revert gets exactly one category from the §7 enum (`ReasonCategory` in `packages/schemas/src/trial-inputs.ts`). This file is hashed in `prereg-v1` (§9.7). Change it only before the tag, and only in a commit that says why.

## What the labeler sees

Each packet from `dnr trial label --reasons --labeler <name>` shows:

- C's diff;
- R's commit message;
- the ticket and PR text in `fixtures/discussion/<sha10>.json`.

The rule engine's proposal (`reason_proposal` in `fixtures/candidates.jsonl`) is hidden. Don't look it up while labeling.

## The question

**Why was C reverted?** Label the reason the maintainers gave, or the reason the discussion makes plain. Don't label what C changed. When several reasons appear, take the one that decided the revert: usually the first reason in R's message, or the one the ticket says triggered it.

## Categories

| Category | Eligibility | Use when the revert happened because… | Typical evidence |
|---|---|---|---|
| `CORRECTNESS_REGRESSION` | eligible | C made existing behavior wrong: wrong results, wrong SQL, a wrong value or state, a broken feature, with no crash being the main complaint | "regression", "incorrect", "broke X", a ticket showing wrong output |
| `CRASH` | eligible | C made code raise, hang or crash where it used to work | a traceback, an `…Error`, "crashes when …" |
| `BACKWARD_INCOMPAT` | eligible | C broke users' or third-party code that relied on documented or long-standing behavior, even though C's own behavior was arguably correct | "backwards incompatible", "broke third-party packages", a deprecation path that was skipped |
| `PERFORMANCE_REGRESSION` | eligible (own stratum) | C made something measurably slower or use more memory or queries | benchmarks, "N+1 queries", "slowdown" |
| `API_POLICY_REVERSAL` | secondary | the project changed its mind about the API or the policy itself (an undeprecation, a feature it decided not to have), with no defect in C | "we decided not to deprecate", a mailing-list or forum decision |
| `RELEASE_TIMING` | ineligible | C was fine but landed at the wrong time (feature freeze, wrong release, to be re-landed later) | "too late for 5.0", "postponed" |
| `ACCIDENTAL_COMMIT` | ineligible | C was committed by mistake: the wrong branch, an unfinished patch, or a duplicate push | "committed by mistake", "accidentally" |
| `CI_INFRA` | ineligible | C changed CI, build or tooling configuration, and the revert is about that | `.github/`, `tox.ini`, `setup.cfg`, linters |
| `TEST_ONLY` | ineligible | C changed only tests or test infrastructure | only `tests/` files (and docs) |
| `DOCS_ONLY` | ineligible | C changed only documentation | only `docs/`, `.txt` or `.rst` files |
| `FRONTEND_ONLY` | ineligible | C changed only JavaScript, CSS, templates or images, and the reason is about them | admin JS or CSS only |
| `DUPLICATE_SUPERSEDED` | ineligible | C was replaced by a better fix, or duplicated another commit | "superseded by #…", "in favor of …" |
| `OTHER` | ineligible | none of the above fits, or the record gives no reason at all | an empty message and no ticket |

## Tie-break rules

Apply these in order:

1. **File scope first.** If C touched only docs, only tests, only CI, or only frontend files, use that category, whatever the message says.
2. **Defect beats policy.** If the record shows a concrete defect (wrong result, crash, slowdown, broken users), use the defect category, even if the revert also mentions policy.
3. **Crash vs. correctness.** Use `CRASH` only when an exception, hang or crash is the reported failure. Wrong output without an exception is `CORRECTNESS_REGRESSION`.
4. **Backward incompatibility vs. correctness.** If C did what it meant to do but broke code that depended on the old behavior, use `BACKWARD_INCOMPAT`. If C itself was wrong, use `CORRECTNESS_REGRESSION`.
5. **No evidence, no guess.** If neither the message nor the discussion gives a reason, label `OTHER`. Don't infer a reason from the diff alone.

## Disagreements and κ

- Each labeler labels alone. Cohen's κ over the two labelers' first answers is reported in `reports/eligibility.md` (§9.1 step 4, P3-18).
- Where the two disagree, the adjudicator (`reports/labeling/labelers.json`) picks the final category, and it is recorded with `adjudicated: true` in `fixtures/reason-labels.json`.
- E6 uses the adjudicated label when there is one, and otherwise the agreed label.
