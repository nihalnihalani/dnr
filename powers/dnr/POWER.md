---
name: "dnr"
displayName: "DNR (Do Not Resurrect)"
description: "Blocks agent writes that re-apply reverted changes, with the revert's reason and links."
keywords: ["revert", "regression", "do not resurrect", "git history", "guard", "hooks"]
author: "{{builder_handle}}"
---

# DNR (Do Not Resurrect)

Legacy-format fallback for the `dnr` power. Spike S9 decides whether Kiro loads this file or `plugin.json`; both describe the same power.

DNR turns a repository's reverts into do-not-resurrect orders that a maintainer approves. When an agent's write would bring a reverted change back, a Kiro PreToolUse hook blocks it and shows the reason with links to the original commit, the revert and the ticket.

## Onboarding

1. Install the CLI: `npm i -g {{package}}`.
2. In the repository: `dnr init`. This installs the hooks, `.dnr/config.json` and the steering file. The power does not bundle hooks or steering unless spike S9 shows the format supports it.
3. Find and build orders: `dnr scan && dnr orders build && dnr draft --all`.
4. A human reviews and approves orders in `dnr board`.

## MCP tools

The power runs `dnr mcp` over stdio (`mcp.json`). Both tools are read-only and never return the order's token lists.

- `explain_function({file, qualname})` returns the orders that cover a function, with effective status, reason and links.
- `list_orders_for_file({file})` returns the orders that touch a file.

## Steering for agents

- Call `explain_function` before editing a function.
- If DNR blocks a write, do not route around it (no shell rewrite, no split edits, no paraphrase). Tell the user the order ID and the reason.
- Only a human can approve a re-land, with `dnr board --open <order_id>` or `dnr allow <order_id>`.
