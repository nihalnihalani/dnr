# Hook latency (Phase 5, R8)

Measured on November 26, 2026 by `node scripts/bench-hook.mjs --cwd <demo checkout> --runs 50`. hyperfine is not installed on this machine, so the script runs each command as a fresh process the same way, after 3 warm-up runs. It writes hyperfine-shaped JSON that `node scripts/p95.mjs perf.json` reads.

- **Machine:** Apple M4 Pro, macOS, Node 25.2.1.
- **Build:** the tsup bundle `packages/cli/dist/cli.js`, with code splitting. Commands load lazily, so the fast path never loads web-tree-sitter or the grammars.
- **Demo checkout:** a local `git clone --shared` of Django at the revert `43933a1dca` (6,981 tracked files). The approved `dnr-43933a1dca` order is in `.dnr/orders/`.

| Case | Fixture | Exit | p50 | p95 | Target |
|---|---|---|---|---|---|
| Match (block) | `fixtures/hook-events/reapply-43933a1dca.json` | 2 | 151.8 ms | **161.7 ms** | p95 < 300 ms |
| Fast path (uncovered file) | `fixtures/hook-events/uncovered.json` | 0 | 61.6 ms | **65.3 ms** | p95 < 80 ms |
| First write of a fresh Django session (temp-index baseline) | `uncovered.json`, empty `sessions/` | 0 | — | **359 ms** (one run) | < 2 s |

All three targets pass.

Notes:
- The match case runs in the same session each time: a block does not add the order to `warned`, so every run takes the full path. That path loads the grammars, makes one `git cat-file --batch` call for the baseline, snapshot and HEAD texts, parses, derives stale and re-landed (cached in `cache/derived.json`), scores, and appends the event.
- Before code splitting, the single-file bundle evaluated every dependency at startup (zod, the MCP SDK, hono, shell-quote, web-tree-sitter). The fast path then measured p95 114.5 ms, which failed the target. After splitting it is 65.3 ms.
- Not measured yet: P10-05 (the fingerprint index on, with a cold cache at Django scale) waits for Phase 10. A Linux CI run on Node 24 is also still to do.
