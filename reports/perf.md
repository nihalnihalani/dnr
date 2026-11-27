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

## P10-05: latency with the fingerprint index on, cold cache at Django scale (November 27, 2026)

Measured with **hyperfine 2.0.0** (`-N --runs 30`, stdin from `--input`), as the plan states. Raw JSON for every row is in [`reports/perf-p10-05/`](perf-p10-05/).

- **Build:** a clean worktree at `origin/main` `5e640c6`, the commit that gives hook orders their §5.16 material, so the write-time fingerprint lookup runs. The bundle is `packages/cli/dist/cli.js` from `tsup`. Node v24.13.1.
- **Checkout:** a `git clone --shared` of Django at `43933a1dca` (6,981 tracked files). It's a throwaway benchmark checkout in `dnr-work/django-bench`, never pushed. The two demo orders from `reports/orders/` are committed in its `.dnr/orders/` with `status` set to `approved`, the same way `packages/hook/test/golden.test.ts` does. That is a timing setup, not a maintainer approval.
- **Cold cache:** `--prepare "rm -rf $DNR_STATE_DIR"` before every run, so each run is the first write of a fresh session with an empty state directory: no sessions, no committed-`.dnr` cache, no parsed baseline.
- **Index case:** [`event-rename-reapply-43933a1dca.json`](perf-p10-05/event-rename-reapply-43933a1dca.json) is one `str_replace` built from the real R text. It renames `Query.clear_ordering` to `Query.reset_ordering` and re-applies C's `group_by` guard in the same edit. The covered unit is then missing from `query.py`, and the lookup has to find it under its new name. Each run's event records `outcome: block`, `tier: match`, `edit 1.00`, `proposed: relocated` → `Query.reset_ordering` (similarity 0.913).
- **Load:** other agents' Docker builds and test suites were running. Load average was 7.0 at the start and 14.3 at the end.

| Case | Fixture | Exit | p50 | p95 | max | Target |
|---|---|---|---|---|---|---|
| Cold: first write, match (block) | `reapply-43933a1dca.json` | 2 | 301.5 ms | 341.3 ms | 439.9 ms | < 2 s |
| Cold: first write, rename + re-apply (index lookup, block) | `event-rename-reapply-43933a1dca.json` | 2 | 491.3 ms | **790.2 ms** | 853.3 ms | < 2 s |
| Cold: first write, fast path | `uncovered.json` | 0 | 208.9 ms | 277.9 ms | 278.0 ms | < 2 s |
| Warm: match (block) | `reapply-43933a1dca.json` | 2 | 184.5 ms | 294.9 ms | 313.8 ms | p95 < 300 ms |
| Warm: rename + re-apply (index lookup, block) | `event-rename-reapply-43933a1dca.json` | 2 | 273.6 ms | **667.3 ms** | 693.7 ms | p95 < 300 ms (match budget) |
| Warm: fast path | `uncovered.json` | 0 | 71.3 ms | 76.8 ms | 78.5 ms | p95 < 80 ms |

Results:
- **P10-05 passes:** the slowest cold-cache first write at Django scale has p95 790 ms (max 853 ms), below 2 s.
- The warm match and fast-path rows are within their Phase 5 budgets, both close to the edge under this load.
- **The index lookup path misses the 300 ms match budget when warm (p95 667 ms).** It parses C's and PR's unit material and every unit of the target file to score candidates. This is the hook's cost, so it is reported to the hook owner and not tuned here. An idle Linux CI run is still owed for all rows.
- Before `5e640c6`, the same rename event scored `missing` and only warned: the hook never attached material, so the lookup never ran. Those timings are not reported, because they measured a path without the index.
