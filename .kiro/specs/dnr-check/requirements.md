# Requirements Document: dnr-check

## Introduction

`dnr-check` covers everything that decides whether a write, a shell command, a turn, a commit or a pull request re-applies a reverted change: the Kiro hooks, the match and scoring rules, the shell guard, the Stop backstop, pre-commit, the local board and the hosted Playground, the MCP server, the drafter and the power. The normative source is the DNR build plan; each requirement cites its section (§N). Requirement IDs R1–R15 and property IDs P1–P17 are the plan's own (§12.1) and must not be renumbered. Requirements derived from other plan sections use the prefix **DC** so they never collide with R-IDs.

The guard-shell rules in §5.10 are also named R1–R7 in the plan. In this spec they are written **GS-R1 … GS-R7** to avoid confusion with requirements R1–R7.

## Glossary

- **Order**: a do-not-resurrect record (`Order`, §7) built from an original commit C and its revert R. Its units carry the added tokens **A** and removed tokens **R** of C.
- **Baseline**: the session snapshot tree, a temp-index `git write-tree` of the working tree at session start (§5.7).
- **Edit score**: `(w(A∩A′) + w(R∩R′)) / (w(A) + w(R))` over weighted multisets (§5.5).
- **τ**: the block threshold (`threshold`, start 0.6). **side_min**: the two-sided minimum (0.3). **min_order_weight**: 8.
- **Tier**: protect → match → warn → allow (§5.4).
- **Grant**: a session-scoped approval for one order (`Grant`, §7), from allow-once or an approved `ask`.
- **decision_format**: `deny` (default) or `ask` (§6).
- **Mode**: `enforce`, `record`, `warn-only` or `commit-enforce` (§5.14, §7).

## Requirements

### Requirement R1: block an approved match (deny format)

**User Story:** As a maintainer, I want an agent's write that re-applies an approved order to be refused before the file changes, so that a reverted bug does not come back.

#### Acceptance Criteria

1. WHEN a write matches an approved order AND `decision_format=deny` THEN the hook SHALL exit 2 with first stderr line `DNR: <reason> <revert URL>`.
2. WHEN the hook blocks THEN stderr SHALL follow the §6 three-line format and SHALL be at most 1,200 characters.
3. WHEN the hook blocks THEN it SHALL print nothing on stdout and SHALL NOT return `updatedInput`.

_Plan: §6, §5.4, §5.5. Properties: P1, P8._

### Requirement R12: ask on a match (ask format)

**User Story:** As a maintainer working interactively, I want to be asked instead of blocked, so that I can approve a fixed re-land in place.

#### Acceptance Criteria

1. WHEN a write matches AND `decision_format=ask` THEN the hook SHALL exit 0, print `{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"<reason>"}}` with the same reason text as R1, and record `pending_ask` `{order_id, file, proposed_sha256, at, expires_at}` keyed by file with a 10-minute expiry.
2. WHEN `dnr init --decision-format ask` runs THEN it SHALL write `decision_format: "ask"` and print that `ask` must not be combined with `--trust-all-tools` (S5).

_Plan: §5.7, §6._

### Requirement R2: warn once on a covered but non-matching write

**User Story:** As a maintainer, I want the agent told once when it edits code covered by an order without matching it, so that it reads the reason before going further.

#### Acceptance Criteria

1. WHEN no order matches AND the write changes a unit covered by an approved or stale order AND the session has not yet warned for that order THEN the hook SHALL emit one `warn_block` in the configured format (exit 2 for `deny`, `ask` JSON for `ask`).
2. WHEN the hook emits `warn_block` THEN it SHALL add the order ID to `Session.warned`.

_Plan: §5.4._

### Requirement R3: pass after the warning

#### Acceptance Criteria

1. WHEN a later non-matching write to the same order arrives in the same session THEN the hook SHALL allow it and log `warn_pass`.

_Plan: §5.4._

### Requirement R4: session baseline

#### Acceptance Criteria

1. The hook SHALL score A′ and R′ against the session baseline tree (`baseline_tree`), never against HEAD.
2. WHEN a session starts THEN DNR SHALL build the baseline with a temp index seeded from the real index (empty seed on an unborn HEAD), including untracked files and respecting `.gitignore`, without modifying the real index.
3. Uncommitted and untracked files present at session start SHALL be part of the baseline and SHALL never be scored as agent edits.

_Plan: §5.7. Property: P7._

### Requirement R5: separate A and R multisets and the two-sided rule

#### Acceptance Criteria

1. The scorer SHALL match A against A′ and R against R′ separately, as weighted multisets counted with repeats.
2. WHEN `w(A) > 0` AND `w(R) > 0` THEN a block SHALL also require `w(A∩A′)/w(A) ≥ side_min` AND `w(R∩R′)/w(R) ≥ side_min`.

_Plan: §5.5. Properties: P4, P5._

### Requirement R6: protected globs

#### Acceptance Criteria

1. WHEN a write targets `.dnr/**`, `.kiro/hooks/**`, `.kiro/settings/**`, `.kiro/agents/**`, `$HOME/.kiro/**`, `realpath($DNR_ORDERS)/**`, `realpath($DNR_STATE_DIR)/**` or `realpath($DNR_CONFIG)` THEN the hook SHALL deny it (`deny_protected`) in every decision format and every mode.

_Plan: §5.4, §6._

### Requirement R7: fail open

#### Acceptance Criteria

1. IF the hook hits an internal error or timeout THEN it SHALL allow the write (exit 0) and append the error to `$DNR_STATE_DIR/hook.log`, logged as `error_open`.
2. WHILE in Stop mode the process SHALL always exit 0, through a top-level handler that catches every error.

_Plan: §5.11, §5.12._

### Requirement R8: latency

#### Acceptance Criteria

1. The p95 latency of `dnr check --stdin --hook kiro` on the demo file SHALL be under 300 ms for a match and under 80 ms on the fast path (hyperfine, 30 runs, `scripts/p95.mjs`).
2. The first write of a fresh Django session, which builds the baseline, SHALL take under 2 s, including with the fingerprint index on and a cold cache (Phase 10).

_Plan: §13.1 Phase 5, §5.16._

### Requirement R9: session grants

#### Acceptance Criteria

1. WHILE a grant for an order is unexpired, or has already been used in this session, a match on that order SHALL be allowed and logged `allow_grant`, and the order's warn tier SHALL be off for the session (`allow_grant`, `tier: 'warn'`).
2. WHEN a grant is used THEN DNR SHALL log the use, add the order to `Session.grants_used`, append a `used` entry, and record the sha256 of each file the write produced in `Grant.blobs`.
3. A grant SHALL never apply to another order.

_Plan: §5.4, §5.7. Property: P10._

### Requirement R10: stale orders only warn

#### Acceptance Criteria

1. WHEN an order is stale (more than half of the snapshot tokens differ at HEAD, or a `modified`/`removed` unit is missing and cannot be relocated) THEN it SHALL reach only the warn tier.
2. `stale` SHALL be computed at load time and never written back. Re-landed (match(HEAD), or match(`X^`) in the scan) SHALL also be derived, never stored, and SHALL only warn until re-approved.

_Plan: §5.9._

### Requirement R11: missing units

#### Acceptance Criteria

1. WHEN a covered unit is missing from the proposal THEN the hook SHALL first look it up in the fingerprint index (§5.16).
2. IF nothing matches at or above `fingerprint_floor` THEN the unit SHALL fall to the warn tier, UNLESS `kind=removed` or `kind=added`, which SHALL score normally with a proposed unit of `[]`.
3. WHEN the tool is `delete_file` THEN the proposed file SHALL be empty, re-applying `kind=removed` units, and every other unit SHALL fall to warn.

_Plan: §5.5, §5.8, §5.16. Property: P16._

### Requirement R13: an approved ask becomes a grant

#### Acceptance Criteria

1. WHEN an `ask`-approved write lands (PostToolUse `dnr session confirm` sees the file equal `proposed_sha256`) THEN DNR SHALL create a session grant `{order_id, kind: 'ask', expires_at: now + 1h}`, add the order to `grants_used`, record a `used` entry of kind `write`, and log `ask_approved`.
2. WHEN no matching PostToolUse arrives before the pending record expires THEN DNR SHALL log `ask_denied`.
3. Neither the Stop backstop nor pre-commit SHALL block that re-land.

_Plan: §5.7. Property: P13._

### Requirement R14: Crew pull-request check

#### Acceptance Criteria

1. WHEN a Crew pull request contains a crossing re-application THEN the `dnr` status check SHALL fail and the bot SHALL comment with the order, its reason, the original commit, revert and ticket links, and the order file at the base SHA on GitHub (rendered by the hosted `/orders/view?src=` route for non-demo orders).
2. The check SHALL load orders only from the base ref's `.dnr/orders/`, SHALL be posted only through the `dnr-bot` App's Checks API, and SHALL be required under `enforce` and `commit-enforce` and advisory under `warn-only`.

_Plan: §12.5. Implemented in the separate `dnr-crew` repo (`dnr-crew/.kiro/specs/crew-check/`); this repo provides `dnr check --commit` and `dnr init --crew`._

### Requirement R15: Crew override

#### Acceptance Criteria

1. WHEN a maintainer with `admin` or `write` permission comments `/dnr allow <order_id>` THEN the bot SHALL record a blob-matched, HMAC-signed grant, re-run the check, and append the override to the audit trail.
2. IF the comment's author is the bot, or `performed_via_github_app` is non-null THEN the bot SHALL ignore it (S16 freezes whether an approving review is required instead).

_Plan: §12.5._

## Derived requirements

### Requirement DC1: tier order

1. The hook SHALL evaluate tiers in the order protect → match → warn → allow, and SHALL log exactly one `EventRecord` per write. _§5.4; gate check 1d._

### Requirement DC2: tokens and weights

1. The tokenizer SHALL use web-tree-sitter leaves, drop comments and zero-width tokens, keep each string literal as one token and keep identifiers as written, with `NORMALIZER_VERSION=1` per grammar.
2. The Python weight-0 set SHALL be `. , : ; ( ) [ ] { } = -> := @ \`; every other token SHALL have weight 1, including meaning-changing operators such as `**`, `??`, `?.`, `...`, `||`, `*`.
3. WHEN more than 20% of a unit's span sits under `ERROR` nodes THEN the unit SHALL be marked `parse-degraded` and SHALL reach only the warn tier. _§5.1._

### Requirement DC3: qualnames

1. Scorable units SHALL be module functions, methods at any depth (`Outer.Inner.m`), `Cls.<body>` and `<module>`; decorators belong to their unit; closures belong to their enclosing unit; repeated names get `#2`, `#3`; `qualnames(text, lineRanges)` SHALL map each changed line to the smallest containing unit. _§5.2._

### Requirement DC4: order building

1. `dnr orders build` SHALL produce, per touched source unit, `kind`, A, R, `post_revert_hash`, the token count and `c_state_ref`, skip formatting-only units (`skip_reason: no-unit-change`), and name the order `dnr-` + the first 10 hex characters of `revert_sha` (`original_sha` for manual orders).
2. Re-running build on an existing ID SHALL keep `status`, `reason`, `reason_source` and `history`, and SHALL be byte-identical on rerun. _§5.3, §8._

### Requirement DC5: whole-order scope and small orders

1. The proposed state SHALL be the session's current state of every file the order touches with this write applied, compared with `baseline_tree`.
2. IF the order's `w(A)+w(R) < min_order_weight` THEN it SHALL never reach the match tier (it may warn). _§5.5. Property: P3._

### Requirement DC6: crossing rule at commit time

1. `dnr check --staged` and `--commit <sha>` SHALL score against the order's `snapshot_sha` and SHALL block only on a crossing: match(new) holds and match(parent) does not (parent = HEAD for `--staged`, `X^` for `--commit`).
2. Pre-commit SHALL allow a crossing commit when every staged blob of the order's files equals a blob in a used grant from any session, logging a `used` entry of kind `commit`.
3. `dnr init` SHALL install the pre-commit hook `exec dnr check --staged` only if none exists. _§5.5, §5.7, §6. Properties: P10, P15._

### Requirement DC7: proximity (secondary, off by default)

1. Proximity SHALL be built as defined in §5.6 (weight-1 3-shingles, weighted Jaccard, normalized, clamped, baseline-relative, max over pairing candidates, size-weighted aggregation, null when all units are `kind=removed`).
2. WHERE `prox_enabled` is true, `prox ≥ prox_threshold` SHALL block without the two-sided rule, subject to the small-order rule, and `fired_by` SHALL record the signal.
3. `prox_enabled` SHALL be set only by the single enabling rule in §5.6, recorded in `reports/gate.md`. _§5.6. Properties: P14, P17._

### Requirement DC8: session key and lifetime

1. The session key SHALL be `sha256(session_id)`; IF there is no `session_id` THEN the fallback key SHALL be `realpath(cwd)`, cleared only by SessionEnd or a 30-minute idle timeout.
2. Any DNR hook event (SessionStart, PreToolUse write or shell, PostToolUse, Stop) SHALL start a session if none exists. _§5.7._

### Requirement DC9: tool adapters

1. `fs_write` SHALL propose its content (a legacy `command` dispatch is accepted); `str_replace` SHALL propose the text with its single match replaced, and allow zero or several matches; `fs_append` SHALL propose current text plus content; `delete_file` SHALL propose empty text; an unknown write-tagged tool with a path SHALL go to the warn tier. Field names come from S2. _§5.8._

### Requirement DC10: guard-shell

1. `dnr guard-shell --stdin` SHALL parse the command with shell-quote, split on `; && || | $( )` and backticks, and deny when any of GS-R1 … GS-R7 (§5.10) matches.
2. Every GS-R6 subcommand (`allow`, `board`, `init`, `orders build` into the live directory, `orders approve|retire|unretire|edit|reapprove`, `draft`, `session end|gc`) SHALL refuse without a TTY, when any ancestor process is `kiro-cli` or the Kiro agent host, or when a Kiro-specific variable frozen by S8 is set.
3. guard-shell SHALL take a temp-index tree snapshot at PreToolUse (`shell_snapshot`), and `dnr session shell-after` SHALL add every file that changed across the call to `Session.touched`. _§5.10, §5.11._

### Requirement DC11: Stop backstop

1. `dnr check --worktree --hook stop` SHALL score only `Session.touched`, skip orders with an applying grant, and on a match print `{"decision":"block","reason":"DNR: your edits re-apply <id> (<reason>, <url>). Revert only the edits you made to <qualnames> this session, then tell the user."}`.
2. It SHALL force at most `--max-forced-turns` (2) turns per session, and SHALL force a turn that reports any change to the order-set hash (`.dnr/orders/`, `.dnr/config.json`, DNR hook files) not made through a GS-R6-passing `dnr` command. _§5.11._

### Requirement DC12: reduced modes

1. WHILE `DNR_MODE` (or config `mode`) is `warn-only`, a match SHALL be downgraded to the warn tier, Stop SHALL force at most one turn with the warn-only text, and pre-commit SHALL print and exit 0.
2. WHILE `commit-enforce`, pre-write SHALL record and warn, Stop SHALL force at most one turn, and `dnr check --staged` SHALL exit 1 on a crossing.
3. WHILE `record`, every event SHALL carry `proposed_text` and `session_patch`; in every mode, block, `warn_block` and `ask` events SHALL carry them. Each mode SHALL write a Zod-valid `EventRecord`. _§5.14, §7._

### Requirement DC13: TypeScript and JavaScript

1. The same algorithm SHALL run on `.ts/.mts/.cts` (typescript grammar, excluding `*.d.ts`) and `.tsx/.js/.jsx/.mjs/.cjs` (tsx grammar), with the §5.15 weight-0 set, template-literal rule and qualname rules, and the grammar recorded per unit. _§5.15._

### Requirement DC14: fingerprint index

1. At write time the lookup SHALL search only `Session.touched` and files new relative to the baseline, take the best candidate with Jaccard ≥ `fingerprint_floor` against either fingerprint (`C_u`, `PR_u`), and score it against the baseline unit at its original location.
2. `dnr orders relocate` SHALL write only `cache/fingerprints.json` and never change order files. _§5.16._

### Requirement DC15: configuration and state

1. Config lookup SHALL be `DNR_CONFIG`, then `<repo>/.dnr/config.json`, then the §7 defaults; `DNR_MODE` and `DNR_THRESHOLD` SHALL override.
2. `DNR_STATE_DIR` SHALL default to `<repo>/.dnr`; only `.dnr/orders/` and `.dnr/config.json` are committed, and `dnr init` SHALL add the gitignore lines for the rest. _§7, §8._

### Requirement DC16: CLI contract

1. Every command SHALL use the §8 exit codes and environment variables, and SHALL validate its inputs with the §7 Zod schemas (65 on invalid data).
2. `dnr init` SHALL be idempotent, SHALL refuse to run from an npx cache path, and SHALL write absolute `dnr` paths into hooks IF S8 shows hooks do not inherit PATH. `dnr init`, `dnr scan` and `dnr orders build` SHALL each print the single next command. _§8, §10._

### Requirement DC17: local board

1. The board SHALL serve the shared UI on 127.0.0.1 with the §10 routes, a single-use 60-second launch nonce that is never printed, a per-launch `dnr-<rand>.localhost` host (fallback `127.0.0.1` with `--host`), an `HttpOnly; SameSite=Strict; Path=/api` cookie, and SHALL answer 401 without the cookie, 403 on a missing or foreign `Origin` or missing `X-DNR-CSRF: 1`, 421 on a bad `Host`, and 409 on an invalid transition.
2. `dnr board --open <id>` SHALL launch and open that order with the cookie set, and SHALL refuse under the GS-R6 ancestry and Kiro-variable checks. _§10._

### Requirement DC18: hosted Playground

1. The Playground SHALL be a static build of the shared UI with the localStorage adapter and bundled `CaseBundle` data, running `@dnr/core` in the browser, with no backend, secrets or login, and the §10 routes.
2. Every preset SHALL produce the same decision in the browser as `dnr check --file` on Chromium, Firefox and WebKit (P9).
3. The UI SHALL meet WCAG 2.2 AA with 0 axe violations, full keyboard access, `aria-live` decisions, color never the only signal and reduced-motion support. _§10._

### Requirement DC19: MCP server

1. `dnr mcp` SHALL expose only `explain_function({file, qualname})` and `list_orders_for_file({file})`, both read-only, and SHALL never return A or R tokens. _§12.4._

### Requirement DC20: drafter

1. `dnr draft` SHALL run the `dnr-drafter` agent (no tools, pinned model), wrap revert and ticket text in `<revert>` and `<ticket>` as untrusted data, accept only `{"order_id":"dnr-…","reason":"<one sentence, ≤200 chars, no URLs or code>"}` validated by Zod, retry twice, and cache drafts.
2. WHEN the prompt-injection fixture is drafted THEN the output SHALL still be a plain sentence. _§12.3, §8._

### Requirement DC21: steering generation

1. `dnr steering generate` SHALL write advisory steering from the given orders (default: approved orders, `.kiro/steering/dnr-history.md`). _§12.2, §8._

## Correctness properties (fast-check)

| ID  | Property                                                                                                                                                                                           | Tested in     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| P1  | An exact re-application has edit score 1.0. It is blocked when the order meets `min_order_weight` and is not stale or degraded.                                                                    | Phase 4       |
| P2  | A write that touches none of the order's tokens does not match.                                                                                                                                    | Phase 4       |
| P3  | A re-application split into k writes, in any order, is blocked no later than the first write where the block condition holds (score ≥ τ and the two-sided rule), for orders that can match at all. | Phase 5       |
| P4  | A token present in both A and R cannot cancel itself.                                                                                                                                              | Phase 4       |
| P5  | Scores lie in [0,1] and do not change with whitespace or comments.                                                                                                                                 | Phase 4       |
| P7  | An unchanged post-revert file scores 0.                                                                                                                                                            | Phase 4       |
| P8  | A removal-only re-application is blocked, for orders that meet `min_order_weight`.                                                                                                                 | Phase 4       |
| P9  | Browser and node builds produce identical decisions (Playwright on Chromium, Firefox, WebKit).                                                                                                     | Phase 7       |
| P10 | A grant applies only to its own order, and only while unexpired or already used in that session (Phase 5). Pre-commit allows it only for blobs that match the grant (Phase 6).                     | Phases 5, 6   |
| P11 | Recall on the held-out families (extract-helper, invert-condition) is measured; gate check 2 requires ≥ 70%. A gate metric, not a universal property.                                              | Phase 10      |
| P12 | After a re-land is committed, a later unrelated edit is allowed.                                                                                                                                   | Phase 6       |
| P13 | An `ask`-approved re-land is honored at Stop and at pre-commit.                                                                                                                                    | Phase 6       |
| P14 | `prox_u` equals 1 for an exact replay of both `kind=modified` and `kind=added` units, at any size of C.                                                                                            | Phase 10      |
| P15 | A re-application split across two committed sessions is blocked at `--staged` on the crossing commit, including A-heavy orders whose first commit lands only the A side.                           | Phase 6       |
| P16 | A unit moved or renamed into another file (`move-to-file` held-out seeds 3100–3104) is still matched through the fingerprint index, for Python and TypeScript, including move plus re-apply.       | Phases 10, 12 |
| P17 | `prox_u` is never negative; a rewrite that shares no 3-shingles with C_u or PR_u has `prox_u = 0` for any baseline.                                                                                | Phase 10      |

P6 was dropped when jsdiff replaced the custom Myers diff. P1–P5 also run on TypeScript fixtures in Phase 12. The first property that fails, its fix commit and the re-run are recorded in `reports/property-failures.md` (or that none failed).
