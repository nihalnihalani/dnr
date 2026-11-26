---
inclusion: always
---
# DNR: do-not-resurrect orders in this repository

This repository uses DNR. Some changes were tried here, reverted, and recorded as do-not-resurrect orders that a maintainer approved. A hook blocks any write that would bring one back.

- **Before editing a function, call the MCP tool `explain_function`** with its file and qualified name. If an order covers it, read the reason and do not re-introduce the reverted change.
- **If a write is blocked with a `DNR:` message, do not route around the block.** Do not retry through the shell, split the change into smaller edits, or reword it to avoid the match.
- **Report the order ID** (for example `dnr-43933a1dca`), the reason and the links to the user, then stop and let them decide.
- Only a human maintainer can approve a re-land, from a terminal (`dnr board --open <order_id>` or `dnr allow <order_id>`). Never run those commands, and never edit `.dnr/`, `.kiro/hooks/`, `.kiro/settings/` or `.kiro/agents/`.

Steering advises; hooks enforce.
