# DNR (Do Not Resurrect)

> **"Your repository remembers why. Your agent doesn't."**

DNR turns a repo's reverts into do-not-resurrect orders. Each order is generated from git and the original ticket, approved by a maintainer, and kept in a graveyard you can browse.

{{pitch_mechanism}} It shows the reason and links to the original commit, the revert, and the ticket. Re-landing a fixed version takes one approval. {{pitch_result}} The known gaps are listed in the [threat model](docs/threat-model.md).

The trial was pre-registered and labeled blind, and every run is public. Judges can try it in a browser: **{{playground_url}}**

Built for Kiroween 2026 (Frankenstein category) with Kiro: specs, hooks, steering, custom agents, MCP and a power. See [how Kiro built it](docs/kiro-usage.md).

## Quick start

Requires Node 24 or later, git, and Kiro CLI 3.4 or later.

```bash
npm i -g {{package}}
cd your-repo
dnr init            # hooks in .kiro/hooks/, .dnr/config.json, pre-commit shim, steering
dnr scan            # find reverts in your history
dnr orders build    # turn them into draft orders
dnr draft --all     # one-sentence reason per order, from the revert and ticket
dnr board           # review and approve; only approved orders are enforced
```

When an agent's write would re-apply an approved order, the hook refuses it:

```
DNR: <reason> <revert URL>
DNR order dnr-43933a1dca matched (edit 0.92 ≥ 0.60) in Query.set_group_by. Original: <url>. Ticket: <url>.
This change was tried and reverted. Do not re-apply it or route around this block. Tell the user. ...
```

A human recovers with `dnr board --open <order_id>` or `dnr allow <order_id>`, from a terminal.

## Testing

1. Open the Playground URL ({{playground_url}}) and run `/play` on a demo case.
2. Run `scripts/demo/make-demo-checkout.sh`, log in to `kiro-cli`, and trigger the live Kiro block:
   `cd ../django-demo && kiro-cli chat "$(cat "$OLDPWD/scripts/demo/prompts/write.txt")"`.
   `direct.txt` and `cleanup.txt` are alternates.
3. Open the Codespaces devcontainer and run `dnr doctor`.
4. Run `npx {{package}} demo` for the offline terminal replay.
5. Try it on your own repo: `npm i -g {{package}} && dnr init && dnr scan && dnr orders build && dnr draft --all`, then review and approve in `dnr board`.

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
