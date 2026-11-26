---
inclusion: always
---
# Product: DNR (Do Not Resurrect)

DNR turns a repository's reverts into do-not-resurrect orders. A maintainer approves each order. When a Kiro agent's write would bring a reverted change back, a PreToolUse hook stops it before the file changes, shows the reason, and links the original commit, the revert and the ticket. Re-landing a fixed version takes one approval.

- Audience: maintainers of repositories that accept AI-agent changes.
- Principle: steering advises, hooks enforce. DNR never edits an agent's write; it allows, asks, warns or blocks.
- A DNR bug never stops an agent: every internal error fails open and is logged.
- The build plan is the Kiroween 2026 DNR plan; every phase starts by writing or extending its Kiro spec.
