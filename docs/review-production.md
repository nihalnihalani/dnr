# Production-readiness audit (dnr `2497fef`, dnr-crew `d988028`)

This is the devil's advocate's audit from November 27, 2026, against the plan, `docs/acceptance-matrix.md` and AGENTS.md (no mocks, no seeded data). Both repos are public, and the Playground is live at https://nihalnihalani.github.io/dnr/.

**How I tested.** I behaved as a stranger:
- I cloned **from GitHub**.
- I ran everything with a fresh `HOME` (an empty scratch directory) and `PATH` cut down to node, pnpm and the system directories, with no `PNPM_HOME` and no npm prefix.
- I installed the package from `pnpm pack` with `npm install -g --prefix <scratch>`. It isn't on npm yet.
- I used a `--shared` Django clone at `43933a1dca` for the attacks, and drove the live site in a real browser.

## Summary

| Area | Result |
|---|---|
| Clean public clone (stranger HOME) | Frozen install in 54 s, typecheck clean, lint 0 errors and 4 warnings, **575 tests pass, 10 skipped** |
| Installed package | `dnr --version` = 0.1.0. `dnr init` writes absolute `node` and `cli.js` paths into every hook and the pre-commit shim, records the bundle sha256 in `.dnr/install.json`, and *asks* before adding Kiro deny rules to `~/.kiro/settings/permissions.yaml` |
| README#testing as a stranger | Step 1 works (live `/play` runs the real engine in the browser). Step 2 needs `kiro-cli`. Step 3 needs Codespaces, not tried. **Steps 4 and 5 work**: `dnr demo --live` exits 2 with the real §6 stderr, plain `dnr demo` exits 69 as documented, and `init`, `scan` and `orders build` work on a fresh repo. `draft` fails loudly (exit 69) without kiro-cli. **The Quick-start link step fails** (P1) |
| Attacks on the installed `dnr` | All the wave-2 and wave-3 reproductions I re-ran are fixed, apart from the two gaps below. A real block still takes effect, and the earlier evasions now block or report |
| `pnpm audit --prod` | No known vulnerabilities in either repo. The full audit finds 14 in dnr (4 high, 10 moderate), all dev-only under `apps/playground > lighthouse`, and 1 moderate (dev) in dnr-crew |
| Live site | Every route loads, deep links work (301 to the trailing slash, then 200), there are no console errors, and `/trial` shows an honest empty state. One judge-facing problem: P2 |
| Submission checker | `scripts/submission/check.sh --no-smoke`: 9 PASS, 0 FAIL, 11 PENDING |

## Attacks re-run against the installed package

| Attack | Result |
|---|---|
| Re-application by `fs_write` (golden fixture) | exit 2 |
| Case-variant path `Django/…` | exit 2 |
| Write-tool writes to `.git/HEAD`, `.git/refs/…`, the installed `cli.js`, the `dnr` shim on PATH, the package's `node_modules`, `~/.zshenv`, `~/.bashrc`, `~/.kiro/settings/permissions.yaml`, `.dnr/install.json` | all exit 2 |
| Invalid config `{"threshold":2}` | exit 2, defaults used, tamper reported |
| Order retired in the working copy, same session | exit 2. Stop reports it |
| A maintainer-committed order weakened and committed (`git commit -am`) | **pre-commit refuses it**: "remove or weaken order … without a human-attested change". The next session exits 2 |
| `git reset --hard HEAD~1` removing the maintainer's order commit | the next session still exits 2 |
| Agent re-land commit in-session through an interpreter | post-shell prints "the commit you just made … re-applies". The order becomes `effective violated` |
| `git cherry-pick $(git rev-parse …)` | denied (R3). Wave-3 N6 is fixed |
| The wave-2 human-guard harness, re-run unchanged | it still creates a grant, but the grant is **suspect and doesn't apply** ("does not apply until a human confirms it"). The next re-application exits 2. Wave-3 N5 is fixed |
| The node binary that every hook runs (`…/.nvm/…/bin/node`) | **write tool exit 0; shell `cp /dev/null <node>` allowed** (P3) |
| Retired order in the working copy, uncommitted, **next session** | **exit 0**, though Stop keeps reporting the open tamper finding (P4) |

## Findings

### Critical: none open

Nothing I found lets a careless agent silently re-apply a reverted change that is already protected by committed, approved orders.

### High

**P1. The README Quick start fails for a stranger at the global link step.**
- *Where:* `README.md` Quick start, `pnpm -C packages/cli link --global`.
- *What happens:* on a pnpm without `pnpm setup`, it fails with `ERR_PNPM_NO_GLOBAL_BIN_DIR`, so `dnr` is never on PATH. Every later README step then fails with "command not found".
- *Fix:* until npm is published, document the tarball path, which I verified works:
  ```
  pnpm install --frozen-lockfile && pnpm -F dnr-guard build && pnpm -F dnr-guard pack && npm install -g ./packages/cli/dnr-guard-0.1.0.tgz
  ```
  Or prefix the link step with `pnpm setup && source ~/.zshrc`. Best: publish `dnr-guard` (P13-08, user) so step 5 is `npm i -g dnr-guard`.

**P2. The live headline demo shows ALLOW first.**
- *Where:* `/play/43933a1dca`. The order is shipped as `draft` (that's honest), so the first preset a judge clicks ("Original change C") returns **ALLOW, exit 0, fast path (file not covered)**.
- *Effect:* the block only appears after the judge finds "Approve (simulated)" under Maintainer actions. A judge who stops at the first click concludes DNR doesn't work.
- *Second problem:* once a browser has approved it, the header reads **"Approved: enforced"** with no "(simulated)" qualifier. The browser pane I used still held an approval stored the day before as `"by": "you (simulated)"`, so the header claimed enforcement on first load.
- *Fix:*
  - Make step 1 of `/play` an explicit "Approve as the maintainer (simulated)" call to action above the presets, or a one-click "Approve and send the original change" preset that says what it does.
  - Always render the header status as "Approved (simulated in this browser)" when the approval came from localStorage.
  - Add a "Reset this demo" button that clears `dnr.playground.v1`.

**P3. The `node` binary that runs every hook is writable.**
- *Where:* the protect set in `packages/hook/src/prewrite.ts` covers the bundle, the shims and the shell rc files, but not the absolute `node` path `dnr init` writes into the hooks (`.dnr/install.json` → `node`).
- *Effect:* under nvm, Homebrew or Volta, that path is user-writable. A write-tool `fs_write` to it, and a shell `cp /dev/null <node>`, were both allowed. A hook that can't execute exits 126 or 127, and Kiro treats any exit other than 0 or 2 as **warn and allow** (01-research), so a broken runtime is a silent fail-open at the Kiro layer.
- *Fix:*
  1. Add `realpath(install.node)` and its `lib/node_modules` to the protected set and to the Kiro deny rules `dnr init` installs.
  2. In guard-shell R1, treat that path like the bundle.
  3. Have `dnr doctor` and Stop compare node's sha256 with one recorded in `install.json`.
  4. Note in the threat model that Kiro allows on hook exit codes other than 0 or 2, and ask S7/S17 to confirm whether a permission rule can be "deny unless the hook exited 0".

**P4. An open tamper finding doesn't block writes in the next session.**
- *Where:* this happens with orders that exist only in the working copy, which is the state right after `dnr init` and `orders approve`, until the maintainer commits `.dnr/`.
- *Repro:* in session 1, retire the order via the shell. Stop reports it. In session 2, the re-application gets **exit 0**, while Stop keeps reporting "Open tamper finding …".
- *Effect:* the wave-3 N3 fix asked that writes to covered files *block* while a finding is open. Reporting alone lets the write land.
- *Fix:* while a tamper finding is open, pre-write uses the union of the attested set and the current set, and blocks matches. Alternatively, have `dnr orders approve` prompt to commit `.dnr/` (or write the attest log) so the committed-tree path applies.

**P5. The npm package ships bundled third-party code without license texts, and without its own LICENSE, NOTICE or README.**
- *What the tarball contains:* `dist/`, `templates/`, `vendor/` and `package.json`. It has **no `LICENSE`** (dnr's own MIT), **no `NOTICE`** and no `README`.
- *Bundled code that needs notices:*
  - `dist/ui/assets/*.js` bundles React, React DOM and CodeMirror (MIT, license text required);
  - `templates/demo/*.case.json` carries Django source (BSD-3-Clause, notice required);
  - `vendor/grammars/*.wasm` are tree-sitter grammars (MIT).

  Only `dist/ui/licenses/{django,vite}-LICENSE.txt` is included.
- *Fix:*
  - Add `LICENSE`, `NOTICE` and `README.md` to `packages/cli` and to `files`.
  - Generate `THIRD_PARTY_LICENSES.txt` for everything bundled into `dist/` (for example `rollup-plugin-license` or `license-checker --production`), and ship it.
  - Add the tree-sitter grammar license texts next to `PROVENANCE.md`.
  - Add React and CodeMirror to the repo's `NOTICE` for the hosted Playground too.
  - Add a CI check that the tarball contains `LICENSE`, `NOTICE` and `THIRD_PARTY_LICENSES.txt`.

**P6. The Crew caller workflow refers to `@v1`, and no tag exists in either repo.**
- *Where:* `packages/cli/src/hooks.ts:99` writes `uses: ${crewRepo}/.github/workflows/dnr.yml@v1`. `git ls-remote --tags` for `nihalnihalani/dnr-crew` and for `nihalnihalani/dnr` returns nothing.
- *Effect:* a repo set up with `dnr init --crew` fails at workflow resolution, so the Crew bonus can't start.
- *Fix:* tag `dnr-crew` `v1` at `d988028` once CI is green (user, outside action). Tag a `dnr` release `v0.1.0` and pin `action.yml` `dnr-ref` to it. Add the tag check to `scripts/submission/check.sh`.

### Medium

**P7. Every push to main shows a red deploy run.**
- *Where:* in `.github/workflows/deploy-playground.yml` the job "Cloudflare Pages / Require the Cloudflare secrets" fails because `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are not set. The GitHub Pages jobs pass.
- *Effect:* judges see a ❌ on the repo's commit list and Actions tab.
- *Fix (user decision):* either set the two secrets, or drop the Cloudflare job and keep GitHub Pages as the one URL (the plan allows the mirror). Dropping it is still "fail loudly": the deploy that matters, Pages, is the one that runs.

**P8. The rename cache can be forged to hide a re-application.**
- *Where:* the C-side cache under `.dnr/cache/` (wave 4).
- *Effect:* it is protected from write tools, but not from interpreter writes, and it isn't part of the tamper hash. A forged entry can lower rename similarity, so a moved and re-applied unit scores as unmatched and the write is allowed.
- *Fix:* use the cache only to *confirm* a match. When the cached path yields "no match" for a covered order, recompute without the cache, which costs latency only on the negative path. Alternatively, key entries by blob SHA plus the order hash and drop any entry whose key doesn't recompute.

**P9. The full audit has 4 high-severity advisories, all dev-only.**
- *Where:* `apps/playground > lighthouse > puppeteer-core` (`extract-zip`, `basic-ftp`, `zod` inside `chromium-bidi`).
- *Fix:* bump `@lhci/cli` / lighthouse, or add `pnpm.overrides` for `extract-zip ≥ 2.0.2` and `basic-ftp`. Run `pnpm audit --prod` in CI and keep it at 0.

**P10. The Lighthouse job still fails (P13-05).** This was known from the brief; it is part of the plan's Design and Presentation evidence. Fix it, or record the measured scores honestly in `reports/`.

**P11. Several docs are stale.**
- `scripts/submission/check.sh` says "dnr-crew is local-only" (P14-03), but it is public. Set `crew_repo` in `docs/submission/links.json`.
- `.devcontainer/devcontainer.json` `postCreateCommand` still echoes "packages/cli has no bin until Phase 2".
- `apps/playground/vite.config.ts:10` says "the sample is used otherwise", but no sample ships (the live `/data/trial.sample.json` returns 404, which is correct). Fix the comment.

### Low

- `dnr init` prints `kept ~/.kiro/settings/permissions.yaml` when the user declines and the file doesn't exist. Print "skipped" instead.
- `/play` counts A as "31 tokens", including weight-0 punctuation, while the engine's `w(A)` is 16. Show both, or say "31 tokens (16 weighted)".

## No-mock sweep (AGENTS.md)

I swept both public repos, code and docs (excluding reviews, the matrix, vendored grammars and real Django fixtures).
- **Nothing presents invented data as real.**
- `reports/` holds no `trial.json`, `decision.md` or `numbers.json`.
- The live `/trial` shows only the empty state.
- `fixtures/known-reverts.json` is still `unconfirmed:auto-form-match`, which is honest.
- The core no longer invents a reason (`1bfd9c2`).

What remains is legitimate and labelled:
- the "simulated" maintainer actions in the Playground;
- property-test generators;
- test-only label lines;
- GitHub's documented REST examples in dnr-crew;
- the `og.png` preview, produced by the real engine under a labelled simulated approval (`apps/playground/scripts/capture-og.ts:4`).

The `{{…}}` slots left are `docs/kiro-usage.md` (a labelled skeleton) and CI workflow expressions. Generate `kiro-usage.md` before submission (WRITE-03 is PENDING in `check.sh`).

## Live site (judge-facing)

| Page | State |
|---|---|
| `/` | Honest pitch. One overstatement: "the hook blocks it before the file changes and tells the agent why" is in the present tense, while no live Kiro block has been recorded yet (gate 1b pending). Until it is, say "DNR's hook is built to block…; this page runs the same engine on the real Django case" |
| `/trial` | "The pre-registered trial has not run yet", with no numbers. Correct |
| `/play/43933a1dca` | Real case. The editor loads. Presets: C, held-out paraphrase (invert-condition, seed 2000), hard negative, formatting. The recorded-agent and two-file presets are marked unavailable, with reasons. See P2 |
| Deep links, `/kiro`, `/replay`, `/graveyard` | 200, with no console errors |

## What still stands between today and a winning submission

| Owner | Item | When (PT) |
|---|---|---|
| **user** | Kiro credits requested and redeemed (still unrecorded in `docs/spikes.md`) | request now; cutoff Mon Dec 1, 12:00 |
| **user** | `kiro-cli` installed and logged in; headless key; model pinned | today |
| kiro-cli + team | S1/S2/S5/S8/S10/S11/S15/S17, then gate 1b (live block), then demo runs `demo/L` and `demo/LU` | Nov 28–30 |
| **user** | Outside labeler named, or §9.5 fallback declared; known-reverts confirmed (P0-27); Phase 3 labels → `reverts.json`, assignment, K | Dec 1 |
| team | P2 (the first `/play` click must show the block path), P1 (Quick start), P3, P4, P5 (licenses), P8 | Nov 29 |
| team + user + kiro-cli | Phases 4–10 on real data, then `prereg-v1` tagged and posted; Phase 11 waves and blind labelling; `trial report` | Dec 2–3 |
| team, then **user** | Video with the real block by 0:19, numbers from `numbers.json`; YouTube upload | Dec 3 |
| **user** | npm publish of `dnr-guard` (P13-08), the `v1` and `v0.1.0` tags (P6), Cloudflare decision (P7), Crew GitHub App and secrets and a real Crew session (Phase 12, bonus) | Dec 1–3 |
| **user** | dev.to and social posts, Devpost form (Frankenstein), bonus links | **Dec 4, 10:00 (hard close 14:00)** |

Without Kiro there is still no live block, no demo run, no trial and no video. Every software item above can be done on time; none of the Kiro-dependent ones can start until the user installs `kiro-cli` and the credits land.
