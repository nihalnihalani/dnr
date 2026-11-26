---
inclusion: always
---
# Tech: how DNR is built

## Stack and pins

The exact versions are frozen in `pnpm-lock.yaml`, the `packageManager` field and `fixtures/pins.json` (plan §4). Do not add a dependency or change a pin without recording it there.

| Tool                      | Pin                                                                            |
| ------------------------- | ------------------------------------------------------------------------------ |
| Node                      | 24 LTS (CI also runs Node 26)                                                  |
| pnpm                      | 10.x (`packageManager`)                                                        |
| TypeScript                | 5.9.x, ESM only (`"type": "module"`)                                           |
| zod                       | 4.6.7                                                                          |
| diff (jsdiff)             | 9.0.0, `diffArrays` is the only diff engine in core                            |
| web-tree-sitter           | 0.27.2, grammars vendored in `vendor/grammars/` with sha256 in `PROVENANCE.md` |
| vitest / fast-check       | 5.1.2 / 4.11.0                                                                 |
| Biome                     | 2.6.9 (lint and format)                                                        |
| tsup                      | 9.0.0 (CLI bundle)                                                             |
| hono, vite, react         | 4.13.22, 8.4.0, 19.3.1                                                         |
| @modelcontextprotocol/sdk | 1.32.2                                                                         |
| shell-quote               | 1.12.0                                                                         |
| Kiro CLI                  | 3.4 or later required, 3.6 or later preferred                                  |

## Rules

- **Isomorphic core.** `packages/core` never imports `node:*`, `fs`, `path`, `process` or anything that needs Node. The same build runs in the hook and in the browser Playground, and P9 checks that both give identical decisions. I/O lives in `git`, `store`, `hook` and `cli`.
- **Zod at every boundary.** Hook stdin, order and grant files, config, fixtures, the drafter's output, MCP inputs and outputs, board API bodies and `CaseBundle` files are parsed with the schemas in `packages/schemas` (plan §7) before use. Fixture schemas use `z.strictObject`. Never trust a cast.
- **Exit codes (plan §8).** Hook in `deny` format: 0 allow (including every internal error), 2 block. Hook in `ask` format and `--hook stop`: always 0; the decision is JSON on stdout. Other commands: 0 clean, 1 findings, 64 usage, 65 invalid data, 69 missing dependency, 70 internal error.
- **Fail open.** A DNR bug never stops an agent. Every hook mode catches all errors, allows the write and logs to `$DNR_STATE_DIR/hook.log`. Stop mode has a top-level handler that always exits 0, because exit 1 would force a turn.
- **Never rewrite the agent's input.** DNR does not use `updatedInput`; it allows, asks, warns or blocks.
- **Deterministic output.** Order building, mining and `--canonical` replay must be byte-identical on rerun. Sort keys, never depend on map iteration order or wall-clock time (use `DNR_NOW` in tests).
- **Hook budget.** p95 under 300 ms on a match and under 80 ms on the fast path; first write of a fresh Django session under 2 s.
- **Tests.** Unit tests next to the code (`*.test.ts`), properties with fast-check (500 runs locally), fixtures validated by `pnpm test:fixtures`.
- **Shipped templates.** `packages/cli/templates/steering/dnr.md` is the steering file `dnr init` installs in a user's repo. It is not active in this repo, because the MCP tool it tells agents to call does not exist here until Phase 12.
- **No template placeholders in files Kiro reads as-is.** `.kiro/**/*.json`, `trial/agents/*.json` and `powers/**/*.json` never contain `{{`; CI enforces it.
- **Paths.** Repo-relative paths never contain `..` or a leading `/`. Absolute paths come only from `ROOT`, `TRIAL_ROOT`, `DJANGO_SRC`, `SECOND_SRC`, `TS_DEMO_SRC`, `DNR_ORDERS`, `DNR_STATE_DIR` and `DNR_CONFIG`.
