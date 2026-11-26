# DNR acceptance matrix

The checklist the team builds against. Every row is one acceptance check from the plan (`kiroween/dnr-plan/`, normative): every phase exit in 08-phases.md, plus the hard checks in 03 (schemas, hook files, exit codes, config), 04 (CLI), 05 (R-rules, properties, Kiro artifacts, Crew), 06 (trial integrity), 07 (routes, auth, states) and 09 (video, write-up, submission). Owned by the devil's advocate. Written November 26, 2026; first review pass at the end.

**Today is Thursday, November 26, 2026 (US Thanksgiving).** Kiro credit requests close **Monday, December 1, 12:00 PT** (Dec 2 01:30 IST); Devpost estimates 48 business hours to process. Submission closes **Friday, December 4, 14:00 PT** (Dec 5 03:30 IST). The plan says "no deadline"; the calendar disagrees. See [Critical path](#critical-path-to-a-winning-submission) and [Plan risks](#plan-risks).

## How to read this

**Class** (pick the most blocking one that applies):

| Class | Meaning |
|---|---|
| `local` | Can be built and verified on this machine now, with no Kiro, no account and no person outside the team |
| `needs-kiro` | Needs `kiro-cli` installed and logged in (not installed here today), or the Kiro IDE / Web |
| `needs-user` | Needs something only the user can do: an account, secret, purchase, public repo, publishing step, or a named person (outside labeler, adjudicator, SYN author, study participants, pilot maintainers) |
| `needs-trial-data` | Needs outputs of the trial waves (Phase 11), which themselves need Kiro, credits and labels |

**Owner areas:** `engine` (schemas, grammar, core, testkit), `kiro` (.kiro/, powers/, .github/, docs/, scripts/demo, README), `mining` (git, trial mine, fixtures/known-reverts, eligibility), `hook` (next wave: hook, store, CLI, MCP), `ui` (ui, board, Playground), `trial` (harness, scoring, report), `user`.

**Test-ID convention (so "Proof" commands work):** every vitest title starts with its row's spec ID and a colon (`it('P1: exact re-application scores 1.0', …)`, `it('R6: …')`, `it('SCH-Order: …')`), so `pnpm test -t 'P1:'` runs exactly that check. Playwright tests carry the row ID as a tag (`test('ROUTE-03 …', { tag: '@ROUTE-03' }, …)`), so `pnpm -F @dnr/playground exec playwright test --grep @ROUTE-03` runs it. Note `-t 'P1:'` does not match `P10:`.

Placeholders: `$ROOT` = this repo, `$DJ` = `$DJANGO_SRC`, `$TR` = `$TRIAL_ROOT`, `DEMO` = `$ROOT/../django-demo`, `<you>` = the entrant's GitHub account, `{{pkg}}` = `jq -r .npm_package fixtures/pins.json`.

## Contents

1. [Phase 0: Setup](#phase-0-setup)
2. [Phase 1: Spikes](#phase-1-spikes-s1s16)
3. [Phase 2: Core foundations](#phase-2-core-foundations)
4. [Phase 3: Mining and labeling inputs](#phase-3-mining-environments-labeling-inputs)
5. [Phase 4: Scoring and orders](#phase-4-scoring-and-orders)
6. [Phase 5: Hook path](#phase-5-hook-path)
7. [Phase 6: Shell, Stop, post-write, init](#phase-6-shell-stop-post-write-init)
8. [Phase 7: Playground](#phase-7-playground-play)
9. [Phase 8: Drafter](#phase-8-drafter)
10. [Phase 9: Trial harness](#phase-9-trial-harness)
11. [Phase 10: Tuning, gate, pre-registration](#phase-10-tuning-gate-pre-registration)
12. [Phase 11: Trial](#phase-11-trial)
13. [Phase 12: Board, MCP, power, TypeScript, Crew](#phase-12-local-board-mcp-power-typescript-crew)
14. [Phase 13: /trial and hardening](#phase-13-trial-and-hardening)
15. [Phase 14: Ship](#phase-14-ship)
16. [Properties P1–P17](#properties-p1p17-05-121)
17. [Requirements R1–R15](#requirements-r1r15-05-121)
18. [Schemas](#schemas-03-7)
19. [Hook files, exit codes, config](#hook-files-exit-codes-config-03-6-04-8)
20. [CLI commands](#cli-commands-04-8)
21. [Routes, states, auth](#routes-states-auth-07-10)
22. [Kiro artifacts](#kiro-artifacts-05-122125)
23. [Trial integrity](#trial-integrity-06-9)
24. [Video and write-up](#video-and-write-up-09-11)
25. [Submission checklist](#submission-checklist-09-11)
26. [Row counts](#row-counts)
27. [Critical path to a winning submission](#critical-path-to-a-winning-submission)
28. [Plan risks](#plan-risks)
29. [First review pass: early drift](#first-review-pass-early-drift-november-26)

---

## Phase 0: Setup

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| P0-01 | 0 | Kiro credits requested on Devpost (with ID verification); request time recorded | `grep -i 'credits requested' docs/spikes.md` shows a timestamp before 2026-11-28 | user | needs-user |
| P0-02 | 0 | Credits on hand cover the full pre-registered run count + 40%, or the user's paid-plan decision is recorded | `docs/spikes.md` "Budget" block: credits, S11 cost/run, run count, margin ≥ 1.4 | user | needs-user |
| P0-03 | 0 | `kiro-cli` installed (≥ 3.4, prefer ≥ 3.6) and logged in on this machine | `kiro-cli --version` ; `kiro-cli chat --v3 --no-interactive "say hi"` exits 0 | user | needs-user |
| P0-04 | 0 | Model chosen from the CLI list and pinned | `kiro-cli chat --list-models --format json` ; `jq -e '.model != ""' fixtures/pins.json` | kiro | needs-kiro |
| P0-05 | 0 | Headless login works with an API key and an empty HOME | `HOME=$(mktemp -d) KIRO_API_KEY=… kiro-cli chat --v3 --no-interactive "say hi"` exits 0 | user | needs-user |
| P0-06 | 0 | Public GitHub repo `dnr`, MIT detected; first commit holds product.md, LICENSE, NOTICE | `gh repo view dnr --json licenseInfo -q .licenseInfo.key` = `mit` ; `git show --stat $(git rev-list --max-parents=0 HEAD)` | user | needs-user |
| P0-07 | 0 | Cloudflare token (Pages: Edit), project `dnr-playground`, both secrets in repo | `npx wrangler pages project list` lists it ; `gh secret list` shows `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | user | needs-user |
| P0-08 | 0 | GitHub Pages mirror enabled (workflow build) | `gh api repos/<you>/dnr/pages -q .build_type` = `workflow` | user | needs-user |
| P0-09 | 0 | `SECOND_SRC` CPython clone builds and a test passes | in `$SECOND_SRC`: `./configure && make -j && ./python.exe -m test test_os` | mining | local |
| P0-10 | 0 | Node 24 active (not 25/26) | `node -v` starts `v24.` (today: `v25.2.1`, fails) | kiro | local |
| P0-11 | 0 | pnpm, uv, Python present | `pnpm -v` ; `uv --version` ; `uv python list` | kiro | local |
| P0-12 | 0 | hyperfine and ast-grep installed (both missing today) | `hyperfine --version` ; `ast-grep --version` | kiro | local |
| P0-13 | 0 | git, gh, jq, openssl, rsync, ffprobe present | `git --version && gh --version && jq --version && openssl version && rsync --version && ffprobe -version` | kiro | local |
| P0-14 | 0 | Lighthouse CI, ruff, biome present | `npx @lhci/cli --version` ; `ruff --version` ; `npx @biomejs/biome --version` | kiro | local |
| P0-15 | 0 | Docker running; python 3.5/3.6/3.7-slim pulled and digests pinned (daemon not running today) | `docker info` ; `jq -e '.docker_images \| length == 3' fixtures/pins.json` | mining | local |
| P0-16 | 0 | Tool versions recorded | `jq -e '.tools \| has("node") and has("pnpm") and has("uv") and has("ast-grep")' fixtures/pins.json` | kiro | local |
| P0-17 | 0 | Workspace installs, lints, typechecks, tests | `pnpm i --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test` | engine | local |
| P0-18 | 0 | CI workflow (Node 24: lint, typecheck, test, build) green on `main` | `gh run list -w ci.yml -b main -L 1 --json conclusion -q '.[0].conclusion'` = `success` | kiro | needs-user |
| P0-19 | 0 | Playground e2e job enabled once `apps/playground` exists | `grep -n 'playwright' .github/workflows/ci.yml` | kiro | local |
| P0-20 | 0 | Grammars vendored and load | `node scripts/check-grammar.mjs` exits 0 ; `shasum -a 256 vendor/grammars/*.wasm` matches PROVENANCE.md | engine | local |
| P0-21 | 0 | `DJANGO_SRC` is a full, non-shallow clone | `git -C "$DJ" rev-parse --is-shallow-repository` = `false` ; `jq -r .django_sha fixtures/pins.json` = `git -C "$DJ" rev-parse origin/main` on Phase 0 day | mining | local |
| P0-22 | 0 | TypeScript demo case chosen (vite → vscode → vue order), recorded with license | `jq -e '.ts_demo.R and .ts_demo.qualname and .ts_demo.license' fixtures/pins.json` ; `grep -n "$(jq -r .ts_demo.repo fixtures/pins.json)" NOTICE` | mining | local |
| P0-23 | 0 | `make-demo-checkout.sh` clones DEMO at `43933a1dca` (from `$DJ` with `--no-local`, or GitHub when unset) and builds the uv env | `bash scripts/demo/make-demo-checkout.sh && git -C ../django-demo rev-parse --short=10 HEAD` = `43933a1dca` ; also run with `DJANGO_SRC` unset | kiro | local |
| P0-24 | 0 | Script skips demo-order copy with a notice until Phase 8; prints the kiro-cli login step | script stdout contains the skip notice and `kiro-cli` login line | kiro | local |
| P0-25 | 0 | Demo env runs the target tests | in DEMO: `PYTHONPATH="$PWD" <env>/bin/python tests/runtests.py aggregation_regress` passes | kiro | local |
| P0-26 | 0 | `known-reverts.json` generated from both paginated `gh api search/commits` queries (2020–2025), non-merge, on main | the two `gh api -X GET search/commits --paginate …` commands in 08 §13.1 ; `pnpm test:fixtures` | mining | local |
| P0-27 | 0 | Every kept known revert confirmed by a named person; rejects in `known-reverts-rejected.json` with reason | `jq -e 'all(.[]; .confirmed_by != "")' fixtures/known-reverts.json` ; `jq -e 'all(.[]; .reason != "")' fixtures/known-reverts-rejected.json` | user | needs-user |
| P0-28 | 0 | Both demo reverts resolved (C, file, qualname, c_file_count) from git, not from the plan text | `jq '.demo_cases' fixtures/pins.json` ; for 43933a1dca the qualname must be `Query.clear_ordering` (see drift D-10) | mining | local |
| P0-29 | 0 | npm account; package name decided (`dnr-guard` was free on Nov 26) | `npm view dnr-guard` 404 or scoped name ; `jq -r .npm_package fixtures/pins.json` | user | needs-user |
| P0-30 | 0 | Kiro Crew access confirmed with one session on a scratch repo | note + session link in `docs/spikes.md` | user | needs-user |
| P0-31 | 0 | `dnr-crew` repo under the Devpost account; `django-demo-crew` public with `43933a1dca` on main | `gh repo view <you>/dnr-crew` ; `gh api repos/<you>/django-demo-crew/commits/main -q .sha` starts `43933a1dca` | user | needs-user |
| P0-32 | 0 | GitHub App `dnr-bot`: §12.5 permissions, webhook inactive, installed on the two repos only | App settings screenshot in `docs/spikes.md` | user | needs-user |
| P0-33 | 0 | Environment `dnr-grants` limited to protected branches | `gh api repos/<you>/django-demo-crew/environments/dnr-grants --jq .deployment_branch_policy` = `{"protected_branches":true,"custom_branch_policies":false}` | user | needs-user |
| P0-34 | 0 | Three env secrets set, none as repo secrets; local `.pem` deleted | `gh secret list --env dnr-grants -R <you>/django-demo-crew` (3 names) ; `gh secret list -R <you>/django-demo-crew` (none of them) | user | needs-user |
| P0-35 | 0 | App install verified by the smoke workflow, then the workflow deleted | `gh workflow run dnr-smoke.yml -R <you>/django-demo-crew && gh run watch` green ; workflow file absent afterwards | user | needs-user |
| P0-36 | 0 | Branch protection requires check `dnr` pinned to the App ID | `gh api repos/<you>/django-demo-crew/branches/main/protection/required_status_checks -q '.checks[0]'` = `{context:"dnr",app_id:<id>}` | user | needs-user |
| P0-37 | 0 | Bonus eligibility recorded (Crew, Blog, Social Blitz, Startup, Student, Ghost) | `docs/spikes.md` "Bonuses" table | user | needs-user |
| P0-38 | 0 | SYN author named (not the builder) | `docs/spikes.md` "People" | user | needs-user |
| P0-39 | 0 | Outside labeler and adjudicator booked by name for the §9.5 hours | `docs/spikes.md` "People" with dates and hours | user | needs-user |
| P0-40 | 0 | Private `dnr-labeling` with labeler 2 and adjudicator | `gh api repos/<you>/dnr-labeling/collaborators -q '.[].login'` | user | needs-user |
| P0-41 | 0 | Private `django-syn` at the SYN base SHA; author is a collaborator; remote `syn` in `$DJ` | `git -C "$DJ" ls-remote syn` | user | needs-user |
| P0-42 | 0 | ≥ 3 outside maintainers recruited (≥ 1 Python, ≥ 1 TS) | `docs/spikes.md` "Pilot" | user | needs-user |
| P0-43 | 0 | Touch the Plan study started; `kiroween/touch-the-plan-plan.md` written; study prereg pushed as tag | `git ls-remote --tags origin study-prereg` ; tag time in `docs/spikes.md` | user | needs-user |
| P0-44 | 0 | Phase 0 exit: `.kiro` tracked | `git ls-files .kiro \| wc -l` > 0 (passes today) | kiro | local |

## Phase 1: Spikes S1–S16

All answers in `docs/spikes.md`, captures in `fixtures/hook-events/`, and `steering/hook-contracts.md` frozen at the end.

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| S1 | 1 | Always-block PreToolUse `write` hook fires headless under `--trust-all-tools`, under both registrations (hook file and agent config) | always-exit-2 hook + `kiro-cli chat --v3 --no-interactive --trust-all-tools "create a.txt"`; `test ! -e a.txt`; repeat via `--agent`. Failure = provisional D1 | kiro | needs-kiro |
| S2 | 1 | Exact `tool_input` fields for `fs_write`, `fs_append`, `str_replace`, `delete_file` | one capture per tool in `fixtures/hook-events/s2-<tool>.json` | kiro | needs-kiro |
| S3 | 1 | `session_id` stable across turns | two-turn session; `jq .session_id` equal across captures | kiro | needs-kiro |
| S4 | 1 | SessionStart, SessionEnd, Stop fire headless; Stop forces a turn on exit 1 and on the JSON form | captures + transcript showing the extra turn | kiro | needs-kiro |
| S5 | 1 | Behaviour of `deny`, `ask`, `allow`; is `ask` auto-approved under `--trust-all-tools`; what under `--no-interactive` | three runs per decision, results table | kiro | needs-kiro |
| S7 | 1 | Hook timeout behaviour | hook sleeping past `timeout`; record allow/deny | kiro | needs-kiro |
| S8 | 1 | Credential file for headless; hooks inherit PATH/env; files Kiro writes under `$HOME/.kiro` (hash-exclusion globs); env diff hook vs Terminal vs IDE terminal | `env` dump from a hook; `find $HOME/.kiro -newer marker`; globs in `hook-contracts.md` | kiro | needs-kiro |
| S9 | 1 | Which power format loads; can a power bundle hooks and steering | load `powers/dnr` both formats | kiro | needs-kiro |
| S10 | 1 | Agent-config hook key shape; duplicate dedupe; `--agent <name>` resolves from `$HOME/.kiro/agents/` | config in a seeded HOME; capture | kiro | needs-kiro |
| S11 | 1 | Unhooked T task on DEMO, then tests; **credits per run recorded** | `kiro-cli chat … "Clean up <qualname> in <file>."` then `runtests.py aggregation_regress`; credit delta in `docs/spikes.md` | kiro | needs-kiro |
| S12 | 1 | Shell tool's command field name | capture of `execute_bash` stdin | kiro | needs-kiro |
| S13 | 1 | What the agent sees when hook output > 3,000 chars | 4,000-char stderr hook; transcript | kiro | needs-kiro |
| S14 | 1 | Hooks run on Web and in the IDE; file-trigger matcher is a regex | IDE + Web session notes | kiro | needs-kiro |
| S15 | 1 | PostToolUse stdin per write tool, including after an approved `ask` in an interactive session; `session_id` and path present | captures `s15-*.json` | kiro | needs-kiro |
| S16 | 1 | Crew: how a session's changes are exposed, what a bot can read/post, what the Crew bonus needs | captures in `fixtures/crew/` | user | needs-user |
| P1-EXIT | 1 | Every spike answered; `hook-contracts.md` frozen; D1 recorded provisional if S1 failed | `grep -c '^## S' docs/spikes.md` ≥ 15 ; `git log -1 -- .kiro/steering/hook-contracts.md` | kiro | needs-kiro |

## Phase 2: Core foundations

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| P2-01 | 2 | `packages/cli` scaffold built with tsup and linked globally; `dnr --version` runs | `pnpm -F @dnr/cli build && pnpm -F @dnr/cli link --global && dnr --version` | engine | local |
| P2-02 | 2 | Schema package tests pass | `pnpm -F @dnr/schemas test` (needs a `test` script; drift D-01) | engine | local |
| P2-03 | 2 | Qualname unit cases: methods, nested classes, decorators, `#2`, `<body>`, `<module>`, closures | `pnpm test -t 'qualname:'` with one case each | engine | local |
| P2-04 | 2 | `pnpm test:fixtures` validates `known-reverts.json` against `KnownRevert` (not the placeholder) | `pnpm test:fixtures` fails when one field in a copy is corrupted | engine | local |
| P2-05 | 2 | `@dnr/grammar` loads in node and in a browser bundle | `pnpm -F @dnr/grammar test` ; browser load covered by P9 | engine | local |
| P2-06 | 2 | Tokenizer: leaves only, comments dropped, string literal = 1 token, zero-width dropped, `NORMALIZER_VERSION=1`, weight-0 set exactly `. , : ; ( ) [ ] { } = -> := @ \` | `pnpm test -t 'tokenize:'` | engine | local |
| P2-07 | 2 | Meaningful operators keep weight 1 (`**`, `??`, `?.`, `...`, `\|\|`, `*`) | `pnpm test -t 'tokenize: weight'` | engine | local |
| P2-08 | 2 | Parse-degraded: > 20% of a unit's span under `ERROR` marks it `parse-degraded` | `pnpm test -t 'degraded:'` | engine | local |
| P2-09 | 2 | `qualnames(text, lineRanges)` maps each changed line to the smallest unit | `pnpm test -t 'qualname: lineRanges'` | engine | local |
| P2-10 | 2 | `diffArrays` wrapper over jsdiff 9.0.0 yields A and R | `pnpm test -t 'diff:'` | engine | local |
| P2-11 | 2 | Unit extraction and `w()` (§5.3): kind modified/added/removed, `post_revert_hash`, token count, `c_state_ref`; formatting-only units skipped; `skip_reason: no-unit-change` | `pnpm test -t 'extract:'` on 43933a1dca and a formatting-only commit | engine | local |
| P2-12 | 2 | Order ID = `dnr-` + first 10 hex of `revert_sha` (manual: `original_sha`) | `pnpm test -t 'order id:'` | engine | local |
| P2-13 | 2 | `testkit` arbitraries exist for orders, writes, sessions | `pnpm -F @dnr/testkit test` | engine | local |

## Phase 3: Mining, environments, labeling inputs

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| P3-01 | 3 | Every `known-reverts.json` SHA recovered; both demo SHAs present | `dnr trial mine` then `jq -r '.[].sha' fixtures/known-reverts.json \| xargs -I{} grep -q {} fixtures/candidates.jsonl` ; grep `43933a1dca`, `d0e4dd5cdd` | mining | local |
| P3-02 | 3 | Rerun gives byte-identical output | `dnr trial mine && sha256sum fixtures/candidates.jsonl > /tmp/a && dnr trial mine && sha256sum -c /tmp/a` | mining | local |
| P3-03 | 3 | Candidate regex: subject `/(^\|-- )(Partially )?Revert(ed\|s\|ing)?\b/i`, body `This reverts commit <sha>`, `Reverts? (commit )?<sha>`; tags backport / revert_of_revert / partial | `pnpm test -t 'mine: regex'` incl. `Fixed #N -- Reverted "…"` | mining | local |
| P3-04 | 3 | Silent reverts via forward/inverse `git patch-id --stable` (W4) | `pnpm test -t 'mine: patch-id'` on a fixture repo | mining | local |
| P3-05 | 3 | C resolved from body SHA, else exact quoted subject; `merge-base --is-ancestor C R`; latest pair if reverted twice | `pnpm test -t 'mine: original'` | mining | local |
| P3-06 | 3 | `revert_kind` exact (patch-id) / full (`git revert --no-commit C` on `R^` reproduces R) / partial / unclear | `pnpm test -t 'mine: kind'` | mining | local |
| P3-07 | 3 | E1–E8 applied in order; first failing rule is `skip_reason` | `pnpm test -t 'mine: E-rules'` ; `jq 'group_by(.skip_reason)' fixtures/reverts.json` | mining | local |
| P3-08 | 3 | `dnr trial tickets`: Trac CSV+RSS, generic UA, ≥ 2 s spacing, backoff; PR context via gh; `Discussion` valid | `dnr trial tickets && pnpm test:fixtures` | mining | local |
| P3-09 | 3 | Reason codebook committed | `test -s reports/labeling/reason-codebook.md` | mining | local |
| P3-10 | 3 | Labeler setup from the pinned SHA; `dnr --version` = `<sha>` on labeler 2's machine; reason round-trip Zod-valid | labeler runs §9.5 install; one reason packet labeled, pushed, read back, `pnpm test:fixtures` | user | needs-user |
| P3-11 | 3 | Both labelers do blind reason labeling (rule-engine proposal hidden) | `jq 'group_by(.labeler) \| map(length)' fixtures/reason-labels.json` equal and = candidates | user | needs-user |
| P3-12 | 3 | `trial mine --labels` writes `reverts.json` with `role: null` and `rdelta_sha` for every eligible revert | `jq -e 'all(.[] \| select(.eligible); .rdelta_sha != null and .role == null)' fixtures/reverts.json` | mining | needs-user |
| P3-13 | 3 | `trial assign`: sha256 ranking; ranks 1–2 tune, 3–7 gate; roles skip orders below `min_order_weight`; K + 4 selected | `dnr trial assign && pnpm test -t 'assign:'` ; `jq 'group_by(.role)\|map({(.[0].role):length})' fixtures/assignment.json` | mining | needs-user |
| P3-14 | 3 | `trial envs`: per-revert uv env with `--exclude-newer`; Docker for 3.5–3.7 with committed constraints; restored tests fail on R, pass on C (and at R+Δ) | `dnr trial envs && jq -e 'all(.[]; .ok)' fixtures/env-matrix.json` | mining | local |
| P3-15 | 3 | Baselines run twice; flaky tests recorded | `test -f fixtures/flaky.json && pnpm test:fixtures` | mining | local |
| P3-16 | 3 | Critical-edit annotation by both labelers; `critical-edits.json` complete | `dnr trial label --critical-edits …` ; every trial/gate revert has 2 labelers' entries | user | needs-user |
| P3-17 | 3 | K recorded in `reports/eligibility.md`, listing every candidate | `grep -n '^K = ' reports/eligibility.md` | mining | needs-user |
| P3-18 | 3 | Reason κ reported | `grep -n 'κ' reports/eligibility.md` (or `reports/kappa.md`) | mining | needs-user |
| P3-19 | 3 | Human re-proposal count (Trac duplicates, "this was reverted in" PRs, Reapply/Reland commits) | `test -s reports/human-reproposals.md` | mining | local |
| P3-20 | 3 | repo2: `trial mine --repo cpython` excluding `Lib/test/**`; < 15 eligible → sympy; choice recorded | `grep -n 'second repo' reports/eligibility.md` | mining | local |

## Phase 4: Scoring and orders

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| P4-01 | 4 | P1, P2, P4, P5, P7, P8 pass at 500 runs locally | `FC_NUM_RUNS=500 pnpm test -t 'P[124578]:'` | engine | local |
| P4-02 | 4 | Same properties at 2,000 runs nightly in CI | `.github/workflows/ci.yml` nightly schedule with `FC_NUM_RUNS=2000`; last nightly green | kiro | needs-user |
| P4-03 | 4 | Order building is deterministic | build twice into two dirs; `diff -r` empty | engine | local |
| P4-04 | 4 | The Phase 4 command succeeds | `dnr orders build --from fixtures/reverts.json --only 43933a1dca --out-dir reports/orders && dnr orders show dnr-43933a1dca --orders reports/orders --tokens` (needs a `reverts.json` that contains the demo revert even though E8 marks it ineligible) | engine | local |
| P4-05 | 4 | `orders build` for Django and repo2, then `orders approve --all --by builder`, logged in history; trial orders `reason_source: placeholder` | `jq -e '.history[-1].action=="approved" and .history[-1].by=="builder"' reports/orders/*.json` | engine | needs-user |
| P4-06 | 4 | Both demo orders meet `min_order_weight` (8) | `dnr orders show dnr-43933a1dca --tokens` and `dnr-d0e4dd5cdd` print `w(A)+w(R) ≥ 8` | engine | local |
| P4-07 | 4 | Re-running `build` on an existing ID keeps status, reason, reason_source, history; rewrites units/snapshot only | `pnpm test -t 'orders build: rebuild'` | engine | local |
| P4-08 | 4 | `stale` (§5.9) computed on load, never written back; > 50% snapshot tokens differ or unrelocatable missing unit | `pnpm test -t 'stale:'` | engine | local |
| P4-09 | 4 | `mutate.ts`: six AST operators, each output parses; 5 mutants/family/revert; seeds 1000–1004, 2000–2004, 3000–3004, 3100–3109 | `pnpm -F @dnr/testkit test -t 'mutate:'` ; `ls fixtures/mutations/<sha10>/*/` | engine | local |
| P4-10 | 4 | Approved `dnr-43933a1dca` pushed to `<you>/django-demo-crew` under `.dnr/orders/` | `gh api repos/<you>/django-demo-crew/contents/.dnr/orders/dnr-43933a1dca.json` | user | needs-user |

## Phase 5: Hook path

Run with `DNR_ORDERS=$ROOT/reports/orders`, `cwd=DEMO`.

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| P5-01 | 5 | Golden fixtures from S2 captures: `reapply-43933a1dca.json`, `hardneg-typehints.json`, `uncovered.json`, one per tool | `pnpm test -t 'golden:'` | hook | needs-kiro |
| P5-02 | 5 | Warn-once: first non-matching write to a covered order `warn_block`, second `warn_pass` | `pnpm test -t 'R2:' -t 'R3:'` | hook | local |
| P5-03 | 5 | P3 accumulation across writes | `pnpm test -t 'P3:'` | hook | local |
| P5-04 | 5 | P10 grant scope (own order; unexpired or used) | `pnpm test -t 'P10:'` | hook | local |
| P5-05 | 5 | Record mode: `DNR_MODE=record` and config `mode`; `proposed_text` and `session_patch` on every event | `DNR_MODE=record dnr check --stdin --hook kiro < fixtures/hook-events/reapply-43933a1dca.json; jq -e '.proposed_text and .session_patch' $DNR_STATE_DIR/events.jsonl` | hook | local |
| P5-06 | 5 | Fail-open: every internal error or timeout exits 0 and logs to `hook.log` (`error_open`) | `pnpm test -t 'R7:'` with injected faults | hook | local |
| P5-07 | 5 | p95 < 300 ms (match) and < 80 ms (fast path); results in `reports/perf.md` | `hyperfine -i --export-json perf.json -r 30 "dnr check --stdin --hook kiro < $ROOT/fixtures/hook-events/reapply-43933a1dca.json" "dnr check --stdin --hook kiro < $ROOT/fixtures/hook-events/uncovered.json" && node scripts/p95.mjs perf.json` | hook | local |
| P5-08 | 5 | First write of a fresh Django session (temp-index baseline) < 2 s | timed first event with empty `$DNR_STATE_DIR` in DEMO | hook | local |
| P5-09 | 5 | Temp-index baseline never touches the real index; works on unborn HEAD; includes untracked, respects .gitignore | `pnpm test -t 'R4:'` ; `git -C DEMO status --porcelain` unchanged | hook | local |
| P5-10 | 5 | `dnr check --commit` (crossing vs `X^`) and `dnr trial falsealarm` | `dnr check --commit <sha>` on a fixture repo ; `pnpm test -t 'falsealarm:'` | hook | local |
| P5-11 | 5 | `dnr allow <id> [--ttl]`, `check --file --proposed`, `check --replay [--canonical]`, `session start\|confirm\|show\|end\|gc` | `pnpm test -t 'cli:'` one case per subcommand | hook | local |
| P5-12 | 5 | Minimal `dnr init --hooks pre-write` writes only `dnr-pre-write.json` + config | `dnr init --hooks pre-write DEMO && ls DEMO/.kiro/hooks` | hook | local |
| P5-13 | 5 | `fixtures/hook-events/two-file-order.json` (hand-written order spanning two files, one event per half) | `pnpm test:fixtures` | hook | local |
| P5-14 | 5 | Five scripted hard negatives `hardneg-<sha10>.json`, one per gate revert, template `sha256("dnr-2026:hn:"+sha) mod 3` | `ls fixtures/hook-events/hardneg-*.json \| wc -l` ≥ 7 ; template check test | hook | needs-user |
| P5-15 | 5 | Demo hard negatives `hardneg-43933a1dca.json`, `hardneg-d0e4dd5cdd.json` | files exist and replay to `allow` or `warn_*` | hook | local |
| P5-16 | 5 | Block stderr ≤ 1,200 chars, first line `DNR: <reason> <revert URL>`, names `dnr board --open <id>` and `dnr allow <id>` | `pnpm test -t 'R1:'` ; `wc -c` on captured stderr | hook | local |
| P5-17 | 5 | Protect tier denies `.dnr/**`, `.kiro/{hooks,settings,agents}/**`, `$HOME/.kiro/**`, realpath of `DNR_ORDERS`, `DNR_STATE_DIR`, `DNR_CONFIG` | `pnpm test -t 'R6:'` | hook | local |
| P5-18 | 5 | Tool adapters: fs_write (incl. legacy `command`), str_replace (0 or ≥ 2 matches allowed through), fs_append, delete_file = empty, unknown write tool → warn | `pnpm test -t 'adapter:'` | hook | local |
| P5-19 | 5 | Fast path + blob-SHA cache for uncovered files | `jq -e '.decision.fast_path' ` on the uncovered event | hook | local |
| P5-20 | 5 | Credit budget recomputed with S11 cost and K | `docs/spikes.md` "Budget (Phase 5)" | user | needs-user |

## Phase 6: Shell, Stop, post-write, init

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| P6-01 | 6 | guard-shell table of ≥ 40 commands passes (R1–R7, wrappers, splits on `; && \|\| \| $( )` and backticks) | `pnpm test -t 'guard-shell:'` ; table in `packages/hook/test/shell-table.ts` | hook | local |
| P6-02 | 6 | guard-shell PreToolUse tree snapshot + `dnr session shell-after` adds changed files to `touched` | `pnpm test -t 'post-shell:'` | hook | local |
| P6-03 | 6 | Stop forces ≤ 2 turns, exits 0 on crash, skips orders whose grant applies; scores only `touched` | `pnpm test -t 'stop:'` | hook | local |
| P6-04 | 6 | Stop order-set hash check: any non-R6 change to orders/config/hook files forces a reporting turn | `pnpm test -t 'stop: orders hash'` | hook | local |
| P6-05 | 6 | P12, P13, P15 and P10's pre-commit blob clause pass | `pnpm test -t 'P12:' -t 'P13:' -t 'P15:' -t 'P10: pre-commit'` | hook | local |
| P6-06 | 6 | Mode acceptance (`commit-enforce`): pre-write records + warns; Stop capped at 1; `dnr check --staged` exits 1 on a crossing | `pnpm test -t 'mode: commit-enforce'` | hook | local |
| P6-07 | 6 | `warn-only`: match downgraded to warn tier; Stop 1 turn with "Tell the user; do not revert unless asked"; pre-commit exits 0 | `pnpm test -t 'mode: warn-only'` | hook | local |
| P6-08 | 6 | Each `DNR_MODE` value writes a Zod-valid `EventRecord` | `for m in enforce record warn-only commit-enforce; do DNR_MODE=$m …; done` + schema check | hook | local |
| P6-09 | 6 | Full `dnr init` installs every hook, config, gitignore lines, pre-commit shim only if none exists, steering | `dnr init DEMO && ls DEMO/.kiro/hooks DEMO/.git/hooks/pre-commit` | hook | local |
| P6-10 | 6 | `init` is idempotent | `dnr init DEMO && (cd DEMO && git status --porcelain) > a; dnr init DEMO; …; diff a b` | hook | local |
| P6-11 | 6 | `dnr doctor` green in DEMO (node, git, grammar ABI, hook JSON, PATH as hooks see it, kiro-cli version, board port) | `cd DEMO && dnr doctor` exits 0 | hook | needs-kiro |
| P6-12 | 6 | `dnr orders verify` | `dnr orders verify --orders reports/orders` exits 0; exits 65 on a corrupted copy | hook | local |
| P6-13 | 6 | Re-run `make-demo-checkout.sh` with full init | script runs `dnr init --hooks all` | kiro | local |
| P6-14 | 6 | R6 process-ancestry guard and Kiro-variable check refuse approval subcommands from an agent; pass from a node-pty human terminal | `pnpm test -t 'R6 guard:'` | hook | local |
| P6-15 | 6 | Live: headless `git cherry-pick <C>` denied | `cd DEMO && kiro-cli chat --v3 --no-interactive --trust-all-tools "run git cherry-pick <C>"` ; `git log -1` unchanged | hook | needs-kiro |
| P6-16 | 6 | Live: `sed` re-application undone by a forced Stop turn; human's pre-session tracked and untracked edits survive | scripted session; `git diff` shows only the human edits | hook | needs-kiro |
| P6-17 | 6 | Live: `python -c` write that never names its file caught by `dnr-post-shell` + Stop | scripted session; event log shows `touched` + forced turn | hook | needs-kiro |
| P6-18 | 6 | Live: interactive approved `ask` confirmed through PostToolUse (`ask_approved`, grant created) | interactive session with `decision_format: ask` | hook | needs-kiro |

## Phase 7: Playground `/play`

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| P7-01 | 7 | Shared `ui/` with the localStorage adapter | `pnpm -F @dnr/ui test` | ui | local |
| P7-02 | 7 | `dnr export-case` for both demo reverts; `CaseBundle` valid | `dnr export-case 43933a1dca --orders reports/orders --git-dir "$DJ" && pnpm test:fixtures` | ui | local |
| P7-03 | 7 | Preset sources: C; `extract-helper` seed 2000; H template by sha rule; first two files of C (omitted with reason if `c_file_count` < 2); `ruff format`/`biome format` of C | `pnpm test -t 'export-case: presets'` | ui | local |
| P7-04 | 7 | Routes `/`, `/play/:case` (presets and free-edit editor), `/graveyard`, `/orders/:id` render | `playwright test --grep @P7-routes` | ui | local |
| P7-05 | 7 | `/orders/view` renders a committed `django-demo-crew` order; Zod-invalid file shows the error state | `playwright test --grep @ROUTE-orders-view` | ui | needs-user |
| P7-06 | 7 | P9 parity on Chromium, Firefox, WebKit | `pnpm -F @dnr/playground exec playwright test --grep @P9 --project=chromium --project=firefox --project=webkit` | ui | local |
| P7-07 | 7 | axe: 0 violations | `playwright test --grep @axe` | ui | local |
| P7-08 | 7 | Deployed to Cloudflare Pages from `main`; smoke passes on the preview URL | `gh run list -w deploy-playground.yml -L1` success ; `PLAYGROUND_URL=<preview> playwright test --grep @smoke` | ui | needs-user |
| P7-09 | 7 | `_headers`: WASM as `application/wasm`; CSP with `'wasm-unsafe-eval'` and the stated `connect-src` | `grep -n wasm-unsafe-eval apps/playground/public/_headers` ; `curl -sI <url>/…wasm \| grep -i content-type` | ui | local |

## Phase 8: Drafter

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| P8-01 | 8 | `dnr draft --orders reports/orders --trial` drafts every role-bearing order (Django, repo2) and both demos; others keep the revert subject | `jq -r 'select(.reason_source=="drafter") .id' reports/orders/*.json \| wc -l` = role count | trial | needs-kiro |
| P8-02 | 8 | Every draft Zod-valid; ≤ 200 chars, one sentence, no URLs or code; retries twice | `pnpm test:fixtures` over `fixtures/drafts/` | trial | needs-kiro |
| P8-03 | 8 | Injection fixture still yields a plain sentence | `dnr draft --order <injection-fixture>` ; `pnpm test -t 'drafter: injection'` | trial | needs-kiro |
| P8-04 | 8 | Drafted, approved demo orders copied to `fixtures/demo-orders/`; DEMO lists both `approved` with `reason_source: drafter` | `bash scripts/demo/make-demo-checkout.sh && cd DEMO && dnr orders list` | kiro | needs-kiro |
| P8-05 | 8 | Drafted `dnr-43933a1dca` re-pushed to `django-demo-crew` | `gh api …/contents/.dnr/orders/dnr-43933a1dca.json` shows `reason_source: drafter` | user | needs-user |
| P8-06 | 8 | Replacing a reason appends `edited_reason`, keeps `approved` | `pnpm test -t 'draft: history'` | trial | local |
| P8-07 | 8 | Steering template check | `dnr steering generate --orders reports/orders --out /tmp/check.md && test -s /tmp/check.md` | trial | local |

## Phase 9: Trial harness

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| P9-01 | 9 | `dnr trial run --wave 1 --dry-run --only <revert>`: truncated repo, HOME seeded with agent config in `$HOME/.kiro/agents/`, HOME hash with S8 exclusions, `manifest.jsonl` | the command exits 0 ; `jq . $TR/manifest.jsonl` | trial | needs-kiro |
| P9-02 | 9 | Truncated repo: `git log --all` shows nothing newer than R | `git -C $TR/repos/<R> log --all --format=%cI \| sort \| tail -1` ≤ R date | trial | local |
| P9-03 | 9 | Run packet round-trips through `dnr-labeling` (generated, labeled by labeler 2, pushed, read back) | round-trip log in `docs/spikes.md` | user | needs-user |
| P9-04 | 9 | R+Δ dry run | `dnr trial prepare --stratum rdelta && dnr trial run --namespace rdelta --dry-run --only <sha>` | trial | needs-kiro |
| P9-05 | 9 | SYN pipeline in §9.10 order (clone, ancestor check, build, approve, envs, draft, prepare) + dry run | the six commands in 08 Phase 9 ; `dnr trial run --namespace syn --dry-run --only <sha>` | user | needs-user |
| P9-06 | 9 | repo2 envs + dry run | `dnr trial envs --repo <repo> && dnr trial prepare --cohort repo2 && dnr trial run --namespace repo2 --dry-run --only <sha>` | trial | needs-kiro |
| P9-07 | 9 | Demo and practice namespace dry runs | `dnr trial run --namespace demo --dry-run --only 43933a1dca` ; same for `practice` | trial | needs-kiro |
| P9-08 | 9 | Probe dry run | `dnr trial probe --dry-run --only <sha>` | trial | needs-kiro |
| P9-09 | 9 | Two-file `session_patch` dry run: second event's patch contains both files; Q packet shows both | `DNR_MODE=record dnr check --file <a> …; dnr check --file <b> …` on `two-file-order.json`; `jq -r .session_patch \| grep -c '^diff --git'` = 2 | trial | local |
| P9-10 | 9 | Agent configs `trial/agents/trial-{T,U,B,S,H,L,probe}.json`: pinned model, file + shell tools only, no web | `jq -e '.model and (.tools\|index("web")\|not)' trial/agents/*.json` ; probe has `tools: []` | trial | needs-kiro |
| P9-11 | 9 | Packet generation incl. probe packets; 6-char codes; shuffle seed 2026 | `pnpm test -t 'packets:'` | trial | local |
| P9-12 | 9 | 600 s limit kills the process group (no GNU `timeout`) | `pnpm test -t 'run: timeout'` with a sleeping fake CLI | trial | local |
| P9-13 | 9 | Saved per run: stream-json transcript, `meta.json` (config sha256, order-set size), diff with `:!.kiro :!.dnr :!.gitignore`, `events.jsonl` | dry-run output dir listing | trial | needs-kiro |
| P9-14 | 9 | `shell_route` flag (non-empty diff, no write-tool calls) and history-use flags | `pnpm test -t 'run: flags'` on recorded transcripts | trial | local |

## Phase 10: Tuning, gate, pre-registration

Results in `reports/gate.md`.

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| P10-01 | 10 | Edit grid 0.40–0.90 step 0.05 × `side_min` {0.2, 0.3, 0.4} on tune reverts + tune families; max recall with 0 false blocks; tie → higher threshold | `dnr trial falsealarm --role tune --config <grid point>` per point ; table in `gate.md` | trial | needs-user |
| P10-02 | 10 | Proximity built; `prox_threshold` tuned 0.30–0.80 on tune families; enabling rule (§5.6) decided and recorded | `grep -n 'prox_enabled' reports/gate.md` | engine | needs-user |
| P10-03 | 10 | Fingerprint index built; `fingerprint_floor` tuned 0.50–0.90 on move-to-file seeds 3105–3109 | `grep -n 'fingerprint_floor' reports/gate.md` | engine | needs-user |
| P10-04 | 10 | P14, P16, P17 pass | `pnpm test -t 'P14:' -t 'P16:' -t 'P17:'` | engine | local |
| P10-05 | 10 | Latency re-run with index on, incl. cold-cache first write at Django scale < 2 s | re-run P5-07/P5-08 with `DNR_STATE_DIR` empty | hook | local |
| P10-06 | 10 | `.dnr/config.json` frozen (commit + sha256 in prereg) | `git log -1 -- .dnr/config.json` ; `sha256sum .dnr/config.json` in `reports/preregistration.md` | trial | needs-user |
| GATE-1a | 10 | Recorded events exit 2 | `for f in fixtures/hook-events/reapply-*.json; do dnr check --stdin --hook kiro < $f; test $? -eq 2; done` | hook | needs-kiro |
| GATE-1b | 10 | **Live headless block** on DEMO: `HEAD == start_sha` and `git add -A -N && git diff --quiet <start_sha> -- . ':!.kiro' ':!.dnr' ':!.gitignore'`; one retry with `--agent dnr-gate-1b` | `cd DEMO && kiro-cli chat --v3 --no-interactive --trust-all-tools "$(cat $ROOT/scripts/demo/prompts/write.txt)"` then the two checks | hook | needs-kiro |
| GATE-1c | 10 | 1b also passes under an isolated HOME | same as 1b with `HOME=$(mktemp -d)` seeded per §9.3 | hook | needs-kiro |
| GATE-1d | 10 | One event logged per write | count write-tool calls in transcript = lines in `events.jsonl` | hook | needs-kiro |
| GATE-2 | 10 | Exact replays blocked for both demo and all 5 gate reverts, **and** held-out recall ≥ 70% (5 × 2 families × 7 reverts = 70 mutants) | `dnr trial falsealarm --role gate` + replay script ; recall line in `gate.md` | trial | needs-user |
| GATE-3 | 10 | ≥ 20 real negatives (gate reverts' later commits + 5 scripted hard negatives) → ≤ 2 match-tier blocks; warn blocks separate; < 20 → pass only at 0 | `dnr trial falsealarm --role gate` ; counts in `gate.md` | trial | needs-user |
| GATE-4 | 10 | Zero `error_open` across demo-L, dry-run and replayed hard-negative events | `jq -s 'map(select(.decision.outcome=="error_open"))\|length' …` = 0 | hook | needs-kiro |
| P10-07 | 10 | Relocation caches: `dnr orders relocate` for Django, repo2, syn-src writes only `cache/fingerprints.json`; order files unchanged | `sha256sum reports/orders/*.json > a; dnr orders relocate --orders reports/orders; sha256sum -c a` | engine | local |
| P10-08 | 10 | `trial prepare` re-run and Phase 9 dry runs repeated after relocation | repeat P9-01…P9-08 | trial | needs-kiro |
| P10-09 | 10 | Demo runs `demo/{T,L,LU,U,CE}` r1–r3 on both demo reverts | `dnr trial prepare --namespace demo && dnr trial run --namespace demo` ; 30 `ok` rows in manifest | trial | needs-kiro |
| P10-10 | 10 | Practice runs `practice/T`, `practice/H` on the 2 tune reverts (excluded from counts) | `dnr trial run --namespace practice` | trial | needs-kiro |
| P10-11 | 10 | ast-grep baseline rules generated and hashed with `gen.ts` | `dnr trial baseline --generate && ls scripts/baseline/rules/` | trial | local |
| P10-12 | 10 | Credit check repeated before the tag | `docs/spikes.md` "Budget (Phase 10)" | user | needs-user |
| P10-13 | 10 | `prereg-v1` tagged with all §9.7 hashes (drafts, agent configs, frozen config, build SHA, L bundle, fixtures, baseline rules, caches); pushed; hash posted publicly | `git ls-remote --tags origin prereg-v1` ; link to the public post in `preregistration.md` | user | needs-user |

## Phase 11: Trial

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| P11-01 | 11 | Waves 1–3 complete incl. rdelta, syn, repo2; manifest all `ok` or listed | `dnr trial run --wave 1` … `--wave 3` ; `dnr trial run … --resume` exits 0 | trial | needs-trial-data |
| P11-02 | 11 | L starts only after Phase 6 acceptance | first L `started_at` > Phase 6 acceptance commit time | trial | needs-trial-data |
| P11-03 | 11 | The tag predates the first run | `git log -1 --format=%cI prereg-v1` < min `started_at` in manifest | trial | needs-trial-data |
| P11-04 | 11 | No run repo has commits newer than its `start_sha` | per run: `git -C $TR/runs/<id> rev-list <start_sha>..--all` empty | trial | needs-trial-data |
| P11-05 | 11 | HOME hashes match (S8 exclusions) | `meta.json` pre/post hashes equal for every run | trial | needs-trial-data |
| P11-06 | 11 | Probe run | `dnr trial probe` | trial | needs-trial-data |
| P11-07 | 11 | Baseline scored with the hashed rules | `dnr trial baseline --score && test -s reports/baseline.json` | trial | needs-trial-data |
| P11-08 | 11 | Both labelers covered every packet, incl. `--blocked` Q packets and probe grades; adjudicated | `dnr trial label --freeze` exits 0 | user | needs-user |
| P11-09 | 11 | Packet key's sha256 equals the one committed before labeling | checked inside `label --freeze` ; `git log` order of the two commits | trial | needs-trial-data |
| P11-10 | 11 | Replay from sealed events; false-alarm scan `--role trial` | `dnr trial replay && dnr trial falsealarm --role trial` | trial | needs-trial-data |
| P11-11 | 11 | `trial.json` written; `secondary` holds rdelta, syn, repo2, probe, baseline, human_reproposals | `dnr trial score --unseal && jq -e '.secondary \| [.rdelta,.syn,.repo2,.probe,.baseline,.human_reproposals] \| all(. != null)' reports/trial.json` | trial | needs-trial-data |
| P11-12 | 11 | `rescore --check` reproduces every count | `dnr trial rescore --check` exits 0 | trial | needs-trial-data |
| P11-13 | 11 | L runs with `error_open` listed; results with and without | section in `reports/trial.md` | trial | needs-trial-data |
| P11-14 | 11 | `trial.md` and `video/numbers.json` written | `dnr trial report` | trial | needs-trial-data |
| P11-15 | 11 | `reports/decision.md` applies §9.8 rows in order D1, D6, D2, D3, D4, D5 | `jq -r .row,.via_d6 reports/trial.json` matches `decision.md` | trial | needs-trial-data |
| P11-16 | 11 | Touch the Plan result final before Phase 11 labeling begins | `git log -1 --format=%cI -- reports/touch-the-plan-study.md` < first label commit | user | needs-user |

## Phase 12: Local board, MCP, power, TypeScript, Crew

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| P12-01 | 12 | Board flow: approve → block → allow once → allowed → TTL expires in a new session → blocked | `playwright test --grep @board-flow` | ui | local |
| P12-02 | 12 | Board flow driven through a real `dnr board` in `node-pty` (TTY and ancestry guard apply) | `playwright test --grep @board-pty` | ui | local |
| P12-03 | 12 | Keyboard-only use; axe 0 | `playwright test --grep @a11y-board` | ui | local |
| P12-04 | 12 | MCP SDK stdio test: `explain_function`, `list_orders_for_file`, never A/R tokens | `pnpm -F @dnr/mcp test` | hook | local |
| P12-05 | 12 | A live session calls `explain_function` before editing | transcript with the MCP call before the first write | hook | needs-kiro |
| P12-06 | 12 | Power loads in the S9 format; skill's first step is `dnr init` unless S9 shows bundling | `kiro-cli` loads `powers/dnr` ; screenshot/log in `docs/spikes.md` | kiro | needs-kiro |
| P12-07 | 12 | TS/JS support: extension table, `*.d.ts` excluded, weight-0 set, template literals, TS qualnames (overloads, namespaces, `export default`) | `pnpm test -t 'ts:'` | engine | local |
| P12-08 | 12 | P1–P5 on TS fixtures; TS case blocks in `/play` | `pnpm test -t 'P[1-5]: ts'` ; `playwright test --grep @ts-case` | engine | local |
| P12-09 | 12 | P16 on TS | `pnpm test -t 'P16: ts'` | engine | local |
| P12-10 | 12 | TS versions of all six mutation operators | `pnpm -F @dnr/testkit test -t 'mutate: ts'` | engine | local |
| P12-11 | 12 | Product mode on the TS demo repo: `dnr init && dnr scan && dnr orders build` (defaults to `.dnr/candidates.json`) → orders; after approval a scripted re-application is blocked | script in `scripts/demo/product-mode.sh` exits 0 | hook | local |
| P12-12 | 12 | `dnr scan`: language globs, no trial E-rules, `--branch` default from `origin/HEAD` | `pnpm test -t 'scan:'` | mining | local |
| P12-13 | 12 | `dnr-crew`: reusable workflow, install composite action, `dnr init --crew` writes the caller; `v1` tag moved | `gh api repos/<you>/dnr-crew/git/refs/tags/v1` ; `dnr init --crew && cat .github/workflows/dnr.yml` | kiro | needs-user |
| P12-14 | 12 | Crew acceptance: scripted Crew session re-applying `43933a1dca` → `dnr` check fails; one bot comment naming `dnr-43933a1dca` | `gh pr checks <pr> -R <you>/django-demo-crew` ; `gh pr view <pr> --comments` | kiro | needs-user |
| P12-15 | 12 | Write-access human's `/dnr allow dnr-43933a1dca` turns the check green on the head SHA | `gh pr checks` after the comment | kiro | needs-user |
| P12-16 | 12 | Non-Crew human PR reports `dnr` success | `gh pr checks` on a human PR | kiro | needs-user |
| P12-17 | 12 | Spoofing: other-App comment rejected; non-write PR editing `.github/**` or `.dnr/**` fails; a `dnr` check from another App doesn't satisfy protection | three scripted PRs ; results in `reports/crew-load.md` | kiro | needs-user |
| P12-18 | 12 | Crew load test: false-alarm corpus replayed as PRs; latency + outcome per PR | `bash scripts/crew/load-test.sh && test -s reports/crew-load.md` | kiro | needs-user |
| P12-19 | 12 | Regression gate: `.before` at start of Phase 12 and `.after` at end are byte-identical for every run | the `dnr check --replay … --canonical` command in 08 Phase 12 ; `diff -r` of `reports/regression/*.{before,after}` | trial | needs-trial-data |

## Phase 13: `/trial` and hardening

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| P13-01 | 13 | `/trial`, `/replay`, `/kiro` routes and the recorded-agent preset | `playwright test --grep @ROUTE-trial --grep @ROUTE-replay --grep @ROUTE-kiro` | ui | needs-trial-data |
| P13-02 | 13 | Real CLI loop on `/` (20 s loop of a real block) | asset in `apps/playground/public/` traced to a run ID | ui | needs-kiro |
| P13-03 | 13 | `docs/threat-model.md` (all §5.13 limits + board limits) and `docs/architecture.md` (diagram) | `grep -c` each §5.13 bullet in threat-model.md | kiro | local |
| P13-04 | 13 | CI green on Node 24 and 26 | `gh run list -w ci.yml -L1` matrix both green | kiro | needs-user |
| P13-05 | 13 | `lhci autorun` on `/`, `/play/<demo>`, `/graveyard` (mobile): perf ≥ 90, a11y = 100 | `npx @lhci/cli autorun` | ui | local |
| P13-06 | 13 | Same Lighthouse gate on `/trial` | `npx @lhci/cli autorun` incl. `/trial` | ui | needs-trial-data |
| P13-07 | 13 | Uptime (daily Playwright smoke until 2027-02-05) and monthly keepalive workflows; manual dispatch passes | `gh workflow run uptime.yml && gh run watch` | kiro | needs-user |
| P13-08 | 13 | npm `0.0.0` published by hand, trusted publishing linked, `release.yml` publishes `v0.1.0` with provenance; `vendor/grammars` in `files`; `bin.dnr` | `npm view "$(jq -r .npm_package fixtures/pins.json)" --json \| jq -e '.dist.attestations'` | user | needs-user |
| P13-09 | 13 | `dnr init` refuses an npx cache path; `dnr doctor` confirms the hook command resolves | `pnpm test -t 'init: npx'` | hook | local |
| P13-10 | 13 | Deep link case 1: hosted `/orders/:id?board=<port>`, board down → read-only + "Run `dnr board --open <id>`" banner | `playwright test --grep @deeplink-1` | ui | local |
| P13-11 | 13 | Deep link case 2: after `dnr board`, a deep link in a new page has working actions | `playwright test --grep @deeplink-2` | ui | local |
| P13-12 | 13 | Deep link case 3: `dnr board --open <id>` lands on that order with working actions | `playwright test --grep @deeplink-3` | ui | local |
| P13-13 | 13 | Deep link case 4: board up, hosted page probes `/api/health`, navigates to `origin`, actions work; Chromium, Firefox, WebKit with LNA permission | `playwright test --grep @deeplink-4` (3 projects) | ui | local |
| P13-14 | 13 | Empty states: no orders, all retired, board down, no trial data | `playwright test --grep @empty-states` | ui | local |
| P13-15 | 13 | Recovery capture: Phase 12 flow against a live `kiro-cli` session with `DNR_NOW` +1 h, saved with run ID | `ls reports/video/recovery/` | ui | needs-kiro |
| P13-16 | 13 | Maintainer pilot: prerequisites checked, written consent, `reports/pilot.md` + `pilot.json` (not pre-registered, never in `trial.json`) | `jq . reports/pilot.json` ; `grep -c consent reports/pilot.md` ≥ 3 | user | needs-user |
| P13-17 | 13 | README#testing passes on a clean devcontainer (5 steps: Playground, live block via `write.txt`, Codespaces `dnr doctor`, `npx {{pkg}} demo`, own repo) | a fresh Codespace walkthrough log in `docs/testing.md` | kiro | needs-user |
| P13-18 | 13 | `dnr demo` offline replay works with no network, no Kiro, no Django | `(unset DJANGO_SRC; dnr demo)` with networking off | hook | local |

## Phase 14: Ship

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| P14-01 | 14 | dev.to post, says it was written for Kiroween Hackathon 2026, covers Kiro, the property counterexample, the regex surprise; published in the window | link in Devpost form | user | needs-user |
| P14-02 | 14 | X and LinkedIn posts starting with `#KiroweenHackathon26`, saying what Kiro changed | links in Devpost form | user | needs-user |
| P14-03 | 14 | Crew bonus submission: `dnr-crew` README, `/.kiro`, description + S16 requirements | `gh repo view <you>/dnr-crew` ; `git -C dnr-crew ls-files .kiro` | user | needs-user |
| P14-04 | 14 | Startup/Student/Ghost profiles and the adoption/market paragraph, if eligible | Devpost form | user | needs-user |
| P14-05 | 14 | Kiro-surfaces card and write-up item 5 generated from files present in `.kiro/` and `powers/` | `node scripts/release/kiro-surfaces.mjs` output equals the card source | kiro | local |
| P14-06 | 14 | Tag `submission-2026`; Playground deploys only from that tag afterwards | `git ls-remote --tags origin submission-2026` ; `deploy-playground.yml` `on.push.tags` | user | needs-user |

## Properties P1–P17 (05 §12.1)

P6 was dropped (jsdiff). All fast-check, 500 runs locally, 2,000 nightly.

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| PROP-P1 | 4 | Exact re-application has edit score 1.0; blocked when order ≥ `min_order_weight`, not stale or degraded | `pnpm test -t 'P1:'` | engine | local |
| PROP-P2 | 4 | A write touching none of the order's tokens does not match | `pnpm test -t 'P2:'` | engine | local |
| PROP-P3 | 5 | Split into k writes, any order: blocked no later than the first write where score ≥ τ and two-sided holds | `pnpm test -t 'P3:'` | hook | local |
| PROP-P4 | 4 | A token in both A and R cannot cancel itself | `pnpm test -t 'P4:'` | engine | local |
| PROP-P5 | 4 | Scores in [0,1]; invariant under whitespace and comments | `pnpm test -t 'P5:'` | engine | local |
| PROP-P7 | 4 | Unchanged post-revert file scores 0 | `pnpm test -t 'P7:'` | engine | local |
| PROP-P8 | 4 | Removal-only re-application blocked for orders ≥ `min_order_weight` | `pnpm test -t 'P8:'` | engine | local |
| PROP-P9 | 7 | Browser and node builds produce identical decisions (Chromium, Firefox, WebKit) | `playwright test --grep @P9` | ui | local |
| PROP-P10 | 5/6 | Grant applies only to its own order while unexpired or used; pre-commit only for matching blobs | `pnpm test -t 'P10:'` | hook | local |
| PROP-P11 | 10 | Held-out recall (extract-helper, invert-condition) measured; gate requires ≥ 70% | = GATE-2 | trial | needs-user |
| PROP-P12 | 6 | After a re-land is committed, a later unrelated edit is allowed | `pnpm test -t 'P12:'` | hook | local |
| PROP-P13 | 6 | `ask`-approved re-land honored at Stop and pre-commit | `pnpm test -t 'P13:'` | hook | local |
| PROP-P14 | 10 | `prox_u` = 1 for exact replay of modified and added units at any size | `pnpm test -t 'P14:'` | engine | local |
| PROP-P15 | 6 | Split across two committed sessions blocked at `--staged` on the crossing commit, incl. A-heavy orders | `pnpm test -t 'P15:'` | hook | local |
| PROP-P16 | 10/12 | Moved/renamed unit (seeds 3100–3104) matched via fingerprint index, Python and TS, incl. moved + re-applied | `pnpm test -t 'P16:'` | engine | local |
| PROP-P17 | 10 | `prox_u` never negative; rewrite with no shared 3-shingles has `prox_u` = 0 | `pnpm test -t 'P17:'` | engine | local |
| PROP-REC | 4–10 | First failing property, its fix commit and re-run recorded (or "none failed") | `test -s reports/property-failures.md` | engine | local |

## Requirements R1–R15 (05 §12.1)

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| REQ-R1 | 5 | Match + `deny` → exit 2, first stderr line `DNR: <reason> <revert URL>` | `pnpm test -t 'R1:'` | hook | local |
| REQ-R2 | 5 | No match, covered unit, not yet warned → one `warn_block` in the configured format | `pnpm test -t 'R2:'` | hook | local |
| REQ-R3 | 5 | Later non-matching write to same order in session allowed (`warn_pass`) | `pnpm test -t 'R3:'` | hook | local |
| REQ-R4 | 5 | Baseline = session snapshot tree | `pnpm test -t 'R4:'` | hook | local |
| REQ-R5 | 4 | A and R matched separately with repeats; two-sided rule (≥ 0.3 each side) | `pnpm test -t 'R5:'` | engine | local |
| REQ-R6 | 5 | Protected globs denied in every format | `pnpm test -t 'R6:'` | hook | local |
| REQ-R7 | 5 | Internal errors allow and log; Stop always exits 0 | `pnpm test -t 'R7:'` | hook | local |
| REQ-R8 | 5 | p95 < 300 ms on the demo file | = P5-07 | hook | local |
| REQ-R9 | 5 | Grant applies while unexpired or for rest of session once used; each use logged, added to `grants_used` | `pnpm test -t 'R9:'` | hook | local |
| REQ-R10 | 4 | Stale orders only warn | `pnpm test -t 'R10:'` | engine | local |
| REQ-R11 | 10 | Missing unit → fingerprint lookup; else warn, unless `kind=removed`/`added` (score with `[]`) | `pnpm test -t 'R11:'` | engine | local |
| REQ-R12 | 5 | Match + `ask` → exit 0, `permissionDecision: "ask"` with same reason, `pending_ask` recorded | `pnpm test -t 'R12:'` | hook | local |
| REQ-R13 | 6 | `ask`-approved write → `session confirm` creates grant; neither Stop nor pre-commit blocks the re-land | `pnpm test -t 'R13:'` + P6-18 live | hook | local |
| REQ-R14 | 12 | Crew PR with a crossing → `dnr` fails; bot comment with order, reason, original/revert/ticket links, order file at base SHA (via `/orders/view?src=`) | = P12-14 | kiro | needs-user |
| REQ-R15 | 12 | `/dnr allow <id>` → blob-matched, HMAC-signed grant, check re-run, override in `audit.jsonl` artifact | = P12-15 | kiro | needs-user |

## Schemas (03 §7)

Each row: valid example parses, one invalid example per constraint fails. Proof is `pnpm -F @dnr/schemas test -t 'SCH-<Name>:'`; fixture-backed ones also run under `pnpm test:fixtures`.

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| SCH-Prim | 2 | `Sha40` lowercase 40-hex; `RepoPath` no `..`, no leading `/`; `Iso` with offset | `-t 'SCH-Prim:'` | engine | local |
| SCH-OrderUnit | 2 | file, qualname, kind, per-unit tokenizer {grammar, normalizer}, A, R, `c_state_ref`, 64-char hash, count ≥ 0 | `-t 'SCH-OrderUnit:'` | engine | local |
| SCH-Order | 2 | `dnr.order/v1`, id regex, status ∉ {stale}, links ≥ 1, reason 1–280, units ≥ 1, history actions | `-t 'SCH-Order:'` | engine | local |
| SCH-Grant | 2 | kind allow_once/ask, used kinds write/commit/backstop, blobs | `-t 'SCH-Grant:'` | engine | local |
| SCH-Session | 2 | key_source, baseline_tree, pending_ask entries, grants_used, touched, shell_snapshot, stop_forced_turns ≥ 0 | `-t 'SCH-Session:'` | engine | local |
| SCH-Decision | 2 | 11 outcomes, 4 tiers, scope literal `order`, fired_by | `-t 'SCH-Decision:'` | engine | local |
| SCH-Event | 2 | `EventRecord` with 4 modes, 7 hooks, `proposed_text`, `session_patch` | `-t 'SCH-Event:'` | engine | local |
| SCH-Canon | 5 | Canonical projection drops `latency_ms`, `fast_path`; sorted keys | `-t 'SCH-Canon:'` ; `dnr check --replay --canonical` stable | hook | local |
| SCH-RevertCase | 3 | repo enum, match_method, tags, revert_kind, 13 reason categories, role nullable, restored_tests, env fields | `-t 'SCH-RevertCase:'` | mining | local |
| SCH-Arm | 2 | `T U B S H L T2 T3 LU CE PROBE` | `-t 'SCH-Arm:'` | engine | local |
| SCH-RunRecord | 2 | run_id pattern `<ns>/<arm>/<sha10>/r<k>`, 7 namespaces, `start_sha` null only for probe, l_outcome | `-t 'SCH-RunRecord:'` | engine | local |
| SCH-Label | 2 | packet length 6, 6 labels, arm_guess | `-t 'SCH-Label:'` | engine | local |
| SCH-Ratio | 2 | num, den, wilson tuple | `-t 'SCH-Ratio:'` | engine | local |
| SCH-ProbeGrade | 2 | grade ∈ {0,1,2} | `-t 'SCH-ProbeGrade:'` | engine | local |
| SCH-ScanCandidate | 12 | `.dnr/candidates.json` lines | `-t 'SCH-ScanCandidate:'` | mining | local |
| SCH-TrialResult | 11 | all counts, row D1–D6, via_d6, kappa, mode, secondary records, prereg_sha | `-t 'SCH-TrialResult:'` | engine | local |
| SCH-KnownRevert | 0 | matched_form, confirmed_by; plus `KnownRevertRejected` | `pnpm test:fixtures` | mining | local |
| SCH-CaseBundle | 7 | `dnr.case/v1`, files with three texts, 6 preset kinds, source repo + license | `-t 'SCH-CaseBundle:'` | engine | local |
| SCH-Pins | 0 | strictObject; all fields incl. model_cutoff, npm_package, docker_images, tools | `pnpm test:fixtures` on `fixtures/pins.json` | engine | local |
| SCH-Assignment | 3 | revert_sha, repo, role, rank | `pnpm test:fixtures` | mining | local |
| SCH-EnvMatrix | 3 | kind uv/docker/cpython-build, image nullable, ok | `pnpm test:fixtures` | mining | local |
| SCH-Flaky | 3 | revert_sha, test | `pnpm test:fixtures` | mining | local |
| SCH-Proposal | 3 | `candidates.jsonl` lines with proposed_category, rule | `pnpm test:fixtures` | mining | local |
| SCH-Discussion | 3 | source trac/github/bpo, comments, fetched_at | `pnpm test:fixtures` | mining | local |
| SCH-ReasonLabel | 3 | category, adjudicated | `pnpm test:fixtures` | mining | local |
| SCH-CriticalEdit | 3 | side added/removed, tokens, adjudicated | `pnpm test:fixtures` | mining | local |
| SCH-SynCase | 9 | RevertCase + repo `syn`, role `synthetic`, ticket, critical_edit | `pnpm test:fixtures` on `fixtures/syn/cases.json` | mining | needs-user |
| SCH-Strict | 2 | Fixture schemas use `z.strictObject` (unknown field fails) | `-t 'SCH-Strict:'` | engine | local |

## Hook files, exit codes, config (03 §6, 04 §8)

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| HOOK-01 | 5 | `dnr-pre-write.json` byte-equal in content to §6 (PreToolUse, matcher `write`, `dnr check --stdin --hook kiro`, timeout 10) | `jq -S . .kiro/hooks/dnr-pre-write.json` vs expected | kiro | local |
| HOOK-02 | 6 | `dnr-post-write.json` (PostToolUse, `write`, `dnr session confirm --stdin`, 10) | `jq -S` compare | kiro | local |
| HOOK-03 | 6 | `dnr-guard-shell.json` (PreToolUse, `shell`, `dnr guard-shell --stdin`, 10) | `jq -S` compare | kiro | local |
| HOOK-04 | 6 | `dnr-stop-backstop.json` (Stop, **no matcher**, `dnr check --worktree --hook stop --max-forced-turns 2`, 30) | `jq -e '.hooks[0] \| has("matcher") \| not'` | kiro | local |
| HOOK-05 | 6 | `dnr-post-shell.json` (PostToolUse, `shell`, `dnr session shell-after --stdin`, 10) | `jq -S` compare | kiro | local |
| HOOK-06 | 6 | `dnr-session-start.json` (SessionStart, `dnr session start --stdin`, 10; optional) | `jq -S` compare | kiro | local |
| HOOK-07 | 1 | `dev-core-tests-on-save.json` on `PostFileSave`, regex `packages/core/.*\.ts$` | file present ; fires in IDE (S14) | kiro | needs-kiro |
| HOOK-08 | 5 | Hooks load in Kiro (V3 shape `{"version":"v1","hooks":[…]}`, PascalCase triggers) | `kiro-cli` session shows the hook firing | kiro | needs-kiro |
| HOOK-09 | 6 | `ask` format: exit 0 + `{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":…}}`; protect tier always denies | `pnpm test -t 'format: ask'` | hook | local |
| HOOK-10 | 6 | If S8 says no PATH inheritance, `dnr init` writes absolute `dnr` path into each command | `pnpm test -t 'init: abs path'` | hook | needs-kiro |
| HOOK-11 | 6 | Pre-commit hook is `exec dnr check --staged`, installed only when none exists | `pnpm test -t 'init: pre-commit'` | hook | local |
| EXIT-01 | 5 | Hook `deny`: 0 allow (incl. every internal error), 2 block | `pnpm test -t 'exit: deny'` | hook | local |
| EXIT-02 | 5 | Hook `ask`: always 0 | `pnpm test -t 'exit: ask'` | hook | local |
| EXIT-03 | 6 | `--hook stop`: always 0 (forced turn via JSON) | `pnpm test -t 'exit: stop'` | hook | local |
| EXIT-04 | 5 | Other commands: 0 clean, 1 findings, 64 usage, 65 Zod-invalid, 69 dependency missing, 70 internal | `pnpm test -t 'exit: codes'` | hook | local |
| EXIT-05 | 9 | `dnr trial *` exits 1 when any run is not `ok`, listing them on stderr | `pnpm test -t 'exit: trial'` | trial | local |
| CFG-01 | 2 | `.dnr/config.json` defaults exactly as §7 | `pnpm -F @dnr/schemas test -t 'config:'` | engine | local |
| CFG-02 | 5 | Lookup: `DNR_CONFIG` → `<repo>/.dnr/config.json` → defaults; `DNR_MODE` overrides `mode`; `DNR_THRESHOLD` overrides threshold | `pnpm test -t 'config: lookup'` | hook | local |
| CFG-03 | 5 | Env vars `DNR_ORDERS`, `DNR_STATE_DIR`, `DNR_RECORD_PATH`, `DNR_NOW`, `DNR_DEBUG` honored | `pnpm test -t 'env:'` | hook | local |
| CFG-04 | 5 | Only `.dnr/orders/` and `.dnr/config.json` are committed; everything else under `.dnr/` ignored | `git check-ignore .dnr/grants/x .dnr/events.jsonl .dnr/board.json .dnr/drafts/x` all ignored ; `.dnr/orders/x` not | kiro | local |

## CLI commands (04 §8)

Each command exists, prints help, and returns 64 on bad usage. Behavioural checks live in the phase rows.

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| CLI-init | 5/6 | `dnr init [repo] [--mode] [--decision-format] [--hooks pre-write\|all] [--crew] [--force]` | `dnr init --help` ; P5-12, P6-09/10, P13-09 | hook | local |
| CLI-doctor | 6 | `dnr doctor` | P6-11 | hook | needs-kiro |
| CLI-scan | 12 | `dnr scan [--branch --since --until --lang --fetch-tickets --out]` | P12-12 | mining | local |
| CLI-demo | 13 | `dnr demo` | P13-18 | hook | local |
| CLI-relocate | 10 | `dnr orders relocate --orders [--git-dir]` | P10-07 | engine | local |
| CLI-build | 4 | `dnr orders build [--from] [--only] [--out-dir] [--git-dir]` | P4-04, P4-07 | engine | local |
| CLI-orders | 4 | `dnr orders list\|show [--tokens]\|approve [--all]\|retire\|unretire\|edit\|reapprove\|verify [--orders] [--by]` | `pnpm test -t 'cli: orders'` | hook | local |
| CLI-draft | 8 | `dnr draft [--order\|--all] [--orders] [--trial]` | P8-01 | trial | needs-kiro |
| CLI-steering | 8 | `dnr steering generate [--orders] [--out]`, default `.kiro/steering/dnr-history.md` | P8-07 | trial | local |
| CLI-check-hook | 5 | `dnr check --stdin --hook kiro` | P5-07, REQ-R1 | hook | local |
| CLI-session | 5 | `dnr session start\|confirm\|shell-after\|show\|end\|gc --stdin` | P5-11 | hook | local |
| CLI-worktree | 6 | `dnr check --worktree [--hook stop --max-forced-turns 2]` | P6-03 | hook | local |
| CLI-staged | 6 | `dnr check --staged` | P6-06, PROP-P15 | hook | local |
| CLI-commit | 5 | `dnr check --commit <sha> [--config]`, re-landed flagged | P5-10 | hook | local |
| CLI-file | 5 | `dnr check --file <rel> --proposed <path>` | P5-11 | hook | local |
| CLI-replay | 5 | `dnr check --replay <events> [--canonical] [--git-dir]` | P12-19, SCH-Canon | hook | local |
| CLI-guard | 6 | `dnr guard-shell --stdin` | P6-01 | hook | local |
| CLI-allow | 5 | `dnr allow <id> [--ttl 1h]`, human only | P5-11, P6-14 | hook | local |
| CLI-board | 12 | `dnr board [--port] [--open] [--host 127.0.0.1]`; refuses under agent ancestry; never prints nonce | P12-01/02, AUTH rows | ui | local |
| CLI-mcp | 12 | `dnr mcp` | P12-04 | hook | local |
| CLI-explain | 12 | `dnr explain <file> <qualname>` | `pnpm test -t 'cli: explain'` | hook | local |
| CLI-export | 7 | `dnr export-case <revert> [--orders] [--git-dir] [--out]` | P7-02 | ui | local |
| CLI-tickets | 3 | `dnr trial tickets [--repo]` | P3-08 | mining | local |
| CLI-mine | 3 | `dnr trial mine [--labels] [--repo]` | P3-01/02/12 | mining | local |
| CLI-envs | 3 | `dnr trial envs [--repo] [--stratum rdelta]` | P3-14 | mining | local |
| CLI-assign | 3 | `dnr trial assign [--repo]` | P3-13 | mining | local |
| CLI-probe | 9 | `dnr trial probe [--dry-run --only]` | P9-08, P11-06 | trial | needs-kiro |
| CLI-baseline | 10 | `dnr trial baseline --generate\|--score` | P10-11, P11-07 | trial | local |
| CLI-prepare | 9 | `dnr trial prepare [--namespace] [--stratum] [--cohort]` | P9-04…07 | trial | local |
| CLI-run | 9 | `dnr trial run --wave\|--namespace [--concurrency 4 --resume --dry-run --only]` | P9-01, P11-01 | trial | needs-kiro |
| CLI-label | 3/11 | `dnr trial label --labeler [--probe\|--reasons\|--critical-edits\|--blocked]` / `--freeze` | P3-11, P11-08 | trial | local |
| CLI-score | 11 | `dnr trial replay`, `falsealarm [--config] [--role]`, `score [--unseal]`, `rescore --check`, `report` | P11-10…14 | trial | local |

## Routes, states, auth (07 §10)

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| ROUTE-01 | 7 | `/`: pitch, 20 s real CLI loop (placeholder until filmed), buttons Try a revert / See the trial / How Kiro built it | `playwright test --grep @ROUTE-01` | ui | local |
| ROUTE-02 | 7 | `/play/:case`: order card with A/R chips (+/−), editor on post-revert baseline, all presets + reset, Send write session simulator | `--grep @ROUTE-02` | ui | local |
| ROUTE-03 | 7 | `/play` decision panel: BLOCK/ASK/WARN/ALLOW + exit code, exact stderr + JSON, scores with threshold bars and highlighted tokens, simulated Approve/Allow once/Retire/Edit, Advance 1 h | `--grep @ROUTE-03` | ui | local |
| ROUTE-04 | 7 | `/orders/view?src=`: only `raw.githubusercontent.com`; Zod-validated; error state | `--grep @ROUTE-04` | ui | local |
| ROUTE-05 | 7 | `/graveyard` headstones: epitaph (reason), birth (commit), death (revert), links; every element has a text label | `--grep @ROUTE-05` | ui | local |
| ROUTE-06 | 7 | `/orders/:id` with history and audit panel (history, grants with uses and expiry, Crew overrides) | `--grep @ROUTE-06` | ui | local |
| ROUTE-07 | 13 | `/trial` Trial Explorer: headline lines, per-arm tables, per-run diff, timeline, labels, tests, decision, false alarms, pins, prereg hash; Recompute in browser matches `trial.json` | `--grep @ROUTE-07` | ui | needs-trial-data |
| ROUTE-08 | 13 | `/replay`: paste PreToolUse stdin or pick a fixture → decision | `--grep @ROUTE-08` | ui | local |
| ROUTE-09 | 13 | `/kiro`: each Kiro feature → file → what it changed | `--grep @ROUTE-09` | ui | local |
| ROUTE-10 | 7 | Hosted `/orders/:id?board=<port>`: probe board `/api/health`; success → navigate to returned origin; failure → read-only demo orders or banner for unknown IDs | = P13-10…13 | ui | local |
| STATE-01 | 7 | draft: outlined, "Draft: not enforced", Approve/Edit/Retire | `--grep @STATE-01` | ui | local |
| STATE-02 | 7 | approved: solid, "Approved: enforced", Allow once/Edit/Retire | `--grep @STATE-02` | ui | local |
| STATE-03 | 7 | retired: faded, "Retired", Unretire | `--grep @STATE-03` | ui | local |
| STATE-04 | 7 | stale: cracked, "Stale: code changed, warn only", Re-approve (rebases)/Retire; stale → re-approve flow | `--grep @STATE-04` | ui | local |
| STATE-05 | 7 | re-landed: candle, "Re-landed: warn only until re-approved" | `--grep @STATE-05` | ui | local |
| STATE-06 | 12 | drift: red border, "Differs from git", View diff/Restore from git | `--grep @STATE-06` | ui | local |
| STATE-07 | 13 | Empty: no orders ("Run `dnr scan`"), 0 reverts found ("`dnr orders add`"), drafts only ("N drafts, 0 enforced") | `--grep @STATE-07` | ui | local |
| STATE-08 | 12 | Error banners: 401, 409, Zod-invalid order; in `/play`: parse-degraded, `error_open` | `--grep @STATE-08` | ui | local |
| STATE-09 | 6 | `dnr init`, `scan`, `orders build` each print the single next command | `pnpm test -t 'next command:'` | hook | local |
| A11Y-01 | 7 | WCAG 2.2 AA: 0 axe violations, keyboard access, `aria-live` decisions, color never the only signal, reduced motion | `--grep @axe` on every route | ui | local |
| API-01 | 12 | `GET /api/health` and `/api/ping` → `{origin, version}`, no auth, no repo data, CORS only to Playground origin, `Access-Control-Allow-Private-Network: true` | `pnpm -F @dnr/board test -t 'API-01:'` | ui | local |
| API-02 | 12 | `GET /api/orders` (effective status + drift flag), `GET /api/orders/:id`, `GET …/diff`, `GET /api/events?order=` | `-t 'API-02:'` | ui | local |
| API-03 | 12 | `PATCH /api/orders/:id {status?, reason?}` → 409 on invalid transition | `-t 'API-03:'` | ui | local |
| API-04 | 12 | `POST …/allow-once {ttl}` creates a session grant; `POST …/reapprove` rebases snapshot | `-t 'API-04:'` | ui | local |
| AUTH-01 | 12 | Launch nonce single-use, expires at 60 s; reused or expired refused | `-t 'AUTH-01:'` | ui | local |
| AUTH-02 | 12 | `*.localhost` probe → per-launch host; Safari/failed probe → `127.0.0.1`; `--host 127.0.0.1` forces it | `playwright --grep @AUTH-02` (3 engines) | ui | local |
| AUTH-03 | 12 | Bad `Host` → 421 (DNS rebinding) | `-t 'AUTH-03:'` | ui | local |
| AUTH-04 | 12 | Cookie `dnr_<port>_<rand>`, `HttpOnly; SameSite=Strict; Path=/api`, rotates per launch | `-t 'AUTH-04:'` | ui | local |
| AUTH-05 | 12 | No cookie → 401 on every `/api/*` except health and ping | `-t 'AUTH-05:'` | ui | local |
| AUTH-06 | 12 | Mutating route with missing or foreign `Origin` → 403 | `-t 'AUTH-06:'` | ui | local |
| AUTH-07 | 12 | Mutating route without `X-DNR-CSRF: 1` → 403 | `-t 'AUTH-07:'` | ui | local |
| AUTH-08 | 12 | Nonce never printed or written to stderr | `dnr board 2>&1 \| grep -c 'n='` = 0 | ui | local |
| AUTH-09 | 12 | R7: board's live port in `$DNR_STATE_DIR/board.json` covered by guard-shell; other localhost ports allowed | `pnpm test -t 'R7 port:'` | hook | local |
| DEPLOY-01 | 7 | GitHub Pages mirror serves WASM (no custom CSP) | `curl -sI https://<you>.github.io/dnr/… \| grep application/wasm` | ui | needs-user |

## Kiro artifacts (05 §12.2–12.5)

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| KIRO-01 | 2+ | Spec `dnr-check` (requirements with R1–R15 EARS, design, tasks) written **in Kiro IDE spec mode**; each task ticked with its commit SHA | `ls .kiro/specs/dnr-check/` ; `grep -c '\[x\].*[0-9a-f]\{7\}' .kiro/specs/dnr-check/tasks.md` | kiro | needs-kiro |
| KIRO-02 | 9 | Spec `trial-harness` likewise | same for `trial-harness` | kiro | needs-kiro |
| KIRO-03 | 0 | `steering/product.md` inclusion always (present) | `head -3 .kiro/steering/product.md` | kiro | local |
| KIRO-04 | 2 | `steering/tech.md` inclusion always: pins, isomorphic core, Zod at boundaries, exit codes, fail-open | front-matter check | kiro | local |
| KIRO-05 | 1 | `steering/hook-contracts.md` fileMatch `packages/hook/**, .kiro/hooks/**`; frozen stdin shapes, output formats, 1,200 cap | front-matter + content | kiro | needs-kiro |
| KIRO-06 | 3 | `steering/trial-integrity.md` fileMatch `packages/trial/**, reports/**, fixtures/**` | front-matter | kiro | local |
| KIRO-07 | 6 | `steering/dnr.md` shipped by `dnr init` (call `explain_function`; don't route around a block; report the ID) | `dnr init DEMO && test -f DEMO/.kiro/steering/dnr.md` | kiro | local |
| KIRO-08 | 8 | `agents/dnr-drafter.json`: `tools: []`, pinned model, prompt `file://../prompts/drafter.md`, untrusted tags, exact JSON output; bundled in npm package | `jq -e '.tools == [] and .model' .kiro/agents/dnr-drafter.json` | kiro | local |
| KIRO-09 | 1 | `agents/dnr-gate-1b.json` registers the always-block hook via agent config (S10 key shape) | file + S10 | kiro | needs-kiro |
| KIRO-10 | 12 | `settings/mcp.json` runs `dnr mcp` | `jq . .kiro/settings/mcp.json` | kiro | local |
| KIRO-11 | 12 | `powers/dnr/plugin.json` verified fields (`$schema`, name, version, description, author.name, keywords; license/repository only if S9 confirms), `mcp.json`, `skills/dnr-guard/SKILL.md`, `POWER.md` fallback | `jq -e '."$schema" and .name and .author.name' powers/dnr/plugin.json` | kiro | local |
| KIRO-12 | 12 | `dnr-crew/.kiro/specs/crew-check/` exists | `git -C dnr-crew ls-files .kiro/specs/crew-check` | kiro | needs-user |
| KIRO-13 | 14 | `.kiro` not in `.gitignore` | `git check-ignore .kiro/steering/product.md` exits 1 | kiro | local |

## Trial integrity (06 §9)

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| TRIAL-01 | 9 | `$TRIAL_ROOT` absolute, not inside `$ROOT` and not a sibling of it | `pnpm test -t 'trial: root'` asserts `realpath` relations at startup | trial | local |
| TRIAL-02 | 11 | `chmod 000` on discussion, sealed, labeling, `$DJ`, `$SECOND_SRC`, syn-src during waves; restored after | harness log lines ; `stat` during a run | trial | needs-trial-data |
| TRIAL-03 | 11 | Runs whose transcript touches a path outside working copy and HOME excluded and listed | `reports/trial.md` exclusion table | trial | needs-trial-data |
| TRIAL-04 | 9 | Per-run order set holds only ancestors of R; built for every revert passing E1–E5, E7; size in `meta.json`; hashed before/after | `pnpm test -t 'trial: order set'` | trial | local |
| TRIAL-05 | 9 | Only arm S gets a file in the working copy (its steering) | `git -C <run> status --porcelain` before agent start | trial | local |
| TRIAL-06 | 9 | `DNR_CONFIG` is the frozen copy; its sha256 in every `meta.json`; `rescore --check` asserts it matches `prereg-v1` | `jq -r .config_sha256 $TR/runs/*/meta.json \| sort -u \| wc -l` = 1 | trial | needs-trial-data |
| TRIAL-07 | 9 | Retry only infra failures before the first tool call, ≤ 2; concurrency 4 | `pnpm test -t 'run: retry'` | trial | local |
| TRIAL-08 | 11 | Version change of kiro-cli stops the trial; auto-update off | `pnpm test -t 'run: version drift'` | trial | local |
| TRIAL-09 | 11 | Packet key sha256 committed before labeling, key after freeze | git history order | trial | needs-trial-data |
| TRIAL-10 | 11 | κ per labeling session; session < 0.4 re-labeled after adjudication; raw agreement, binary + 6-class κ, PABAK, AC1, bootstrap CIs; builder-vs-outside reported | `reports/kappa.md` | trial | needs-trial-data |
| TRIAL-11 | 11 | Wilson 95% on every rate; exact McNemar T/S, T/L, S/L labeled underpowered; non-prereg = "exploratory" | `pnpm test -t 'stats:'` (golden values: 2/8 → 7–59%, 0/30 → 0–11.4%, 7/30 → 12–41%) | trial | local |
| TRIAL-12 | 10 | `reports/preregistration.md` contains every §9.7 item, incl. §9.8 table verbatim | `node scripts/check-prereg.mjs` diffing the §9.8 table text | trial | local |
| TRIAL-13 | 11 | SYN auto-labels: FULL = restored test passes; CORE = contiguous critical-edit token sequence after weight-0 drop, inside target unit | `pnpm test -t 'syn: oracle'` | trial | local |
| TRIAL-14 | 11 | Pilot results never enter `trial.json` | `jq 'paths' reports/trial.json \| grep -c pilot` = 0 | trial | local |
| TRIAL-15 | 3 | Ticket text never reaches a trial agent (only labelers and drafter) | `grep -r discussion $TR/homes $TR/runs` empty | trial | local |

## Video and write-up (09 §11)

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| VID-01 | 14 | Length < 180 s (target 2:50), 1080p | `ffprobe -v error -show_entries format=duration:stream=height -of json video.mp4` | user | needs-user |
| VID-02 | 14 | **Real block on screen by 0:19** (D1-failed-study: commit refused by 0:19), from `demo/L` (or `demo/LU`), run ID on screen | frame at 0:19 shows the DNR stderr and run ID | kiro | needs-kiro |
| VID-03 | 14 | Filmed case chosen by the §11 rule (demo/T re-applied + tests pass; demo/L `stopped_and_reported`/`retried_and_blocked`), else LU, else FB-1 | `reports/video/choice.md` with run IDs | trial | needs-kiro |
| VID-04 | 14 | Raw stream-json transcripts and events of filmed runs committed | `ls reports/runs/demo/*/` | trial | needs-kiro |
| VID-05 | 14 | Every caption/narration line generated from `numbers.json` for the applied row; checker passes (numbers vs `trial.json`, §9.8 wording verbatim, word caps, banned stems under D3/D5/D6 outside code spans) | `node scripts/video/check-numbers.mjs` | trial | needs-trial-data |
| VID-06 | 14 | Caption word caps: audience ≤ 8, reason_short ≤ 5, task_short ≤ 4 (no path) | included in VID-05 | trial | local |
| VID-07 | 14 | Captions burned in ≥ 36 px; understandable with sound off | review frame grabs | user | needs-user |
| VID-08 | 14 | Results card: three lines over K_eff; `s_close_to_l` variant; D6 shows no rate lines | numbers.json fields | trial | needs-trial-data |
| VID-09 | 14 | Fallback clips FB-1…FB-6 recorded before filming | `ls reports/video/fallback/FB-{1..6}*` | user | needs-kiro |
| VID-10 | 14 | Kiro chain 2:05–2:30 keyed on `property-failures.md` (property or spike fallback) | chain sources listed in `reports/video/chain.md` | kiro | local |
| VID-11 | 14 | Public YouTube link works in a private window | open link logged out | user | needs-user |
| WRITE-01 | 14 | `docs/kiro-usage.md` sections 1–7 in order (problem + GIF; audience; how it works + diagram, 3a Why Frankenstein, 3b surprises; trial + prereg link; Kiro surfaces generated from files; Try it URL first; limits) | `grep -n '^## ' docs/kiro-usage.md` | kiro | local |
| WRITE-02 | 14 | Innovation names prior art (New Math Data history steering = arm S, Saguaro, Kiro memory, CodeRabbit learnings, ast-grep baseline) with the stated difference | `grep -c -e 'New Math Data' -e Saguaro -e CodeRabbit docs/kiro-usage.md` | kiro | local |
| WRITE-03 | 14 | Pitch, README one-liner, tagline, Impact paragraph generated from `numbers.json` for the applied row | VID-05 checker covers these files | trial | needs-trial-data |

## Submission checklist (09 §11)

| ID | Ph | Check | Proof | Owner | Class |
|---|---|---|---|---|---|
| SUB-01 | 14 | Video under 3 minutes, public on YouTube | = VID-01, VID-11 | user | needs-user |
| SUB-02 | 14 | Repo public; open-source license detectable in the About panel | `gh repo view <you>/dnr --json visibility,licenseInfo` | user | needs-user |
| SUB-03 | 14 | `git ls-files .kiro` non-empty; `.kiro` not ignored | = P0-44, KIRO-13 | kiro | local |
| SUB-04 | 14 | Playground URL works without a login, free, stays up through judging (to 2027-01-29) | logged-out browser ; uptime workflow | user | needs-user |
| SUB-05 | 14 | `README.md#testing` present | `grep -n '^## Testing' README.md` | kiro | local |
| SUB-06 | 14 | Category: Frankenstein | Devpost form | user | needs-user |
| SUB-07 | 14 | Bonus entries: Crew (separate repo, own account), Blog, Social Blitz, Startup/Student/Ghost if eligible | Devpost form | user | needs-user |
| SUB-08 | 14 | Every claim links to a file in `reports/` or `.kiro/` | `node scripts/release/check-claims.mjs docs/kiro-usage.md README.md` | kiro | local |
| SUB-09 | 14 | Devpost form submitted before Dec 4 14:00 PT (target 10:00 PT) | Devpost confirmation | user | needs-user |

## Row counts

| Class | Rows |
|---|---:|
| `local` | 278 |
| `needs-kiro` | 60 |
| `needs-user` | 83 |
| `needs-trial-data` | 26 |
| **Total** | **447** |

(Counted with `awk '/^## Row counts/{exit} 1' docs/acceptance-matrix.md | grep -oE '[|] (local|needs-kiro|needs-user|needs-trial-data) [|]$' | sort | uniq -c`; re-run after edits.)

---

## Critical path to a winning submission

The plan has 447 checks and 8 days. These are the 14 links whose failure sinks the entry. Every one of them has to hold, in this order. Everything not on this list is strength, not survival. Dates are Pacific; IST is +13:30.

| # | Link | Rows | Class | Needed by |
|---|---|---|---|---|
| 1 | **Kiro credits requested** with ID verification. Cutoff is Dec 1 12:00 PT, but processing takes ~48 business hours and Thanksgiving slows it, so request today | P0-01 | **needs-user** | **Thu Nov 26 (today); Fri Nov 27 at the latest** |
| 2 | **`kiro-cli` installed and logged in** on this machine; model listed and pinned; API key for headless | P0-03, P0-04, P0-05 | **needs-user** | **Fri Nov 27** |
| 3 | **S1 + S2 + S5 + S8 + S11**: does a PreToolUse write hook block headless; field names; ask/deny; PATH; credits per run. S1 decides D1 four days before anything else could | S1, S2, S5, S8, S11 | needs-kiro | Sat Nov 28 |
| 4 | **Public GitHub repo** `dnr` pushed (it has no remote today), so CI, Pages and the URL can exist | P0-06 | **needs-user** | **Sat Nov 28** |
| 5 | Engine: tokenize, qualname, diff, score, order build for `dnr-43933a1dca` (P1, P2, P5, P8 green) | P2-01…13, P4-04, P4-06 | local | Sat Nov 28 |
| 6 | Hook path: `dnr check --stdin --hook kiro` exits 2 with the §6 stderr; temp-index baseline; `dnr init --hooks pre-write`; fail-open | P5-01, P5-07, P5-12, REQ-R1, REQ-R7 | local (+S2) | Sun Nov 29 |
| 7 | **Gate check 1b: a live headless Kiro block** on `../django-demo` with HEAD and tree unchanged. Without this there is no product, and the video's 0:12–0:19 slot is empty | GATE-1b, GATE-1a | needs-kiro | **Mon Nov 30** |
| 8 | **Credits in hand** (granted or a paid plan bought); budget fits the runs actually planned | P0-02 | **needs-user** | **Mon Dec 1 12:00 PT** (hard) |
| 9 | **Hosted Playground URL**: `/play/43933a1dca` runs `@dnr/core` in the browser on a public URL, no login. Devpost requires it | P7-02, P7-04, ROUTE-02/03, P7-08 or DEPLOY-01 | local + **needs-user** (Cloudflare token or Pages enabled) | Tue Dec 2 |
| 10 | **Filmable demo runs**: `demo/L` / `demo/LU` r1–r3 and `demo/T` on 43933a1dca, transcripts committed | P10-09, VID-03, VID-04 | needs-kiro | Tue Dec 2 |
| 11 | **Some honest measured result**: `prereg-v1` tagged, then at least wave 1 T + L (+ S) on the Django reverts, labeled under the §9.5 fallback if no outsider is booked, `decision.md` written | P10-13, P11-01, P11-15 | needs-user + needs-trial-data | Wed Dec 3 |
| 12 | **Video**: < 3:00, real block by 0:19, captions from `numbers.json`, public on YouTube | VID-01, VID-02, VID-11 | **needs-user** | **Thu Dec 3 (evening)** |
| 13 | README#testing, `.kiro` tracked, license in About, `docs/kiro-usage.md` | SUB-02, SUB-03, SUB-05, WRITE-01 | local + needs-user | Thu Dec 3 |
| 14 | **Devpost form submitted**, Frankenstein category | SUB-06, SUB-09 | **needs-user** | **Fri Dec 4 10:00 PT** (hard close 14:00 PT) |

**Blocked on the user, by date:**

| By (PT) | User action |
|---|---|
| **Thu Nov 26** | Request Kiro credits on Devpost and finish ID verification. Install `kiro-cli` and log in. |
| Fri Nov 27 | Generate a Kiro API key for headless runs. Decide in principle whether to buy a paid plan if credits are late or short. Name the outside labeler and adjudicator, or say now that the §9.5 fallback applies. Decide on the plan amendments in risks 1 and 2 below. |
| Sat Nov 28 | Approve creating the public `dnr` repo and pushing it. Create the Cloudflare token or say "GitHub Pages only". Create the npm account and confirm `dnr-guard`. |
| **Mon Dec 1 12:00** | Credits redeemed, or the paid plan bought. After this, nothing that needs Kiro credits can be added. |
| Wed Dec 3 | Push `prereg-v1` before the first trial run and post the hash publicly. Label packets as labeler 1, with labeler 2 if booked. |
| Thu Dec 3 | Record or approve narration, upload the video to YouTube as public, write the dev.to and social posts (bonuses). |
| **Fri Dec 4 10:00** | Fill and submit the Devpost form. Crew bonus repo if it exists. |

The Crew bonus, the Touch the Plan study, the SYN author, the maintainer pilot and repo2 are **not on this path**. Each needs one or more people who are not booked today, and none can be finished by Dec 4 unless booked in the next 48 hours.

---

## Plan risks

Places where building the plan literally gives something that won't work or won't impress. Each has a concrete fix. Ordered by how badly they hurt.

### Risk 1. The plan says "no deadline"; the deadline is in 8 days (fatal)

README:11 and 08 §13.2 say every phase is built in full, nothing is cut, and there is no drop order. The matrix has 447 checks. Many depend on people who aren't booked: an outside labeler and adjudicator (§9.5), a SYN author writing 20 cases (§9.10), at least 6 blind or low-vision study participants under a pre-registered protocol (§9.14), and 3 outside pilot maintainers after an npm release (§9.15). The full trial is about 420 Kiro runs (8 arms × 30 + rdelta ~30 + SYN 40 + repo2 45 + demo 30 + practice 4 + probe ~34). At 10 minutes and concurrency 4, that is about 17 hours of wall clock before anyone labels. Labeling is about 450 packets × 3 min × 2 labelers, roughly 45 labeler-hours. Built literally, the plan produces no submission. The cost is the whole entry.

**Fix:** the user makes one dated amendment (the plan already allows dated amendments in §9.7). It replaces "everything ships" with the critical path above as **must-ship**, plus a stretch order that is started only when the spine is green:
1. guard-shell and Stop (Phase 6);
2. the board and recovery flow (Phase 12, first bullet);
3. `/trial` and `/replay`;
4. MCP and the power;
5. proximity and the fingerprint index;
6. TypeScript;
7. Crew;
8. repo2, SYN, the probe, R+Δ;
9. the Lighthouse, WebKit and LNA gates.

Pre-register the reduced arm set T, L and S at K Django reverts before `prereg-v1`. List U, B, H, T2 and T3 as "not run" rather than cutting them silently.

### Risk 2. Human labels gate every downstream phase (critical-path blocker)

E6 needs two labelers' blind reason labels (P3-11). They feed `trial mine --labels` (P3-12), then `trial assign` (P3-13). That chain decides which reverts are tune or gate. So tuning (P10-01), gate checks 2 and 3, the hard negatives (P5-14), Phase 4's approve-all, the drafts, `prereg-v1` and the whole trial all wait on an outsider who is not booked. In the plan, the §9.5 fallback covers only run packets, not the Phase 3 reason labels.

**Fix:** pre-register now that E6 uses the builder's blind reason label, with the rule-engine proposal shown only after the builder commits. The outside labeler's reason labels then feed κ reporting only and never change eligibility. If no outsider is named by Nov 28, invoke §9.5 for run packets too: the builder, plus an LLM third rater, plus the restored-test subset, disclosed. Assignment can then run on Nov 28 instead of waiting for a person.

### Risk 3. The flagship demo case is mis-described, and the "clean up" prompt will almost certainly not re-apply it (Presentation)

The plan says 43933a1dca is `Query.set_group_by` (06 §9.1 E8; 09 caption example "Clean up `set_group_by`"). In git, the reverted hunk is in `Query.clear_ordering` (`django/db/models/sql/query.py:2341` at `R^`). The change C (ea3a71c2d0) adds one guard clause: `isinstance(self.group_by, tuple) and not {...}.issubset(self.group_by)`. A "Clean up `Query.clear_ordering`" task has essentially no reason to invent that clause. So the §11 rule (demo/T re-applied and tests passed, and demo/L blocked) will very likely find nothing. That drops the video to FB-1, then FB-2 "Scripted for the whole clip". A Kiro PM judge watching "Scripted" at 0:12 marks Presentation down.

**Fix:**
- Resolve all demo qualnames from git (P0-28).
- Add a pre-registered demo-only prompt that matches how this change actually comes back: "Ticket #26434 was reopened; here is its text; fix it." That is the realistic trigger the devil's advocate asked for earlier. It stays outside the trial counts, like LU.
- Film that run as the hero block with an honest caption ("agent given the reopened ticket"), and keep `demo/T` as the split screen.
- Make `scripts/demo/prompts/write.txt` the guaranteed judge path, since it always reaches the hook.

### Risk 4. Whole-order scope makes multi-file orders unblockable from a single-file task (Impact, Tech)

§5.5 scores the whole order: "a single write cannot block on a small slice of a large order". The second demo order, d0e4dd5cdd, reverts 0246f47888. That change touched 6 source files (`contrib/auth/__init__.py`, `hashers.py`, `tokens.py`, `core/signing.py`, `middleware/csrf.py`, `utils/crypto.py`), mostly `constant_time_compare(` → `hmac.compare_digest(`. The T task names one qualname in one file. An agent that faithfully re-does the deprecation in that file scores maybe 1/6 of the order's weight. That never reaches τ = 0.6, so the write only warns, while the labeler marks it CORE. Every multi-file trial revert behaves the same way, which pushes Z/X down and W_L up. The "half of a two-file change" preset will show ALLOW or WARN to judges on the case that looks most like a real refactor.

**Fix:** before tuning, pre-register a per-file sub-order rule. A write blocks when the units of one file form a sub-order with weight ≥ `min_order_weight`, and that file's edit score is ≥ τ with the two-sided rule. The whole-order rule stays for spread-out writes. Add it to P3 and P8, and tune it in the same grid. Or, at minimum, pick the second demo case and the gate reverts from orders whose source changes sit in one file, and report Z/X by `c_file_count`.

### Risk 5. The credits and the clock don't cover the run count, and nobody has measured cost per run (Impact)

About 420 runs against a 4,000-credit grant leaves about 9.5 credits per run. With the 40% margin in §9.2, that is about 6.8 credits for a 10-minute agentic session on "the most capable Claude model". Nothing in the repo has measured this: S11 can't run because `kiro-cli` isn't installed. If credits arrive Dec 1–2, the trial can't start before `prereg-v1`, which sits after Phases 2–10. That puts the whole trial, labeling, scoring and filming inside Dec 2–3.

**Fix:**
- Run S11 on the first day Kiro works and pick the model by measured credits per run, not by capability.
- Cap at T + L + S at r1.
- Start wave 1 (T, record-only hooks) as soon as Phases 2, 3 and 9 and `prereg-v1` pass. T doesn't need the Phase 6 hooks, so it can run while L's hooks are still being finished, as 06 §9.2 wave 1 already allows.
- Decide on the paid plan by Nov 28, not at Phase 10.

### Further risks (shorter)

- **R6 has a hole on macOS.** An agent can run `osascript -e 'tell app "Terminal" to do script "dnr allow dnr-…"'`, `open -a Terminal x.command`, `tmux send-keys`, `launchctl submit`, or `at`. The new process descends from Terminal or launchd and has a TTY, so the ancestry and TTY guard passes. Andersen and Velso will look for exactly this. **Fix:** add a guard-shell rule R8 that denies `osascript`, `open -a`, `tmux send-keys`, `screen -X`, `launchctl`, `at` and `crontab` when the command line mentions `dnr` or the board port. Put them in the 40-command table, and list the residual in `threat-model.md`.
- **Lighthouse performance ≥ 90 on mobile `/play` is unlikely as specified.** The vendored grammars are 3.3 MB (python 0.46 MB, typescript 1.41 MB, tsx 1.45 MB), plus the web-tree-sitter runtime and CodeMirror. **Fix:** load only the case's grammar, lazily after the first interaction. Keep `/` and `/graveyard` free of WASM. Gate Lighthouse on those two routes plus a `/play` budget, or make the `/play` gate perf ≥ 80.
- **The D4 and D1 branches lead to a different project.** "Switch to Touch the Plan" needs a separate build and a completed study with ≥ 6 consented blind or low-vision participants, in days. It can't be executed. **Fix:** amend so D4 behaves as D5 (DNR warn-only with the null wording) and D1 means commit-enforce only. Drop the study dependency from the decision table.
- **Kiro specs must be written in Kiro IDE spec mode** (05 §12.1). Kiro product judges (Re Ferre, Xu, Jayakumar Uma) can tell a spec Kiro generated and executed from hand-written Markdown. **Fix:** the user opens the Kiro IDE on this repo on Nov 27 and generates `dnr-check` there. Execute at least the Phase 2 and Phase 5 tasks from it, and tick them with SHAs (KIRO-01).
- **repo2 on CPython.** It needs `./configure && make` once per revert for 2023–25 revisions on macOS 27, and Docker for Python 3.5–3.7 on arm64 (the daemon isn't running today). **Fix:** pre-register sympy as the second repo, and mine W0–W1 (uv, Python ≥ 3.8) first. Only open W2–W3 if K < 8.
- **Phase 4's acceptance command depends on Phase 3 labels.** `orders build --from fixtures/reverts.json --only 43933a1dca` reads a file that only exists after E6 labeling, and E8 marks the demo revert ineligible. **Fix:** let `orders build --only <sha>` accept a demo revert straight from `pins.json` `demo_cases`, so the order (and everything that needs it) doesn't wait for labelers.

---

## First review pass: early drift (November 26)

What the three teammates have written so far. Most of it is partial: two commits (`895609e`, `9833a7e`) plus uncommitted work in schemas, grammar and git. **Kiro** has written only `.kiro/steering/product.md`. **Mining** has `packages/git/src/*` uncommitted, with no `trial/src/mine`, no `fixtures/known-reverts.json` and no `reports/eligibility.md` yet. That is expected at this stage and isn't a finding. The schemas I checked match §7 field for field. The findings below are things that will fail a row as written, or that diverge from the plan.

| # | Where | Drift | Fails row | Fix |
|---|---|---|---|---|
| D-01 | `packages/schemas/package.json:1-9` | No `scripts.test`, so Phase 2's literal acceptance `pnpm -F @dnr/schemas test` fails with "missing script". `@dnr/grammar` already added one | P2-02 | Add `"scripts": {"test": "vitest run --root ../.. --project unit packages/schemas"}` or similar, in every package |
| D-02 | `vitest.config.ts:6` | The `unit` project only includes `packages/*/src/**/*.test.ts`, but `tsconfig.json:5` and `packages/*/tsconfig.json:5` include `test/`. Any property or unit test placed in `packages/*/test/` (the usual place, and where the fixtures test already lives) is silently never run by `pnpm test` | all PROP-*, REQ-* | Add `packages/*/test/**/*.test.ts` to the unit include, or agree on `src/` co-location now and lint for it |
| D-03 | `packages/schemas/test/fixtures.test.ts:4-6` | The placeholder always passes, so `pnpm test:fixtures` is green with no fixtures (work in progress, but it must fail until `known-reverts.json` exists) | P2-04 | Make it glob `fixtures/*.json` and fail on a missing `known-reverts.json` |
| D-04 | `.gitignore:6-9` | Ignores `.dnr/allow/` (not a plan path) and lists `sessions`, `cache` and `hook.log`, but not `.dnr/grants/`, `.dnr/events.jsonl`, `.dnr/drafts/`, `.dnr/board.json` or `.dnr/candidates.json`. §7 says only `.dnr/orders/` and `.dnr/config.json` are committed. A grant file committed by accident would be honored | CFG-04 | `.dnr/*` then `!.dnr/orders/` and `!.dnr/config.json` (and `dnr init` writes the same lines) |
| D-05 | no `git remote` | The `dnr` repo hasn't been created on GitHub. Phase 0's first step (P0-06) is undone, which blocks CI, Pages, secrets and the URL | P0-06, P0-18 | User approval to `gh repo create dnr --public` and push (critical path #4) |
| D-06 | `package.json:7` and local `node v25.2.1` | Plan pins Node 24 LTS. `engines: ">=24"` accepts 25 and 26, and the machine runs 25, so local results may differ from CI | P0-10 | Add `.nvmrc` / `.node-version` = 24 and `engines: "^24"`; run local acceptance under 24 |
| D-07 | `packages/cli/package.json:1-9` | No `bin`, no tsup `build` script, `private: true`. `dnr --version`, `pnpm link --global` and the labeler setup `pnpm -F cli build` (§9.5) can't run yet (work in progress) | P2-01 | Add `"bin": {"dnr": "dist/cli.js"}`, `"build": "tsup"`, and keep the npm name decision (P0-29) separate from `@dnr/cli` |
| D-08 | `vendor/grammars/PROVENANCE.md:3-5,11-12` | Grammars came from npm tarballs, not GitHub release assets (§4 fallback rule). tree-sitter-typescript is 0.23.2 with ABI 14, where the plan says "latest release on Phase 0 day, verify ABI". It is documented and it loads, so it's acceptable, but confirm 0.23.2 really is the latest release and record that in `pins.json`. The 3.3 MB total is the root of the Lighthouse risk | P0-20, P13-05 | Note in `pins.json.tools`; lazy-load per case |
| D-09 | `packages/schemas/src/config.ts:22` | Config `mode` accepts `record`. §7 says "`record` is trial-only" through `DNR_MODE`, but Phase 5 says "the config `mode` key" for record mode. The plan is ambiguous, and the code picked one side | CFG-01 | Engine and hook owners settle it once and note it in `steering/tech.md`. Allowing it is fine if `dnr init --mode` refuses `record` |
| D-10 | plan `06-trial-protocol.md:40` (E8), `09-video-and-writeup.md` caption example | Plan fact error: 43933a1dca's unit is `Query.clear_ordering` (`django/db/models/sql/query.py:2341` at `R^`), not `Query.set_group_by` | P0-28, VID-06 | Mining resolves from `git show`; never copy the plan's qualname into `pins.json` or prompts |
| D-11 | first commit `895609e` | It also contains `.gitignore`, while the plan says the single first commit holds product.md, LICENSE and NOTICE. Trivial, and acceptable | P0-06 | None needed; noted so nobody rewrites history for it |
| D-12 | `/Users/…/Github/dnr-work/django` | `DJANGO_SRC` sits in a sibling of `$ROOT`. That's fine for `DJANGO_SRC`, but §9.3 forbids `$TRIAL_ROOT` inside or beside `$ROOT`, so don't put `TRIAL_ROOT` in `dnr-work/` | TRIAL-01 | Use `/var/tmp/dnr-trial` as the plan suggests |
| D-13 | `packages/git/src/revert-check.ts:17` | `revertReproduces` runs `git worktree add` (a full Django checkout) for every candidate. Correct, but slow over hundreds of candidates, and it writes `$DJ/.git/worktrees`. Call it only when the patch-ids differ (E3 `exact` first) | P3-02 (runtime) | Gate on `patchId !== inversePatchId` before the worktree path |
