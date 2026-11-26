---
inclusion: fileMatch
fileMatchPattern: ["packages/hook/**", ".kiro/hooks/**"]
---
# Hook contracts

What DNR may assume about Kiro's hook runtime. Each row is either **verified** (from the Kiro docs, re-read on 2026-11-26: kiro.dev/docs/hooks, /hooks/types, /custom-agents/configuration-reference, /cli/headless) or **pending: verify in spike Sx** (plan §13.1 Phase 1, results in `docs/spikes.md`, captures in `fixtures/hook-events/`). Code must not depend on a pending row until its spike is recorded. This file is frozen at the end of Phase 1; later changes are dated amendments that name the spike or gate finding.

## Hook files

| Contract                                                                                                                                                                                                                                                                                                              | Status                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A hook file is `.kiro/hooks/<id>.json` = `{"version":"v1","hooks":[{name, trigger, matcher?, action:{type:"command",command}, timeout?, enabled?}]}`. `timeout` is seconds, default 60. Triggers are PascalCase.                                                                                                      | verified                                                                                                                   |
| CLI V3 also loads global hooks from `~/.kiro/hooks/`; global and workspace hooks both run. The trial seeds hooks only in the per-run `$HOME/.kiro/hooks/`.                                                                                                                                                            | verified; S1 confirms headless                                                                                             |
| Command actions run a shell command in the project root, with the event JSON on stdin.                                                                                                                                                                                                                                | verified                                                                                                                   |
| Triggers DNR uses: `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, and `PostFileSave` (dev hook only). `Stop` takes no matcher.                                                                                                                                                                                  | verified; S4 confirms SessionStart, SessionEnd and Stop fire headless                                                      |
| Matcher `write` selects `fs_write`, `fs_append`, `str_replace`, `delete_file`; `shell` selects `execute_bash` and `execute_pwsh`.                                                                                                                                                                                     | verified                                                                                                                   |
| A selector matcher is also compiled as an **unanchored regex**, so `write` can match any tool ID that contains "write" (for example an MCP tool `mcp_x_write_y`). The pre-write adapter must therefore treat an unknown tool with no path as allow, and an unknown write-tagged tool with a path as warn tier (§5.8). | verified (docs); S2 lists the tool IDs actually seen                                                                       |
| File-trigger matchers (`PostFileSave`) are a regex against the file path, and file triggers fire only on agent edits, never on manual editor saves.                                                                                                                                                                   | verified; S14 confirms in the IDE                                                                                          |
| Agent-config hooks (CLI V3) are an array of the same hook documents under `hooks` in the agent JSON (`dnr-gate-1b.json`). The legacy object form keyed by camelCase events is still accepted.                                                                                                                         | verified (docs); S10 confirms key shape, duplicate handling, and that `--agent <name>` resolves from `$HOME/.kiro/agents/` |
| Hooks run on Kiro Web for Prompt Submit, Agent Stop, Session Start, Pre Tool Use and Post Tool Use, not for file triggers.                                                                                                                                                                                            | verified (docs); S14 confirms Web and IDE behavior                                                                         |
| The `write` category covers built-in file write tools only. An MCP tool that writes files (`mcp_<server>_<tool>`) never reaches `dnr-pre-write`. Open option: a second PreToolUse hook with matcher `@mcp`, where calls with a path go to the unknown-tool warn tier. Stop (touched files) does not see these writes either, because `touched` comes from write tools and shell snapshots. | verified (docs: the `write` category is "all built-in file write tools"); gap listed in `docs/threat-model.md` |
| `PermissionRequest` trigger (CLI 3.4+, IDE 1.4.236+): runs after policy evaluation, just before a tool call would prompt. Answer: `{"hookSpecificOutput":{"decision":{"behavior":"allow"\|"deny","message":…}}}` or exit 2. It does not run when a PreToolUse hook already allowed the call. DNR does not register it. | verified (docs) |
| Whether an `ask` from `dnr-pre-write` produces a `PermissionRequest` event, and what an approval looks like there, compared with PostToolUse (§5.7). | **pending: S5, S15** |

## Stdin

| Contract                                                                                                                                  | Status           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| PreToolUse stdin has `hook_event_name`, `cwd`, `session_id`, `tool_name`, `tool_input`. No field says whether the session is interactive. | verified         |
| Exact `tool_input` fields for `fs_write` (create/overwrite, legacy `command`), `fs_append`, `str_replace`, `delete_file`.                 | **pending: S2**  |
| `session_id` is stable across turns of one session.                                                                                       | **pending: S3**  |
| The shell tool's command field name.                                                                                                      | **pending: S12** |
| PostToolUse stdin for each write tool carries `session_id`, the path and `tool_response`, including after an approved `ask`.              | **pending: S15** |
| Stop and SessionStart stdin shapes (at least `hook_event_name`, `cwd`, `session_id`).                                                     | **pending: S4**  |

Frozen field names (fill in from the captures; until then the adapters accept every candidate name and fall to warn tier on an unknown shape):

| Tool           | Path field   | Content fields | Capture                         |
| -------------- | ------------ | -------------- | ------------------------------- |
| `fs_write`     | pending (S2) | pending (S2)   | `fixtures/hook-events/` pending |
| `fs_append`    | pending (S2) | pending (S2)   | pending                         |
| `str_replace`  | pending (S2) | pending (S2)   | pending                         |
| `delete_file`  | pending (S2) | —              | pending                         |
| `execute_bash` | —            | pending (S12)  | pending                         |

## Outputs and exit codes

| Contract                                                                                                                                                                                                                                                                                                                           | Status                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| PreToolUse: exit 0 allows; exit 2 blocks and sends stderr to the LLM; any other code warns and allows.                                                                                                                                                                                                                             | verified                                           |
| CLI 3.4+: exit 0 with stdout `{"hookSpecificOutput":{"permissionDecision":"ask"\|"allow"\|"deny","permissionDecisionReason":"…"}}`. Plain text, empty stdout or malformed JSON is not a decision, and the exit code alone applies, so a broken `ask` output fails open. When several hooks run, `deny` or exit 2 wins, then `ask`. | verified                                           |
| DNR never returns `updatedInput`. In `deny` format it prints nothing on stdout.                                                                                                                                                                                                                                                    | rule                                               |
| What `deny`, `ask` and `allow` do headless and interactive; whether `ask` is auto-approved under `--trust-all-tools` or refused under `--no-interactive`. `ask` stays opt-in and is never combined with `--trust-all-tools`.                                                                                                       | **pending: S5**                                    |
| Stop: exit 0 with `{"decision":"block","reason":…}` or exit 1 starts another turn; any other code leaves the response finished. DNR's Stop handler always exits 0 and uses the JSON form.                                                                                                                                          | verified; S4 confirms headless                     |
| PostToolUse: the tool already ran; non-zero exit only shows a warning.                                                                                                                                                                                                                                                             | verified                                           |
| CLI 3.6+: hook output over 3,000 characters is saved to a file and the agent sees the first part plus the path. DNR caps the reason text at 1,200 characters.                                                                                                                                                                      | verified; S13 records what the agent actually sees |
| Behavior on hook timeout (assumed: warn and allow, so fail-open holds).                                                                                                                                                                                                                                                            | **pending: S7**                                    |

**Block stderr** (deny format, at most 1,200 characters, first line fixed):

```
DNR: <reason> <revert URL>
DNR order <id> matched (edit <score> ≥ <τ>) in <qualname>. Original: <url>. Ticket: <url>.
This change was tried and reverted. Do not re-apply it or route around this block. Tell the user. Only a human maintainer, not the agent, can approve a re-land: `dnr board --open <id>` or `dnr allow <id>`, which both need a terminal and refuse inside an agent session.
```

## Environment

| Contract                                                                                                                                                                                                                             | Status                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| Headless runs: `kiro-cli chat --v3 --no-interactive --trust-all-tools --model <id> --agent <name> --output-format stream-json`; `--trust-all-tools` auto-approves hook confirmation requests; auth via `KIRO_API_KEY`.               | verified                    |
| Which credential file a headless run reads under HOME.                                                                                                                                                                               | **pending: S8**             |
| Whether hooks inherit `PATH` and the environment (`DNR_*`). If not, `dnr init` writes absolute `dnr` paths and the trial uses `$HOME/.dnr-trial.json`.                                                                               | **pending: S8**             |
| Files Kiro itself writes under `$HOME/.kiro` (the HOME-hash exclusion globs).                                                                                                                                                        | **pending: S8** (list here) |
| Environment variables present in hook and shell-tool child processes but absent from Terminal.app and the Kiro IDE integrated terminal (used by the R6 self-approval guard). Only those are frozen here.                             | **pending: S8** (list here) |
| Auto-update can be disabled with `kiro-cli settings app.disableAutoupdates true` or `KIRO_NO_AUTO_UPDATE`. A CLI version change stops the trial.                                                                                     | verified (docs)             |
| Whether a custom agent (`--agent`) loads workspace steering without a `resources` entry. The docs contradict each other; this decides whether `trial-S` needs its `resources` line and whether `dnr-drafter` sees a user's steering. | **pending: S10**            |
| Whether an always-block write hook fires headless under `--trust-all-tools`, under both registrations (hook file and agent config). Failure is provisional D1.                                                                       | **pending: S1**             |
| Whether `--sandbox` gives stronger trial isolation.                                                                                                                                                                                  | **pending: S1**             |

## Powers and Crew

| Contract                                                                                                                                                                                    | Status                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Agent Plugins format: `plugin.json` with `$schema`, `name`, `version`, `description`, `author{name}`, `keywords`, plus `mcp.json` and `skills/<n>/SKILL.md`; legacy `POWER.md` still works. | verified                                        |
| The `$schema` URL, whether `license` and `repository` are accepted, which format the CLI loads, and whether a power can bundle hooks and steering.                                          | **pending: S9**                                 |
| How a Crew session exposes its changes (PR, branch or event), which identity authors them, whether its comments carry `performed_via_github_app`.                                           | **pending: S16** (captures in `fixtures/crew/`) |

## Spike findings that changed a decision

(Filled in during Phase 1. Each entry: spike, finding, the decision it changed, the commit. The video's fallback Kiro chain starts from one of these.)
