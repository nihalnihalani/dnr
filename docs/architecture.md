# Architecture

DNR (Do Not Resurrect) turns a repository's reverts into do-not-resurrect orders and enforces them where an agent writes code. This page is the diagram the write-up links to; the normative detail is in `.kiro/specs/dnr-check/design.md` and `.kiro/specs/trial-harness/design.md`.

## Write path

```mermaid
flowchart LR
  subgraph history["What the repository remembers"]
    GIT[git revert graph: C and its revert R]
    TIX[ticket and PR discussion]
  end
  GIT --> BUILD[dnr scan + dnr orders build<br/>tree-sitter units, A and R tokens]
  TIX --> DRAFT[dnr draft<br/>dnr-drafter agent, no tools, Zod-validated reason]
  BUILD --> ORD[(.dnr/orders/*.json)]
  DRAFT --> ORD
  HUMAN[maintainer] -->|approve, retire, allow once| BOARD[dnr board<br/>127.0.0.1, cookie + Origin + CSRF]
  BOARD --> ORD

  subgraph kiro["Kiro session"]
    AGENT[agent] -->|fs_write, str_replace, fs_append, delete_file| PRE[PreToolUse write hook]
    AGENT -->|execute_bash| SH[PreToolUse shell hook]
    AGENT --> STOP[Stop hook]
  end

  PRE -->|dnr check --stdin --hook kiro| ENGINE
  SH -->|dnr guard-shell --stdin| ENGINE
  STOP -->|dnr check --worktree --hook stop| ENGINE
  ORD --> ENGINE[core engine<br/>baseline snapshot, edit-overlap score,<br/>two-sided rule, grants, warn once]
  ENGINE -->|exit 2 + reason and links| AGENT
  ENGINE -->|allow| AGENT

  ENGINE --- PC[git pre-commit<br/>dnr check --staged, crossing rule]
  ENGINE --- CREW[Crew PR check<br/>dnr check --commit, dnr-bot App]
  ENGINE --- PG[hosted Playground<br/>same engine in the browser]
  MCPS[dnr mcp: explain_function] --> AGENT
  ORD --> MCPS
```

## Layers

| Layer | Package | Notes |
|---|---|---|
| Schemas | `packages/schemas` | Zod 4, every boundary (plan §7) |
| Grammar | `packages/grammar` | web-tree-sitter loaders for node and the browser; grammars in `vendor/grammars/` |
| Engine | `packages/core` | isomorphic, no `node:*`: tokenize, qualname, diff, multiset, score, proximity, decide, stale, apply-tool |
| Git and state | `packages/git`, `packages/store` | temp-index baseline, blobs, revert discovery; orders, grants, sessions, `events.jsonl` |
| Hooks and CLI | `packages/hook`, `packages/cli` | the `dnr` binary that Kiro's hook files call |
| MCP | `packages/mcp` | two read-only tools |
| UI | `packages/ui`, `apps/playground`, `apps/board` | one React app, a localStorage adapter (Playground) and a local-API adapter (board) |
| Trial | `packages/trial`, `trial/agents/` | the pre-registered evaluation (plan §9) |

## Decision order

Every write is checked in the order **protect → match → warn → allow**. Protected paths (`.dnr/**`, `.kiro/hooks/**`, `.kiro/settings/**`, `.kiro/agents/**`, `~/.kiro/**`) are always denied. A match needs an edit-overlap score of at least τ (0.6 before tuning) and, when the order both adds and removes code, at least 30% of each side. A covered but non-matching write is warned once per order per session. Grants from allow-once or an approved `ask` let a fixed re-land through. Every internal error fails open.
