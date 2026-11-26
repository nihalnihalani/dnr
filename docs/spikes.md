# Spikes S1–S16

Phase 1 of the build plan (§13.1). Each spike answers one question about Kiro's runtime before any DNR code depends on it. Captured stdin goes in `fixtures/hook-events/`, Crew captures in `fixtures/crew/`. When every spike has a recorded answer, `.kiro/steering/hook-contracts.md` is frozen from this file.

Common setup unless a spike says otherwise: `kiro-cli` 3.4 or later (version recorded with each result), the pinned model from `fixtures/pins.json`, the demo checkout `../django-demo` from `scripts/demo/make-demo-checkout.sh`, and a capture hook whose command is `cat >> <capture file>; exit 0` (or `exit 2` where a spike needs a block).

| Spike | Question | Method | Result |
|---|---|---|---|
| S1 | Does an always-block PreToolUse `write` hook fire headless under `--trust-all-tools`? Under both registrations? Does `--sandbox` isolate better? | (a) `.kiro/hooks/` file with matcher `write` and a command that exits 2; (b) the same hook inline in `.kiro/agents/dnr-gate-1b.json` with `--agent dnr-gate-1b`. Ask headless for a one-line edit with `kiro-cli chat --v3 --no-interactive --trust-all-tools`. Pass: the file is unchanged, the transcript shows the stderr. Repeat (a) with `--sandbox`. Failure of both is **provisional D1**; gate check 1b confirms. | pending (needs kiro-cli) |
| S2 | Exact `tool_input` fields for `fs_write` (create and overwrite), `fs_append`, `str_replace`, `delete_file`. | Capture hook on PreToolUse `write`; prompt one call of each tool. Save each stdin as `fixtures/hook-events/s2-<tool>.json`. | pending (needs kiro-cli) |
| S3 | Is `session_id` stable across turns? | Capture hook on PreToolUse and Stop; three turns in one interactive session, then one headless run with two turns. Compare `session_id` values. | pending (needs kiro-cli) |
| S4 | Do SessionStart, SessionEnd and Stop fire headless? Does Stop force a turn on exit 1, and on `{"decision":"block","reason":…}`? | Capture hooks on all three triggers in a headless run. Then a Stop hook that exits 1 once (marker file), and one that prints the JSON once; count turns in the stream-json transcript. | pending (needs kiro-cli) |
| S5 | What do `deny`, `ask` and `allow` do? Is `ask` auto-approved under `--trust-all-tools`? What does it do under `--no-interactive`? | PreToolUse hook printing each `permissionDecision` in turn: interactive, headless, and headless with `--trust-all-tools`. Record whether the write lands. | pending (needs kiro-cli) |
| S6 | (Merged into S1.) | — | merged |
| S7 | What happens on a hook timeout? | PreToolUse hook `sleep 20` with `"timeout": 2`. Record whether the write proceeds and what the agent sees. | pending (needs kiro-cli) |
| S8 | Which credential file does a headless run use? Do hooks inherit PATH and the environment? Which files does Kiro write under `$HOME/.kiro`? Which variables exist only in agent contexts? | `HOME=$(mktemp -d) KIRO_API_KEY=… kiro-cli chat --v3 --no-interactive "say hi"`, then list new files under HOME. Hook command `env > <file>` and a shell-tool `env`; diff against `env` from Terminal.app and from the Kiro IDE integrated terminal. Hash `$HOME/.kiro` before and after a run with no DNR files to get Kiro's own writes (the hash-exclusion globs). | pending (needs kiro-cli) |
| S9 | Which power format loads (Agent Plugins `plugin.json` or legacy `POWER.md`), and can a power bundle hooks and steering? Is the `$schema` URL right, and are `license` and `repository` accepted? | Install `powers/dnr/` locally in the CLI and the IDE; check that the MCP tools appear. Add a test `hooks/` and `steering/` directory and check whether they load. | pending (needs kiro-cli) |
| S10 | What key shape do agent-config hooks use? Are duplicates (same hook in a file and an agent config) deduplicated? Does `--agent <name>` resolve from `$HOME/.kiro/agents/`? Does a custom agent load workspace steering without a `resources` entry? | Run `dnr-gate-1b` from `.kiro/agents/` and from `$HOME/.kiro/agents/`; register the same capture hook both ways and count invocations. Put a marker steering file in the workspace and ask a custom agent without `resources` to quote it. | pending (needs kiro-cli) |
| S11 | Cost and behavior of one T run with no hook. | On `../django-demo`: `kiro-cli chat --v3 --no-interactive --trust-all-tools --model <pin> "Clean up Query.clear_ordering in django/db/models/sql/query.py."`, then `PYTHONPATH="$PWD" <env>/bin/python tests/runtests.py aggregation_regress`. **Record the credits used per run.** | pending (needs kiro-cli) |
| S12 | What is the shell tool's command field? | Capture hook on PreToolUse `shell`; prompt one shell command. Save as `fixtures/hook-events/s12-shell.json`. | pending (needs kiro-cli) |
| S13 | What does the agent see when hook output is over 3,000 characters? | PreToolUse hook that exits 2 with 4,000 characters of stderr; ask the agent to repeat the last line it saw. | pending (needs kiro-cli) |
| S14 | Do hooks run on Kiro Web and in the IDE? Is the file-trigger matcher a regex? | Open this repo in the IDE: trigger `dnr-pre-write` and the `dev-core-tests-on-save` dev hook by an agent edit under `packages/core/`. Repeat PreToolUse on a Web session. Test the matcher with a path that only a regex would match. | pending (needs kiro-cli) |
| S15 | PostToolUse stdin for each write tool, including after an approved `ask` in an interactive session. Are `session_id` and the path present? | Capture hook on PostToolUse `write`; one call per tool; then an `ask` decision approved by hand. Save as `fixtures/hook-events/s15-<tool>.json`. | pending (needs kiro-cli) |
| S16 | Kiro Crew: how a Crew session's changes are exposed (PR, branch or event), what a bot can read and post, which identity authors PRs and comments (`performed_via_github_app`), and what the Best Kiro Crew App bonus needs. | One Crew session on `<you>/django-demo-crew` that opens a PR and comments. Capture the PR, commits, comments and check-run payloads with `gh api` into `fixtures/crew/`. | pending (needs kiro-cli and Crew access) |
| S17 | Kiro permission policy as a Kiro-enforced backstop. Documented (kiro.dev/docs/permissions and docs/reference/built-in-tools, read 2026-11-26): `permissions.yaml` rules `{capability: fs_write, match: [globs], effect: deny}` at user scope `~/.kiro/settings/permissions.yaml` or workspace scope `~/.kiro/workspace-roots/<hash>/permissions.yaml`; deny overrides presets and `--trust-all-tools`; agents are hard-denied writes to those files; agent configs also accept `toolsSettings.write.deniedPaths`. To verify: whether `match` globs are workspace-relative, the `<hash>` algorithm, the minimum CLI version on the pinned build, and that a denied `fs_write` to `.dnr/**` is refused headless with `--trust-all-tools`. | In a live session with `dnr init`'s rules installed: ask the agent to write `.dnr/orders/x.json`, `.git/HEAD` and the bundle path; capture the refusals into `fixtures/hook-events/`. Also ask it to run `git commit --no-verify` and `git -c core.hooksPath=/tmp …`, and record the capability name the shell tool reports (`shell` or `execute_bash`) and how relative and `**/` globs resolve. | pending (needs kiro-cli) |

**Model pin.** The agent configs (`.kiro/agents/*.json`, `trial/agents/*.json`) have no `model` field yet, so Kiro uses its default model. Phase 0 picks the model (`kiro-cli chat --list-models --format json`) and records it in `fixtures/pins.json`. Then the concrete ID is committed to every agent config before S11, and `dnr trial prepare` checks it when seeding each run HOME.

## Findings that changed a decision

(One entry per finding: spike, what was found, the decision or file it changed, commit SHA.)

## Phase 0 records

| Item | Value |
|---|---|
| Kiro CLI | 3.6.2, installed 2026-11-27 at `~/.local/bin/kiro-cli` with the official installer (`curl -fsSL https://cli.kiro.dev/install`, checksum-verified, `--no-modify-path`). Not logged in yet: pending (user) `kiro-cli login` |
| Kiro credits request time | pending (user): request Kiro credits on Devpost and record the time (Phase 0) |
| Outside labeler (labeler 2), hours booked | pending (user): book an outside labeler by name and hours (Phase 0, §9.5) |
| Adjudicator | pending (user): name the adjudicator (Phase 0, §9.5) |
| SYN author | pending (user): name the SYN author, not the builder (Phase 0, §9.10) |
| Pilot maintainers (three or more, one Python, one TypeScript) | pending (user): recruit three or more maintainers (Phase 0, §9.15) |
| `study-prereg` tag commit time | pending (user): push the `study-prereg` tag before the first study session (Phase 0, §9.14) |
| Bonus eligibility (Crew, Blog, Social Blitz, Startup, Student, Ghost) | pending (user): record which bonuses apply (Phase 0) |
