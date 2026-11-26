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
| Shell writes | guard-shell rules R1–R7 (protected paths, `git revert`/`cherry-pick`/`apply`/`checkout --source` of order commits, `dnr` subcommands, board port); post-shell records changed files; the Stop backstop forces an undo turn | §5.10, §5.11 |
| Editing orders or hooks | protected globs in every format; an order-set hash checked at Stop | §5.4, §5.11 |
| Self-approval | every enforcement-changing `dnr` subcommand refuses without a TTY, under a `kiro-cli` or Kiro agent-host ancestor, or with Kiro-only environment variables (frozen by spike S8); the block text is addressed to the human; the trial flags grants created during a run | §5.10 |
| Board CSRF and DNS rebinding | single-use 60 s launch nonce never printed; per-launch `dnr-<rand>.localhost` host; `Host` check (421); `HttpOnly; SameSite=Strict` cookie on every `/api/*` route; exact `Origin` and `X-DNR-CSRF: 1` on mutations (403) | §10 |
| Prompt injection into the drafter | `<revert>` and `<ticket>` tags marked untrusted, no tools, Zod-validated one-sentence output, human approval of every reason | §12.3 |
| `ask` auto-approved | `deny` is the default; `ask` is opt-in and never combined with `--trust-all-tools` (spike S5) | §6 |
| Fake Crew check or override | checks posted only by the `dnr-bot` App and required by `app_id`; the scan job is named `dnr-scan`; App and HMAC secrets are environment secrets of the protected-branch-only `dnr-grants` environment; overrides need write access and ignore App-posted comments; PRs touching `.dnr/**` or `.github/**` fail | §12.5 |
| Undoing an approved re-land | grant use is recorded with blob hashes and honored at Stop and pre-commit (P13) | §5.7 |
| Wiping a human's edits | the baseline includes the human's uncommitted and untracked files; Stop scores only files the agent touched and never suggests a checkout | §5.7, §5.11 |

## Known limits

- A rename or move that the fingerprint index cannot match, below its similarity floor, falls to the warn tier.
- guard-shell is partial. The Stop backstop narrows the shell route but does not close it.
- A human's mid-session edits to a file the agent also touched are scored together with the agent's.
- Trial agents run as the same OS user as the harness; isolation is by path, a per-run HOME and `chmod` lockdown, not by OS account.
- Processes outside Kiro can edit anything.
- Fail-open lets writes through when DNR itself breaks (by design: a DNR bug never stops an agent).
- Under `--trust-all-tools`, an `ask` may be auto-approved (spike S5).
- A non-browser process running as the same user can read the board's cookie jar.
- On the `127.0.0.1` board fallback (Safari, `--host 127.0.0.1`), the cookie is shared with other loopback ports.
- Kiro's matcher `write` is also an unanchored regex, so a tool whose ID merely contains "write" reaches the hook; DNR treats an unknown tool with no path as allow.
