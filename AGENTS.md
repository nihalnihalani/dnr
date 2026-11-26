# AGENTS.md

Instructions for any coding agent (Kiro, Claude, or another) working in this repository.

## What this project is

DNR (Do Not Resurrect) turns a repository's reverts into do-not-resurrect **orders**. A maintainer approves each order. When an agent's write would bring a reverted change back, a Kiro PreToolUse hook stops it before the file changes. The hook shows the reason and links the original commit, the revert and the ticket. Re-landing a fixed version takes one human approval.

It is the Kiroween 2026 entry (Frankenstein category). The build plan is the accepted DNR plan, kept in the Kiroween research archive under `kiroween/dnr-plan/`. Its section numbers (§5, §7, §9 …) are cited throughout this repo. The plan is normative: build to it, and when the build proves the plan wrong, amend the plan in writing. Never quietly diverge from it.

## No mocks, no seeded data: it must actually work

**Do not mock or seed data. Everything must actually work.**

- **No fake data:** don't invent data, results, scores, counts or outputs and present them as real, anywhere: code, tests, fixtures, reports, the Playground, the README, docs, the video or the write-up.
- **Real sources:** every number comes from a command that actually ran, on real inputs. Orders are built from real git history, demo cases from real reverts (for example Django `43933a1dca`), and trial results from real agent runs.
- **Tests exercise the real thing:**
  - real git repositories, created in a temp directory;
  - the real Django clone;
  - the built `dnr` binary;
  - real HTTP against the board server;
  - real browsers in Playwright.

  Don't stub the code under test, and don't stub the boundary it exists to handle.
- **When a real dependency is missing, fail loudly.** If `kiro-cli` isn't installed, a GitHub App doesn't exist yet, or a human labeler hasn't labeled, the feature stops with a clear message and a non-zero exit. Mark the matching check "pending" in `docs/acceptance-matrix.md`. Never simulate success or fill the gap with placeholder output.
- **No placeholders where readers look.** `reports/trial.json`, `reports/decision.md`, `reports/video/numbers.json` and the hosted `/trial` page hold real results or nothing at all. An empty state is honest; a plausible sample is not.
- **No fake labels or approvals.** Never fabricate labels, tickets, approvals, grants or labeler decisions. Human steps stay human.
- **Remove existing fakes.** If you find a mock, sample, seeded or illustrative value already in the repo, replace it with the real thing or remove it. Note what you removed in your report.

## Repository layout

| Path | What it holds |
|---|---|
| `packages/schemas` | Zod schemas for every record (§7) |
| `packages/grammar` | web-tree-sitter loaders for the vendored grammars in `vendor/grammars/` |
| `packages/core` | the isomorphic match engine (§5), with no `node:*` imports; API in `packages/core/README.md` |
| `packages/testkit` | fast-check arbitraries and the AST mutation generator |
| `packages/git` | safe git execution, diffs, patch-ids, revert discovery |
| `packages/store` | orders, grants, sessions and events, with atomic writes and locks; API in `packages/store/README.md` |
| `packages/hook` | Kiro hook entry points: pre-write, post-write, guard-shell, post-shell, Stop, session start |
| `packages/cli` | the `dnr` command (npm package `dnr-guard`) |
| `packages/mcp` | the read-only MCP server (`explain_function`, `list_orders_for_file`) |
| `packages/trial` | revert mining (`src/mine/`) and the pre-registered trial harness (§9) |
| `packages/ui`, `apps/playground`, `apps/board` | one React app, served as the hosted Playground and as the local board |
| `.kiro/` | specs, steering, hooks, agents and prompts. It is tracked and must stay at the repo root |
| `fixtures/`, `reports/` | real inputs and real outputs only |
| `docs/` | spikes, threat model, architecture, testing, Kiro usage, acceptance matrix, reviews |

## Commands

Run all of these from the repo root:

```
pnpm install
pnpm typecheck
pnpm test
pnpm test:fixtures
pnpm lint
pnpm -F dnr-guard build
pnpm -F @dnr/playground build
node scripts/check-grammar.mjs
```

Work is done only when typecheck, tests and lint all pass on a **clean clone** with `pnpm install --frozen-lockfile`.

## Rules for changes

- **Start from the spec.** Each phase begins by writing or extending its Kiro spec in `.kiro/specs/`. Tick a task only when its acceptance check passes, and record the real commit SHA.
- **Name tests after what they prove.** Use the checklist row ID, a requirement (R1–R15) or a property (P1–P17), for example `it('R9: …')`. Never weaken a test to make it pass.
- **Security rules hold** (§5.10–5.13, threat model):
  - Approval commands are human-only.
  - Tampered or invalid DNR state never fails open.
  - Protected paths (`.dnr/**`, `.git/**`, `.kiro/hooks/**`, the installed bundle) stay protected.
- **Board auth must not weaken:** launch nonce, `Host`, `Origin` and `X-DNR-CSRF` checks, and the cookie on every `/api/*` route.
- **Stay honest in user-facing text.** Every claim in the README, the Playground and the write-up must link to a file in `reports/` or `.kiro/` that backs it.
- **Ask before any outside action.** Don't commit secrets. Don't create remotes, push, publish to npm, deploy, or create GitHub Apps or secrets without the maintainer's explicit go-ahead.
- **Commit messages** describe what changed and why.
