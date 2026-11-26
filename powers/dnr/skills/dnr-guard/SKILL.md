---
name: dnr-guard
description: Use when editing code in a repository protected by DNR (Do Not Resurrect), when a write was blocked with a "DNR:" message, or when setting DNR up in a repository. Explains how to check a function's revert history before editing and what to do when a write is blocked.
---

# dnr-guard

DNR keeps a list of do-not-resurrect orders: changes this repository reverted, each approved by a maintainer. A Kiro PreToolUse hook blocks writes that would re-apply one.

## Step 1: make sure DNR is installed

If `.dnr/config.json` or `.kiro/hooks/dnr-pre-write.json` is missing from the repository, tell the user and ask them to run `dnr init` in a terminal. Do not run it yourself: `dnr init` changes enforcement, and DNR refuses it inside an agent session.

## Step 2: before you edit a function

Call the MCP tool `explain_function` with the file and qualified name (for example `{"file": "django/db/models/sql/query.py", "qualname": "Query.clear_ordering"}`). If it returns approved orders, read each `reason` and avoid re-introducing the reverted change. `list_orders_for_file` lists every order for a file.

## Step 3: if a write is blocked

The block message starts with `DNR:` and names an order such as `dnr-43933a1dca`.

- Stop. Do not retry the same change through the shell, through several smaller edits, or by rewording it.
- Tell the user the order ID, the reason and the links from the message.
- Only a human maintainer can approve a re-land, from a terminal: `dnr board --open <order_id>` or `dnr allow <order_id>`. Never run these, `dnr orders approve|retire|edit`, or edit files under `.dnr/` or `.kiro/hooks/`.

Steering advises; hooks enforce.
