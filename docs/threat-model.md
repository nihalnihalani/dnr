# Threat model and known limits

DNR stops an AI agent from re-applying a change the repository already reverted. It is a guard rail for a cooperative but forgetful agent, not a sandbox against a hostile process. This page lists what it defends, how, and what it does not cover (plan §5.13, §10, §14).

## Assets

- **The order set**: `.dnr/orders/`, `.dnr/config.json` and the DNR hook files. Whoever controls them controls enforcement.
- **Grants**: allow-once and `ask` approvals in `$DNR_STATE_DIR/grants/`, and Crew override grants signed with `DNR_GRANT_HMAC_KEY`.
- **The approval path**: the local board and `dnr allow`, which only a human may use.
- **The trial's integrity**: sealed events, labels and the pre-registered inputs.

## Adversaries considered

| Adversary | Example |
|---|---|
| The agent routing around a block | rewording, splitting a change across writes or sessions, writing through the shell, moving code to another file |
| The agent approving its own re-land | running `dnr allow`, `dnr board`, `dnr orders approve`, editing order or hook files, calling the board API |
| Untrusted text reaching a model | revert messages and tickets read by the drafter |
| A web page in the user's browser | CSRF or DNS rebinding against the local board |
| A Crew PR or another GitHub App | posting a fake `dnr` check, forging an override, editing workflows |

## Defenses

| Threat | Defense | Plan |
|---|---|---|
| Rewording, reformatting | per-unit token multisets with zero-weight punctuation; comments and whitespace ignored (P5) | §5.1, §5.5 |
| Splitting across writes | whole-order scope against the session baseline (P3) | §5.5 |
| Splitting across sessions | the crossing rule at pre-commit and in Crew (P15) | §5.5 |
| Paraphrase | proximity, enabled only by the pre-registered rule | §5.6 |
| Moving code to another file | the fingerprint index (P16) | §5.16 |
| Shell writes | guard-shell rules R1–R8 (protected paths, `git revert`/`cherry-pick`/`apply`/`checkout --source` of order commits, `dnr` subcommands, board port); post-shell records changed files; the Stop backstop forces an undo turn | §5.10, §5.11 |
| Editing orders or hooks | protected globs in every format; an order-set hash checked at Stop | §5.4, §5.11 |
| Skipping or removing the pre-commit hook | the protect tier denies writes under the git hooks directory (`.git/hooks/**`, with the gitdir resolved for worktrees, and the `core.hooksPath` target read from `.git/config`), so a write tool cannot edit or delete the pre-commit shim; guard-shell R1 covers the same paths. Guard-shell rule R8 denies `git commit --no-verify` and `-n` (including clusters such as `-nm`), `--no-verify` on merge, am and rebase, `git config core.hooksPath <value>` and `--unset` (reads are allowed), and `git -c core.hooksPath=…` | §5.4, §5.10 (R8 extends the plan, review M3) |
| Self-approval through a human's terminal | guard-shell R8 also denies `osascript`, `open -a Terminal`/`iTerm`/…, `tmux send-keys` and `screen … stuff`, which could type an approval command into a human terminal | §5.10 (R8) |
| Self-approval | every enforcement-changing `dnr` subcommand refuses without a TTY, under a `kiro-cli` or Kiro agent-host ancestor, or with Kiro-only environment variables (frozen by spike S8); the block text is addressed to the human; DNR flags as suspect any grant or approval created while an agent session is active (wording pending from the hook owner); the trial flags grants created during a run. This is a speed bump against a careless agent, **not a boundary** against a hostile process running as the same user: the wave-2 review defeated the ancestry check with a double fork plus a new pty from one shell command (review C3) | §5.10 |
| Board CSRF and DNS rebinding | single-use 60 s launch nonce never printed and no longer passed in the browser launcher's argv, where `ps` could read it (review H4; fix in progress); per-launch `dnr-<rand>.localhost` host; `Host` check (421); `HttpOnly; SameSite=Strict` cookie on every `/api/*` route; exact `Origin` and `X-DNR-CSRF: 1` on mutations (403) | §10 |
| Prompt injection into the drafter | `<revert>` and `<ticket>` tags marked untrusted, no tools, Zod-validated one-sentence output, human approval of every reason | §12.3 |
| `ask` auto-approved | `deny` is the default; `ask` is opt-in and never combined with `--trust-all-tools` (spike S5) | §6 |
| Fake Crew check or override | checks posted only by the `dnr-bot` App and required by `app_id`; the scan job is named `dnr-scan`; App and HMAC secrets are environment secrets of the protected-branch-only `dnr-grants` environment; overrides need write access and ignore App-posted comments; PRs touching `.dnr/**` or `.github/**` fail | §12.5 |
| Undoing an approved re-land | grant use is recorded with blob hashes and honored at Stop and pre-commit (P13) | §5.7 |
| Wiping a human's edits | the baseline includes the human's uncommitted and untracked files; Stop scores only files the agent touched and never suggests a checkout | §5.7, §5.11 |

## Review findings being fixed

From the wave-2 devil's advocate review (`docs/review-wave2.md`). Each fix lands with a regression test that reproduces the attack.

| Finding | Status | Regression test |
|---|---|---|
| C1: fail-open on invalid or tampered DNR state (one bad config value or a garbled session file) switched off pre-write, Stop and pre-commit | fix in progress. R7 is amended: errors and timeouts still allow, but invalid or tampered config, sessions, orders and hooks fall back to safe defaults or the committed state and are reported | an injected invalid config and a garbled session file still block the `43933a1dca` re-application (replaces the old "R7: an invalid config allows the write" test) |
| C2: on a case-insensitive file system (macOS APFS), a write to a case-variant path (`Django/db/…`) re-applied the change with no block and no Stop | fix in progress: paths are case-folded before order files and `touched` are compared | the case-variant write is blocked at pre-write and caught at Stop |
| C3: the human-only guard can be escaped from one shell command | documented as a limit (Self-approval row above); suspect flagging in progress | a grant created during an active agent session is flagged suspect |
| H4: the board launch nonce was visible in `open`'s argv | fix in progress | the launcher's argv carries no nonce |

## Known limits

- Order files (`.dnr/orders/*.json`) are committed and readable, so an agent can read every order's A and R tokens and tune a paraphrase to land under τ. The MCP tools' hiding of A and R does not protect them. The mitigations are proximity (§5.6) and measured held-out recall (gate check 2), not secrecy.
- A rename or move that the fingerprint index cannot match, below its similarity floor, falls to the warn tier.
- guard-shell is partial: it is a parser, not a sandbox. The Stop backstop narrows the shell route but does not close it.
- An agent can still skip the pre-commit hook through paths guard-shell does not parse: environment tricks for other hook managers (`HUSKY=0`-style), a script file that runs `git commit --no-verify`, `python -c "subprocess…"`, or setting `core.hooksPath` with an editor tool in a git config outside `.git/config` (for example `~/.gitconfig`, which is outside the protected globs).
- Under `commit-enforce`, pre-commit is the only local enforcement. The server-side Crew check is the backstop.
- The Kiro-variable list used by the R6 self-approval check is provisional until spike S8 (`packages/hook/src/ancestry.ts`, `KIRO_AGENT_VARS`). The check also refuses any wrapper between `dnr` and the nearest interactive shell, so `npx <package> allow` is refused too; humans need a global install.
- A human's mid-session edits to a file the agent also touched are scored together with the agent's.
- Trial agents run as the same OS user as the harness; isolation is by path, a per-run HOME and `chmod` lockdown, not by OS account.
- Processes outside Kiro can edit anything.
- Fail-open lets writes through when DNR itself hits an internal error or timeout (by design: a DNR bug never stops an agent). Invalid or tampered DNR state does not fail open (R7 as amended; review C1, fix in progress).
- Under `--trust-all-tools`, an `ask` may be auto-approved (spike S5).
- A non-browser process running as the same user can read the board's cookie jar.
- On the `127.0.0.1` board fallback (Safari, `--host 127.0.0.1`), the cookie is shared with other loopback ports.
- MCP tools that write files bypass pre-write: Kiro's `write` category covers only built-in file write tools, and Stop's `touched` set does not include MCP writes. A follow-up `@mcp` PreToolUse hook that sends path-bearing calls to the warn tier is an open option (`hook-contracts.md`).
- A `PermissionRequest` hook from another source can auto-answer prompts. It cannot override a PreToolUse exit 2 or `deny`, so `deny` format is unaffected. In `ask` format, another hook could approve DNR's prompt (spikes S5 and S15).
- Kiro's matcher `write` is also an unanchored regex, so a tool whose ID merely contains "write" reaches the hook; DNR treats an unknown tool with no path as allow.
