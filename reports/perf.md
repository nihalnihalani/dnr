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

## Re-measured after the wave-2 fixes (November 26, 2026, late)

The C1 fix puts one `git ls-tree HEAD -- .dnr/orders .dnr/config.json` on every hook invocation: orders and config are read from the committed tree when the working copy differs, and there is no on-disk cache an agent could forge. The fast path pays for that spawn. Three things offset it:
- the write hook has its own lean entry (`check-fast`), which loads only the pre-write module;
- the `ls-tree` starts while that module is still loading;
- the derived-status disk cache is gone, because an agent could forge it.

| Case | p50 | p95 | Target |
|---|---|---|---|
| Match (block), `reapply-43933a1dca.json` | 162 ms | 167–169 ms | < 300 ms |
| Fast path, `uncovered.json` | 74 ms | **79.2 ms** on a quiet run | < 80 ms |
| First write of a fresh Django session | — | 112–140 ms | < 2 s |

The fast path is now at the edge of its budget. Other agents were running test suites during these runs (load average about 10), and under that load the fast-path p95 ranged from 79 to 122 ms. A Linux CI measurement on an idle runner is still owed. If the budget has to hold with margin, the next step is to read HEAD's tree for `.dnr/` straight from the object store, with no git process.

## Re-measured after the wave-3 fixes (November 27, 2026)

Wave 3 removed the per-invocation `git ls-tree` (N8). The hook now reads HEAD's commit id straight from `$GIT_DIR` (the HEAD file, loose refs, `packed-refs`) with no git process. It caches the committed `.dnr` entries by that commit id in `<state>/cache/committed-<sha>.json`. A forged cache can only change the HEAD source. The enforced order set is the union of the working copy, HEAD, the session-start set, the human-attested record and orders held by an open tamper flag (N3), so a forged cache cannot remove enforcement.

Three runs of `node scripts/bench-hook.mjs --runs 50` on the Django demo checkout (Apple M4 Pro), with other agents running test suites (load average about 8):

| Case | p50 | p95 (three runs) | Target |
|---|---|---|---|
| Match (block), `reapply-43933a1dca.json` | 156–162 ms | 169.2 / 178.3 / 161.9 ms | < 300 ms |
| Fast path, `uncovered.json` | 64–67 ms | **70.9 / 75.6 / 66.6 ms** | < 80 ms |
| First write of a fresh Django session | — | 153–168 ms | < 2 s |

A Linux CI measurement on an idle runner is still owed.
