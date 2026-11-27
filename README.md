# DNR (Do Not Resurrect)

> **"Your repository remembers why. Your agent doesn't."**

DNR turns a repo's reverts into do-not-resurrect orders. Each order is generated from git and the original ticket, approved by a maintainer, and kept in a graveyard you can browse.

When a Kiro agent's write would bring a reverted change back, a PreToolUse hook stops it before the file changes. It shows the reason and links to the original commit, the revert, and the ticket. Re-landing a fixed version takes one approval. The known gaps are listed in the [threat model](docs/threat-model.md).

**Status: hook path built; trial not run.** The PreToolUse hook, CLI, order store and MCP server are built. They block the real Django re-application end to end: re-applying the change reverted in `43933a1dca` exits 2 with edit 1.00 in `Query.clear_ordering` (see below). The pre-registered trial has not run yet, and its pre-registration is in progress, so no trial result is claimed here. The hosted Playground is live at https://nihalnihalani.github.io/dnr/.

Built for Kiroween 2026 (Frankenstein category) with Kiro: specs, hooks, steering, custom agents, MCP and a power. See [how Kiro built it](docs/kiro-usage.md).

## Quick start

Requires Node 24 or later, pnpm 10, git, and Kiro CLI 3.4 or later. The npm package is not published yet, so build and link `dnr` from source:

```bash
pnpm install --frozen-lockfile && pnpm build && pnpm -C packages/cli link --global
cd your-repo
dnr init            # hooks in .kiro/hooks/, .dnr/config.json, pre-commit shim, steering
dnr scan            # find reverts in your history
dnr orders build    # turn them into draft orders
dnr draft --all     # one-sentence reason per order, from the revert and ticket
dnr board           # review and approve; only approved orders are enforced
```

When an agent's write would re-apply an approved order, the hook refuses it. This is the real stderr (705 characters, exit 2) from `dnr check --stdin --hook kiro < fixtures/hook-events/reapply-43933a1dca.json` on a Django checkout at the revert `43933a1dca`, with the order approved and its reason still the placeholder revert subject (from [reports/orders/README.md](reports/orders/README.md); also the `R1:` test in `packages/hook/test/golden.test.ts`):

```
DNR: Reverted "Fixed #26434 -- Removed faulty clearing of ordering field when missing from explicit grouping." https://github.com/django/django/commit/43933a1dca07047e95ec990d9289d0212668009e
DNR order dnr-43933a1dca matched (edit 1.00 ≥ 0.60) in Query.clear_ordering. Original: https://github.com/django/django/commit/ea3a71c2d09f8281d8a50ed20e40e1fb13db5cd9. Ticket: https://code.djangoproject.com/ticket/26434.
This change was tried and reverted. Do not re-apply it or route around this block. Tell the user. Only a human maintainer, not the agent, can approve a re-land: `dnr board --open dnr-43933a1dca` or `dnr allow dnr-43933a1dca`, which both need a terminal and refuse inside an agent session.
```

A human recovers with `dnr board --open <order_id>` or `dnr allow <order_id>`, from a terminal. As the [threat model](docs/threat-model.md) puts it, the human-only guard is a speed bump against a careless agent, not a security boundary against a hostile same-user process; DNR detects and flags such approvals.

## Testing

1. Open the hosted Playground at https://nihalnihalani.github.io/dnr/ and run `/play` on a demo case.
2. Run `scripts/demo/make-demo-checkout.sh`, log in to `kiro-cli`, and trigger the live Kiro block:
   `cd ../django-demo && kiro-cli chat "$(cat "$OLDPWD/scripts/demo/prompts/write.txt")"`.
   `direct.txt` and `cleanup.txt` are alternates.
3. Open the Codespaces devcontainer and run `dnr doctor`.
4. Run `dnr demo --live` to run the real hook offline on the real Django case (its input event is labeled provisional until spike S2). `dnr demo` without `--live` exits 69, because no recorded Kiro session exists yet.
5. Try it on your own repo: `dnr init && dnr scan && dnr orders build && dnr draft --all`, then review and approve in `dnr board`.

Details and expected output for each step: [docs/testing.md](docs/testing.md).

## Documentation

- [Architecture](docs/architecture.md): the write path and the packages
- [Threat model](docs/threat-model.md): what DNR defends and its known limits
- [Testing](docs/testing.md): the five ways to try it
- [Spikes](docs/spikes.md): the Kiro runtime questions answered before building
- [How Kiro built it](docs/kiro-usage.md): the Devpost write-up
- Specs: [dnr-check](.kiro/specs/dnr-check/requirements.md) and [trial-harness](.kiro/specs/trial-harness/requirements.md)

## Repository layout

```
.kiro/       specs, steering, hooks, agents, prompts, MCP settings
packages/    schemas, grammar, core, git, store, hook, cli, mcp, ui, trial, testkit
apps/        playground (hosted, static) and board (local, 127.0.0.1)
powers/dnr/  the Kiro power
trial/       trial agent configs
fixtures/    pinned inputs, recorded hook events, demo orders
reports/     trial outputs, gate, perf, decision
docs/        architecture, threat model, testing, spikes, write-up
```

## Development

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## License

[MIT](LICENSE). Third-party material is listed in [NOTICE](NOTICE).
