# Wave 3 review: trial harness, no-mock sweep, Crew bot

This is the devil's advocate's review from November 27, 2026. It covers:
- the trial harness in `3d50c72`;
- the fixes in `88b81bf`, `2cc138e`, `290e805` and `2b86e58`;
- the Crew bot (`/Users/nihalnihalani/Desktop/Github/dnr-crew`, which has local commits only, up to `766fc03`).

The yardstick is the plan, `docs/acceptance-matrix.md`, and the new AGENTS.md rule: no mocks, no seeded data, fail loudly.

## What I ran

| Repo | Result |
|---|---|
| `dnr`, clean clone of HEAD `2b86e58` | Frozen install, typecheck and lint are clean (1 info). 490 tests pass, 11 skipped |
| `dnr-crew`, clean clone | Without the real CLI, the suite **fails loudly**: "The real dnr CLI is required: … set DNR_CREW_TEST_DNR_BIN". That is correct under AGENTS.md. With `DNR_CREW_TEST_DNR_BIN` pointing at the built `dnr-guard`: 98 pass, 1 skipped. A rebuild leaves `dist/bot.js` unchanged, so the committed bundle matches `src/` |
| §9.8 table | The table in `packages/trial/src/decision.ts` and the one in the plan's `06-trial-protocol.md` are byte-identical when extracted and diffed. The three pre-registered wordings (D5 null result, D1 study failed, D6 inconclusive) also match the plan word for word |

## 1. Trial integrity

### What holds

**Isolation**
- The truncated repo (`repo.ts:13-28`) drops `FETCH_HEAD`. `checkNothingNewer` checks both reachability from `--all` and committer dates.
- Each run gets its own `git clone --no-local`, with `origin` removed.
- `TRIAL_ROOT` must be absolute, outside `ROOT`, must not contain `ROOT`, and must not be a sibling of it. The check uses `realpathSync.native` (`env.ts:53-60`).
- The agent's environment is an allowlist: `PATH`, `LANG`, `TMPDIR`, `KIRO_API_KEY`, `USER`, `SHELL`, plus `HOME` and the run's `DNR_*` variables (`runner.ts:39-47`). `ROOT`, `DJANGO_SRC` and `TRIAL_ROOT` are not passed.
- A provisional case or an unpinned model is refused outside dry runs (`prepare.ts:81,178`).

**Labels and replay**
- `trial replay` refuses until `label --freeze` (`commands.ts:657`).
- The freeze needs both raters on every packet and κ ≥ 0.4 in every session.
- The packet key is released only if its sha256 matches the committed one (`P11-08`, `P11-09`, `TRIAL-10`).

**Scoring and rescore**
- `rescore --check` recomputes from the same sealed inputs and compares every field.
- It also checks every run's frozen-config sha256 against `prereg-v1`.
- I found no clock or randomness in `score.ts`, `stats.ts` or `report.ts`.

**Measures** (`score.ts:155-300`), each checked against §9.6:

| Measure | Code | Verdict |
|---|---|---|
| X | arm T, replicate 1 | matches |
| K_eff | T, S and L all ok, on the restored subset when D6 routes there | matches |
| X_eff, S_eff, W_L | counted over K_eff | matches |
| W | of T's re-applied reverts, those where L still landed | matches |
| Q | L runs with at least one blocked proposal labelled FULL or CORE | matches |
| Q_false | NONE labels on blocked proposals | matches |
| Y | among T re-applications, existing tests fail | matches |
| Z | the sealed replay blocked T's own order | matches |
| F/N | false-alarm scan plus H runs DNR would block that weren't re-applied | matches |
| Oracle order | valid restored tests first, then the adjudicated label (§9.4) | matches |

**Dry runs**
- They are honest. Each run writes `agent: "not run"`, its checks and its notes, and redirects reports to `$TRIAL_ROOT/dry-reports`.
- They don't claim more than they test. They also don't prove anything that depends on agent behaviour, such as the HOME hash after a real run, transcripts, or path touches.

### Findings

**T1 (Critical). A run can read future history and other runs, and the harness doesn't notice.**
- *What is not locked:* `lockdownTargets` (`lockdown.ts:15-29`) locks only the plan's list. Under the same OS user, each of these stays readable to the agent:
  - `$TRIAL_ROOT/repos/<sha>` for **later** reverts: newer Django history;
  - `$TRIAL_ROOT/orders/<other run>`: order sets that contain later reverts;
  - `$TRIAL_ROOT/out/<other run>` and `runs/<other run>`: earlier transcripts and diffs, including other arms;
  - `$ROOT/reports/orders/*.json`: every order with its A/R tokens;
  - `$ROOT/fixtures/candidates.jsonl` and `assignment.json`: every revert and its C SHA.
- *Where detection misses it:* the only detector, `pathsIn` (`transcript.ts:74-87`), flags tokens that start with `/` or `~`. A shell command like `cat ../../../../repos/<sha>/django/…` or `ls ../../../../out` is never flagged.
- *The primary arm sees its own order:* for T, U, B, H and L, the run's order directory is exported as `DNR_ORDERS` (`run.ts:226-233`) and inherited by the agent's shell. `cat $DNR_ORDERS/*.json` shows the agent the reason, links and A/R tokens of its own target order, so T would effectively be S. `$DNR_ORDERS` isn't an absolute token, so it isn't flagged either.
- *Fix:*
  1. Extend the lockdown to `$ROOT` as a whole and to `$TRIAL_ROOT/{repos,orders,out,runs,homes,state}` of every run **except** the one executing. That means running each agent as a separate OS user, or under `kiro-cli --sandbox` if S1 shows it confines the file and shell tools; record which in `docs/spikes.md`. A per-run `chmod 000` on siblings doesn't work at concurrency 4.
  2. Pass the hook configuration through a 0600 file in a directory the agent's tools can't reach, instead of through `DNR_*` in the agent's environment. If S8 shows hooks inherit the environment, give the hooks a different variable set from the agent's shell.
  3. In `pathsIn`, resolve relative tokens against the working directory and any preceding `cd`, and expand `$VAR` and `${VAR}` with the run's environment. Flag every hit under `$TRIAL_ROOT` outside the run's own working copy and HOME.
  4. Pre-register the widened lockdown as a dated amendment to §9.3.

**T2 (High). `score()` computes every headline number and has no test.**
- *Where:* `packages/trial/src/scoring.test.ts` tests `decide`, `compareResults` and `orderSizeBucket`. Nothing calls `score()` (`score.ts:150-400`), the function that produces X, K_eff, X_eff, S_eff, W, W_L, Q, Y, Z and F/N, the video numbers and `trial.json`.
- *Effect:* a mistake in a single filter would go into the pre-registered result unnoticed. P11-11 and P11-12 can only show it is *deterministic*, not *correct*.
- *Fix:* add `score()` tests on constructed manifests, labels and sealed records: a pure-logic test with test-only inputs that never touch `reports/`. Cover:
  - a K_eff exclusion;
  - the D6 restored-subset path;
  - W pairing;
  - a Q blocked proposal labelled NONE;
  - Y with tests `could-not-run`;
  - Z from `own_order_blocked`;
  - an H false block.

  Name them after TRIAL-11 / P11-11.

**T3 (High). Blinding of the builder (labeler 1) is procedural only.**
- *Effect:* during labelling, `$TRIAL_ROOT/out/trial/<arm>/<sha10>/r1/diff.patch` and the L `state/…/events.jsonl` are readable, with the arm in the path and live block decisions. A packet's diff can be matched to its run by content, so "blind to arm" rests on discipline.
- *Fix:* `label --generate` moves `out/`, `runs/` and `state/` into a sealed archive and refuses while they are readable. The archive is a lockdown entry, or is encrypted with a key the adjudicator holds. `replay` unseals it after `--freeze`. Record the archive's hash in the packet key.

**T4 (High). A real `trial run` goes ahead without spike S8.**
- *Where:* with `fixtures/s8.json` missing, `home.ts:28-34` uses no credential file and no exclusion globs. `run.ts:259-262` then only *notes* a HOME hash change.
- *Effect:* every real run's HOME hash will differ, because Kiro writes there, so P11-05 fails after the credits are spent. AGENTS.md says to fail loudly instead.
- *Fix:* a non-dry `trial run` and `trial probe` exit 69 with "spike S8 not recorded (fixtures/s8.json)" before starting any run.

**T5 (Medium). The frozen-config check is a substring match.**
- *Where:* `commands.ts:733-736` checks that `pre.includes(c)`, so any sha256 that appears anywhere in the prereg file passes.
- *Fix:* parse the "Hashed inputs" table and compare the `.dnr/config.json` row exactly.

## 2. No-mock sweep (AGENTS.md)

I swept both repos for `mock`, `fake`, `stub`, `dummy`, `placeholder`, `illustrative`, `simulat`, `invented`, `fabricat`, `seeded`, `{{` and `OWNER/`. Excluding reviews and the matrix, here is everything found and a verdict.

| Where | What | Verdict |
|---|---|---|
| `docs/spikes.md:37-43` | `{{credits_requested_at}}`, `{{labeler_2}}` and other `{{…}}` slots in the Phase 0 records table | **Must go.** Replace with "pending (user)" until filled. These are placeholders where readers look |
| `docs/kiro-usage.md` (whole file) | the write-up skeleton full of `{{…}}` | **Must not ship as is.** It is labelled a skeleton, so it is OK in the repo for now. Generate it from `numbers.json` before submission, or leave slots as "pending"; never render the braces publicly |
| `packages/core/src/build-order.ts:196-197` | fallback reason text `Placeholder: <sha> was reverted …; reason not yet drafted.` | **Must go.** It is invented text that can reach a block message. The CLI always passes the revert subject, so make core throw when no reason is given |
| `reports/orders/*.json`, `packages/cli/templates/demo/*.case.json` | `reason_source: "placeholder"`, with the reason set to the real revert subject | **Legitimate.** It is a §7 state, and the text is real. The Playground and the board should label it "reason not drafted yet" wherever the reason is shown |
| `packages/core/src/__tests__/synthetic-fixture.ts`, `synthetic.test.ts` | invented Python code, labelled "SYNTHETIC … Django never made this change" | **Legitimate** as a pure-logic test. It is now redundant with the real `django-43933a1dca` fixture; deleting it costs nothing and removes a question a judge might ask |
| `packages/testkit` generators (P1–P17) | fast-check programs | **Legitimate.** These are property tests of pure logic |
| `packages/trial/src/scoring.test.ts:249-330` | label lines from labelers `b`, `o` and `a` | **Legitimate.** They test freeze logic, are never written to `reports/`, and the labeler names are obviously test values |
| `apps/playground` "Approve (simulated)" and "Allow once (simulated)" | browser-local state changes, labelled everywhere | **Legitimate.** This is the Playground's simulation of maintainer actions on real orders, as §10 says |
| `packages/cli/test/cli.test.ts:47` | `guard: opts.guard ?? (() => ({ ok: true }))`: every CLI test stubs the R6 human guard by default | **Acceptable**, because the guard is tested on its own in `ancestry.test.ts`. But no test proves `bin.ts:22` wires in the *real* guard. Add one end-to-end test that runs the built `dnr allow` with no TTY and expects a refusal |
| `dnr-crew/test/fixtures/github-rest/*.json` | GitHub's documented REST example objects, pinned to `github/rest-api-description@36dd877` | **Legitimate**, and labelled. They feed pure decision functions. They are not live data and the README says so |
| `dnr-crew/test/fixtures/shop.bundle`, `shop.json` | a generated repo: a real `git revert` plus the real `buildOrder` (`scripts/gen-shop-fixture.ts`) | **Legitimate** |
| `fixtures/known-reverts.json` | `confirmed_by: "unconfirmed:auto-form-match"` on all 68 entries | **Honest.** P0-27 stays needs-user. No human confirmation is faked |
| `reports/human-reproposals.md` | raw text-match counts marked "Draft … needs a person to confirm" | **Honest.** Don't cite them until a person confirms them |
| `reports/preregistration.md` | "DRAFT — not tagged", with a Missing list | **Honest** |
| `dnr-crew/.github/workflows/dnr.yml:100`, `action.yml:14`, `README.md` links | `OWNER/dnr-crew@v1`, `OWNER/dnr` | **Must go before publishing** (C2 below). It fails loudly on GitHub today, which is acceptable only while unpublished |

The board, the Playground and `/trial` have no sample or seeded data left. `290e805` removed them; `routes.spec.ts:162` asserts that no label matching `/fake/i` exists.

## 3. Crew bot

### What holds

**`pull_request_target` safety.** The job checks out the **base** commit (`dnr.yml:91-96`). Head commits are fetched as objects and never checked out (`src/git.ts:3,72-77`). The range check uses a `commit-tree` commit with head's tree and base as parent. Orders and mode come from the base commit. No PR-head code is executed.

**Identity.**
- Check runs and comments are posted with the App installation token.
- The Actions job is named `dnr-scan`; protection pins `dnr` to the `app_id`.
- The comment filter requires all of:
  - `performed_via_github_app == null`;
  - `user.type == 'User'`;
  - no `[bot]` suffix;
  - not a configured Crew identity.
- The bot re-checks `performed_via_github_app` and permission through the REST API (`src/rules.ts:48-123`).
- A change to `.github/**` or `.dnr/**` fails unless the author is a human with write access or above.

**HMAC grants** (`src/grant.ts`):
- domain-separated (`dnr-grant/v1`);
- canonical JSON;
- re-derived over exactly the known fields, so no extra keys ride along;
- bound to the lower-cased repo and the PR number;
- applied only while the order's file blobs match;
- compared in constant time;
- read only from the bot's own comments.

**Secrets.** All three are `dnr-grants` environment secrets, and the environment is limited to protected branches. The caller's `GITHUB_TOKEN` is `contents: read`. `acceptance.sh` checks that none of the three is a repo secret.

### Findings

**C1 (High). `acceptance.sh` reports A1 as PASS without a Crew session.**
- *Where:* `scripts/acceptance.sh:146-158`. Without `--crew-pr`, A1 opens a scripted PR labelled "(scripted, not Crew)" but records PASS. With every token given, the script exits 0.
- *Effect:* Phase 12 requires "a scripted **Crew session** re-applies 43933a1dca", so an exit 0 would overclaim.
- *Fix:* when `--crew-pr` is absent, record A1 as `PENDING (scripted PR, not a Crew session)` and exit 3.

**C2 (High). The Crew bot would install a DNR version that predates the wave-3 security fixes, and placeholders remain.**
- *Where:* `action.yml:17` pins `dnr-sha: 292e43b…`, which is before `88b81bf` and `2cc138e` closed N1–N8. `dnr.yml:100` uses `OWNER/dnr-crew@v1`, `action.yml:14` uses `OWNER/dnr`, and the README links to `github.com/OWNER/dnr`.
- *Fix:*
  - Bump the pin to the release commit, and add a CI check that the pinned SHA is an ancestor of `dnr` main and not older than the last security commit.
  - Replace `OWNER` when the user creates the repos.
  - Have CI fail on `OWNER/` in a tagged `v1`.

**C3 (Medium). The PR author can't override their own PR, which differs from §12.5.**
- *Where:* `src/rules.ts:108`, default `allow-author-override: false`.
- *Effect:* the plan says "a human who started the Crew session does count, so solo maintainers can override". If S16 shows Crew authors PRs as the user, a solo maintainer can never override.
- *Fix:* decide with S16, then make the default match the plan or record a dated amendment.

**C4 (Medium). The workflow leaves `GITHUB_TOKEN` in `.git/config`.**
- *Where:* `persist-credentials: true` (`dnr.yml:96`).
- *Effect:* the token stays there through the `pnpm install` of the DNR monorepo, whose third-party lifecycle scripts can read it, and through the processing of untrusted head content. It is only `contents: read`.
- *Fix:* set `persist-credentials: false`, and pass the token to the head fetch explicitly with `http.extraheader` for that one command.

**C5 (Low). The install action builds DNR from source, with third-party install scripts, on every PR.**
- *Fix:* once npm provenance exists (Phase 13), make `source: npm` with an exact version the default, and verify the provenance attestation.

## 4. Critical path, as of November 27

The software side has moved a long way. **Nothing on the critical path that needs Kiro, an account or a person has happened yet.**
- `kiro-cli` is not installed.
- No repo has a remote.
- `fixtures/pins.json`, `s8.json`, `reverts.json`, `assignment.json` and `reason-labels.json` don't exist.
- The credits request is unrecorded: `docs/spikes.md` still shows `{{credits_requested_at}}`.

| # | Blocker | Owner | Needed by (PT) |
|---|---|---|---|
| 1 | **Request Kiro credits** with ID verification, and record the time | **user** | **request today (Nov 27); hard cutoff Mon Dec 1, 12:00** |
| 2 | Install `kiro-cli` and log in; generate a headless API key; pin the model in `fixtures/pins.json` | **user**, then the team | Nov 28 |
| 3 | Spikes S1, S2, S5, S8, S10, S11, S15 and S17. They decide D1, freeze field names, and give S8 globs (T4) and credits per run | kiro-cli + team | Nov 28–29 |
| 4 | Gate check 1b: a live headless block on the demo checkout | kiro-cli + team | Nov 30 |
| 5 | Close T1 (run isolation) and T4 (S8 refusal) **before** `prereg-v1`. Otherwise the trial's primary arm can read its own order | team | Nov 30 |
| 6 | Public `dnr` repo (and `dnr-crew`), CI green, and the Playground deployed to a public URL (Cloudflare token, or GitHub Pages) | **user** approves and creates; team deploys | Dec 1 |
| 7 | Phase 3 labels: name the outside labeler, or declare the §9.5 fallback. Confirm known-reverts (P0-27). Reason labels and critical edits then give `reverts.json`, assignment and K | **user** (labelers) | Dec 1 |
| 8 | Phases 4–10 on real data: orders approved by the user, drafts (needs kiro-cli), tuning, gates 2 and 3, demo runs, then `prereg-v1` tagged and posted | team + user + kiro-cli | Dec 2 |
| 9 | Phase 11: waves (credits), blind labelling (user and labeler), `score --unseal`, `decision.md` | kiro-cli + **user** | Dec 3 |
| 10 | Video with a real block by 0:19 (from `demo/L` or `demo/LU`), uploaded publicly | team films; **user** uploads | Dec 3 |
| 11 | Devpost form, Frankenstein category, bonus links | **user** | **Dec 4, 10:00 (hard close 14:00)** |
| — | Crew bonus: GitHub App, `dnr-grants` environment and secrets, branch protection, a real Crew session for A1, the load test | **user** (App and secrets) + team | only after 1–11 are on track |

**The honest risk.** If credits or `kiro-cli` slip past about Nov 29, there won't be enough wall-clock time for the full trial's roughly 420 runs plus blind labelling before Dec 3. The only pre-registered outcome then reachable is D6 (inconclusive) or the reduced arm set in the matrix's Risk 1. Decide that amendment now, before `prereg-v1`, not after the data comes in.
