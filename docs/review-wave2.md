# Wave 2 review (b6f3a09, 2a25cff, plus d1e3e97, 53bb4d7, 5b62bb3)

The devil's advocate's adversarial review of wave 2 against the plan and `docs/acceptance-matrix.md`, November 26, 2026. I attacked the hooks the way an agent would, by feeding them the same stdin JSON Kiro sends.

**Setup.** A clean clone of `HEAD` (5b62bb3) in my scratchpad: `pnpm i --frozen-lockfile` with `--offline`, then `pnpm build`. `dnr` points at the built `packages/cli/dist/cli.js`. The demo checkout is a `git clone --shared` of `$DJANGO_SRC` at `43933a1dca`. Human steps (`dnr init`, `orders approve`) ran in a real pty. The approved order is `reports/orders/dnr-43933a1dca.json`. "Agent" commands ran as hook stdin events, and the file changes were then made the way the tool would make them. Nothing was run in the real repo.

## Summary

| Check | Result |
|---|---|
| Clean clone: typecheck, test, build | pass. 385 tests passed, 3 skipped. Lint: 0 errors, 4 warnings |
| Playground Playwright, Firefox and WebKit | 94 passed, 2 skipped. Chromium is not installed here |
| Live block on the demo checkout | exit 2, edit 1.00 in `Query.clear_ordering`; the file is unchanged |
| Decision formats and exit codes against §6 and §8 | all match. See [What holds](#what-holds) |
| Commit-time crossing | works (details below) |
| Stop | forces at most 2 turns, then allows |
| Latency | matches `reports/perf.md`: about 66 ms fast path, about 156 ms match, 0.32 s first write of a fresh session |

**The headline.** The single-write block is real and solid. But an agent with a shell can switch DNR off completely with one `python3 -c` line, because a config or session file DNR can't parse makes every hook fail open. That includes Stop and pre-commit. The same agent can also get a re-land approved for itself. Both are reproduced below.

**What commit-time checking does:**
- `dnr check --staged` exits 1 on the crossing.
- `git commit` is refused by the installed pre-commit hook.
- `git commit -n` is the bypass.
- `dnr check --commit <sha>` then flags that commit (exit 1).
- After the re-land is committed, an unrelated staged edit is allowed: the order is reported "re-landed" and no crossing is found.

## Findings

Every security finding has a reproduction. The shared setup is in the first block: run it inside the demo checkout with the approved order present.

```bash
# helpers used below (run inside the demo checkout, approved order present)
E()  { jq -nc --arg cwd "$PWD" --arg sid "$1" --arg ev "$2" '{hook_event_name:$ev,cwd:$cwd,session_id:$sid}'; }
W()  { jq -nc --arg cwd "$PWD" --arg p "$1" --rawfile c reapplied.py --arg sid "$2" --arg ev "${3:-PreToolUse}" \
        '{hook_event_name:$ev,cwd:$cwd,session_id:$sid,tool_name:"fs_write",tool_input:{path:$p,content:$c}}'; }
SH() { jq -nc --arg cwd "$PWD" --arg sid "$1" --arg ev "$2" --arg c "$3" \
        '{hook_event_name:$ev,cwd:$cwd,session_id:$sid,tool_name:"execute_bash",tool_input:{command:$c}}'; }
# reapplied.py = query.py at 43933a1dca with the ea3a71c2 clause put back (the reapply fixture's str_replace)
```

### Critical

**C1. Any agent can turn fail-open into a full bypass of every layer: pre-write, Stop and pre-commit.**
- *Where:*
  - `packages/hook/src/failopen.ts:36-87`: every error exits 0.
  - `packages/store/src/config.ts:46`: an invalid config throws `ConfigError`.
  - `packages/hook/src/context.ts:51`: the config loads before anything else, so Stop never reaches its orders-hash check.
  - `packages/store/src/sessions.ts`: a session file that isn't valid JSON throws.
  - `packages/hook/test/prewrite.test.ts:390`: "R7: an invalid config (injected fault) allows the write and logs". The suite asserts the bypass as intended behaviour.
- *How:* guard-shell does not inspect interpreter code, so `python3 -c` can write anything under `.dnr/`. One invalid value in the config (`{"threshold":2}`) or one garbled session file is enough.
- *Repro:*
  ```bash
  E s SessionStart | dnr session start --stdin
  SH s PreToolUse "python3 -c \"open('.dnr/config.json','w').write('{\\\"threshold\\\":2}')\"" | dnr guard-shell --stdin; echo $?   # 0
  printf '{"threshold":2}' > .dnr/config.json
  W django/db/models/sql/query.py s | dnr check --stdin --hook kiro; echo $?                 # 0 (error_open)
  cp reapplied.py django/db/models/sql/query.py
  E s Stop | dnr check --worktree --hook stop; echo $?                                       # 0, no forced turn, no orders-hash report
  git add -A django && git commit -qm x; echo $?                                             # 0: pre-commit fails open too
  # same result with:  python3 -c "import glob;[open(f,'w').write('x') for f in glob.glob('.dnr/sessions/*.json')]"
  ```
  `hook.log` shows `error_open hook=pre-write ConfigError …` and `error_open hook=stop …`. Every layer passed the re-application, including `commit-enforce`, which is the D1 fallback.
- *Fix:* fail-open is right for DNR bugs. It is wrong for DNR state that is *missing, unreadable or invalid*, because an agent can produce that state on purpose.
  1. Load orders and config from the committed tree. Use the session's `baseline_tree`, or `HEAD`, through `git cat-file`. Use the working copy only when it matches; a difference is tampering.
  2. On `ConfigError`, use the defaults (`enforce`), and have Stop report "DNR config invalid".
  3. Replace a corrupt session by re-snapshotting with an `orders_hash` mismatch flag, instead of throwing.
  4. Run the orders-hash and config-validity check before anything else in Stop, and exit with the JSON forced turn.
  5. Change the test at `prewrite.test.ts:390` to assert *block*, or *warn and report*, on invalid config.
  6. Add a dated amendment to plan R7: "internal errors allow; invalid or tampered DNR state does not."

**C2. On macOS, writing to a case-variant path re-applies the change with no block and no Stop.**
- *Where:* `packages/hook/src/repo.ts:24` uses `realpathSync`, which keeps the caller's casing. Order files are then compared case-sensitively (`decide.ts` `filesOf`, and `stop.ts` `touched`). The protect tier folds case (`.Dnr/config.json` is denied), so the two checks disagree.
- *Repro:* APFS is case-insensitive by default.
  ```bash
  E c SessionStart | dnr session start --stdin
  W Django/db/models/sql/query.py c | dnr check --stdin --hook kiro; echo $?   # 0 (plain path: 2)
  cp reapplied.py Django/db/models/sql/query.py                                # writes the real query.py
  W Django/db/models/sql/query.py c PostToolUse | dnr session confirm --stdin
  E c Stop | dnr check --worktree --hook stop; echo $?                         # 0, nothing printed
  git status --short     # M django/db/models/sql/query.py
  ```
  `django/db/models/sql/QUERY.py` passes the same way. Symlinks are handled correctly (`ln -s … q.py` blocks).
- *Fix:* use `realpathSync.native`, which returns the on-disk casing, in `realpathLoose`. On a case-insensitive filesystem, also compare `repoRelative` results case-folded. Add golden fixtures for the case-variant path and for `QUERY.py`.

**C3. The R6 "humans only" guard can be defeated from one shell command: the agent gets an allow-once grant for itself.**
- *Where:* `packages/hook/src/ancestry.ts:78-96`.
- *Why it fails:* the chain check stops at the first shell without `-c`. It looks for `kiro-cli` only among live ancestors, and the Kiro variables only in the environment. A process that double-forks is re-parented to launchd. It can clear its environment and open its own pty with `bash -i` in it, and so it passes all three checks. guard-shell R6 only inspects commands whose argv0 is `dnr`, so a `python3 -c` body is never looked at.
- *Repro:* `scripts/escape.py` is the 25-line double-fork plus `pty.fork()` in my scratchpad. Inline it as `python3 -c` in a real attack. Run it under a fake `kiro-cli` parent that sets `KIRO_SESSION_ID`:
  ```bash
  kiro-cli "python3 escape.py 'cd $PWD && dnr allow dnr-43933a1dca' 0 out0"   # control, no daemon: "refused inside an agent session (KIRO_SESSION_ID is set)"
  kiro-cli "python3 escape.py 'cd $PWD && dnr allow dnr-43933a1dca' 1 out1"   # daemonized: "DNR: allowed dnr-43933a1dca once …"
  ls .dnr/grants   # dnr-43933a1dca.pending.json, then claimed by the agent's next session
  ```
  Once the grant is claimed, pre-write *and* guard-shell R2–R5 stop applying to that order (`shell.ts:433`), as designed for a real grant. The same escape runs `dnr orders retire` or `dnr board`.
- *Fix:* process ancestry can't separate an agent from a human who is the same OS user.
  1. Make an approval need something an agent can't produce. Grants are created only in the browser board after the human types a short code shown on the board page; the agent can't read the browser. Or require OS user presence (macOS LocalAuthentication / Touch ID, or `sudo -v` where it needs a password).
  2. Keep `dnr allow` only as a request: it prints "approve in the board".
  3. Record a grant created while an agent session is active, and show it in the next block message, at Stop, and in the board's audit panel.
  4. Rewrite `docs/threat-model.md` to call the ancestry check a speed bump, not a boundary.
  5. Add this repro as a test that is expected to stay refused once the fix lands.

### High

**H1. `mode: "record"` in the repo config silently turns enforcement off and hides the tamper report.**
- *Where:* `packages/schemas/src/config.ts` accepts `record` in the repo config. In `packages/hook/src/stop.ts:60-67`, `force()` returns OK in record mode, *including for the orders-hash report*.
- *Repro:*
  ```bash
  python3 -c "open('.dnr/config.json','w').write('{\"mode\":\"record\"}')"
  ```
  The pre-write re-application exits 0, and Stop exits 0 with no report. A valid weaker config such as `{"threshold":1,"side_min":1}` or `{"mode":"warn-only"}` *is* reported once by Stop, but only after the write has landed.
- *Fix:*
  - Accept `record` only from `DNR_MODE`, as §7 says ("record is trial-only"), never from `.dnr/config.json`.
  - Make the orders-hash report ignore the mode.
  - Pre-write should load the config from the committed tree, as in the C1 fix, so a working-copy edit can't weaken the session that is running.

**H2. The protect tier has holes: `.git/config`, deleting a parent directory, and git config from the environment.**
- *Where:* `packages/hook/src/prewrite.ts:59-73` and `shell.ts` R1 and R8.
- *Repro:* each of these exits 0.
  - `fs_write` on `.git/config`: lets the agent write `[core] hooksPath=/dev/null` or an `[alias]`.
  - `rm -rf .kiro` and `find .kiro -delete`: they delete `.kiro/hooks` through its parent directory.
  - `GIT_CONFIG_PARAMETERS="'core.hooksPath=/dev/null'" git commit -m x`.
  - `python3 -c "import os; os.remove('.kiro/hooks/dnr-pre-write.json')"`.
  - `fs_write` on `.kiro/steering/dnr.md`: deletes the "don't route around" steering.
- *Fix:*
  - Protect `.git/config` and `$GIT_DIR/config.worktree`.
  - In R1, deny a path that is an *ancestor* of a protected glob (`.kiro`, `.git`, `.dnr`), not only paths under it.
  - Make R8 deny the `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT` and `GIT_CONFIG_KEY_*` assignments.
  - Add `.kiro/steering/dnr.md` to the protected globs. This is a plan change: list it in §5.4.
  - Interpreter writes stay out of reach. The real fix there is C1's "read the committed copy".

**H3. guard-shell R2–R5 are easy to get around. Stop catches the result, but only afterwards and only advisorily.**
- *Where:* `packages/hook/src/shell.ts:136-350`.
- *Repro:* `O=ea3a71c2d0…`, `F=django/db/models/sql/query.py`.

  | Command | guard-shell |
  |---|---|
  | `git cherry-pick $O`, `-n ea3a71c`, `^0`, `--no-pager`, `-C .`, `sh -c "…"` | exit 2 |
  | `git -c alias.pp=cherry-pick pp $O` | exit 0 |
  | `X=$O; git cherry-pick $X` | exit 0 |
  | `git cherry-pick $(git rev-parse ea3a71c2d0)` | exit 0 |
  | `g=git; $g cherry-pick $O` | exit 0 |
  | `git cherry-pick :/Removed.faulty.clearing` | exit 0 |
  | `git show $O:$F \| tee $F` | exit 0 |
  | `git cat-file -p $O:$F > $F` | exit 0 |
  | `git restore -s$O $F` (attached short option) | exit 0 |
  | `git checkout $O $F` (no `--`) | exit 0 |
  | `git archive $O $F \| tar -x` | exit 0 |
  | `eval "git cherry-pick $O"`, `echo "…" \| sh` | exit 0 |
  | `python3 -c "subprocess.run(['git','cherry-pick',…])"` | exit 0 |
  | `cp $(which dnr) /tmp/d; /tmp/d allow …` | exit 0 (the ancestry check then refuses it, unless C3) |
  | `python3 -c "…os.system('osascript …')"` | exit 0 |
  | `open x.command` | exit 0 |
  | `python3 -c "urlopen('http://127.0.0.1:%d/' % (4300+17))"` | exit 0 (R7) |

  I ran a full session for `git checkout $O $F` and for the `-c alias` cherry-pick. Stop forced a turn both times, so the backstop works. But `git cherry-pick` (without `-n`) *commits*, and cherry-pick doesn't run the pre-commit hook, so the re-application is already in history when Stop asks the agent to undo it.
- *Fix:*
  1. Cheap catches:
     - parse `git -c alias.*`;
     - resolve `:/msg` and any rev that `git rev-parse` resolves;
     - accept `-s<rev>`;
     - treat `checkout <rev> <path>` without `--` as R5;
     - treat `cat-file -p <orig>:` and `archive <orig>`, together with any write, as R5;
     - deny `eval` and `| sh` / `| bash` with a git body.
  2. More important: have `dnr session shell-after` (PostToolUse) score the touched files *straight away* and print the Stop-style "undo your edits to …" message right after the shell call, instead of waiting for Stop. PostToolUse output reaches the agent.
  3. Add a `post-commit` or `reference-transaction` git hook that runs `dnr check --commit HEAD`, so cherry-pick commits are flagged too.

**H4. The board launch nonce sits in `open`'s argv, so `ps` can read it.**
- *Where:* `packages/cli/src/commands/board.ts:17-19` runs `spawn('open', [url])` with `url = http://127.0.0.1:<port>/launch?n=<nonce>`.
- *Effect:* a same-user process that polls `ps -A -o command` can use the nonce before the browser does. The nonce is single-use for 60 s, so the agent then holds the session cookie, and the browser sees "launch link expired".
- *Repro:* the plan forbids printing the nonce (AUTH-08). I did not race it live, but the argv is plain from the code.
- *Fix:* open `http://127.0.0.1:<port>/launch` with no nonce. The board serves a page that asks the human to type a 6-character code that `dnr board` prints to its own TTY, which is never in argv or a file. Or open a 0600 temporary HTML file holding the nonce, and delete it after the first request. Note the remaining same-user cookie-jar limit in the threat model.

### Medium

**M1. Spec ticks claim work that hasn't happened.**
- *Where:* `.kiro/specs/dnr-check/tasks.md`.
  - `:91`: task 4.2 "Tool adapters **from the S2 captures**" is ticked, but no S2 capture exists; every fixture is marked provisional.
  - `:12`: 0.3 is ticked with "first green run pending".
  - All 24 ticked tasks have `commit: pending`, so none traces to a commit. Wave 1's M2 is still open.
- *Effect:* a Kiro judge who reads the tasks will see the gap.
- *Fix:* untick 4.2 until S2 runs (or reword it as "provisional adapters, field aliases"), untick 0.3 until CI has a green run, and fill every `commit:` slot with its SHA.

**M2. P9 checks the Playground against itself, not against the hook.**
- *Where:* `apps/playground/tests/parity.spec.ts` compares `@dnr/ui/engine` (`packages/ui/src/engine/session.ts`, 248 lines that re-implement the session flow) in the browser with the same code in node. `dnr check --file` now exists, but it is not a third source.
- *Effect:* nothing guarantees that the Playground's BLOCK/WARN decisions equal what the shipped hook does.
- *Fix:* add `dnr check --file` (or `runPreWrite` on the preset writes) as the reference in `parity.spec.ts`, as its own comment says.

**M3. The main demo case is missing its held-out paraphrase preset.**
- *Where:* `apps/playground/public/cases/43933a1dca.json` has 3 presets: C, a hard negative, and formatting only. There is no `held-out-paraphrase`, and no reason is recorded. Phase 7 allows omitting only the two-file preset, and only with a reason. `export-case.ts` has uncommitted changes in the working tree, so this may be in progress.
- *Fix:* generate the `extract-helper` seed-2000 mutant for `Query.clear_ordering`. If the operator doesn't apply, record that in the bundle and show "not applicable" in `/play`.

**M4. The hosted `/trial` page shows sample numbers that look real.**
- *Where:* `apps/playground/public/data/trial.sample.json` holds K = 6, X = 5, S = 3, W_L = 1, D2, κ 0.7, held-out recall 0.8. There is a "SAMPLE DATA, not results" banner and a "(sample)" suffix (`Trial.tsx:96`).
- *Effect:* a screenshot or a skim still shows "5 of 6 / 3 of 6 / 1 of 6" and "Decision row D2". The demo will be in front of judges before the trial runs.
- *Fix:* ship the "No trial data yet" empty state on the deployed Playground, and serve the sample only at `/trial?sample=1`, with every number shown as "#" or striped.

**M5. A Phase 5 deliverable is missing.**
- *Where:* `dnr trial falsealarm` exits 69 (`packages/cli/src/commands/trial.ts`). Phase 5 lists it next to `check --commit`, because tuning and gate check 3 need it.
- *Fix:* build it before Phase 10 work starts.

**M6. The agent can read the A/R tokens, so the MCP's restriction protects nothing.**
- *Where:* `.dnr/orders/*.json` is committed and readable.
- *Effect:* an adversarial agent can tune a paraphrase to land under τ. `explain_function` hiding A/R doesn't change that.
- *Fix:* say it in `docs/threat-model.md`. Proximity and held-out recall are the mitigation; hiding tokens is not.

**M7. The README is now stale in the other direction.**
- *Where:* `README.md:9` says "The hook path is being built", and the sample block output is still marked "illustrative".
- *Effect:* the hook is built and measured, and `dnr demo` prints the real block.
- *Fix:* paste real `dnr demo` output, and say "hook path built; trial not run".

### Low

- **L1.** `dnr trial mine --help` exits 70 with a stack trace. It should print usage (0) or exit 64.
- **L2.** The unknown-tool warn message reads "covers a unit it covers, which this write changes". The qualname or file is missing.
- **L3.** The pre-commit message says "staged changes re-applies". Fix the grammar.
- **L4.** The hooks and the pre-commit shim call bare `dnr` (S8 pending). `dnr doctor` checks that it resolves, which is good. Keep the absolute-path fallback ready.

## What holds

- **Block path.** `reapply-43933a1dca` exits 2 with the exact §6 three-line stderr (reason line first, under 1,200 characters, `dnr board --open` and `dnr allow` named) at edit 1.00 in `Query.clear_ordering`. These path forms block too: absolute, `./`, `..` and symlinked.
- **Decision formats.**
  - `ask` exits 0 with `hookSpecificOutput.permissionDecision: "ask"`.
  - The protect tier exits 2 in deny format and is case-insensitive.
  - Hard negatives give `warn_block` and then `warn_pass`.
  - `str_replace` with several matches is allowed.
  - Unknown tools go to the warn tier.
  - `warn-only` and `commit-enforce` pre-write warn once, then pass.
  - Record mode exits 0 with outcome `record`.
  - Invalid stdin exits 0.
  - CLI usage errors exit 64; stub trial commands exit 69.
- **Ask flow.** `ask` → PostToolUse `ask_approved` → grant. Stop then allows, and `--staged` passes as `allow_grant` (R13 and P13, verified live).
- **Stop.** A shell re-application forces a turn with the right message; Stop forces at most 2 turns, then allows.
- **Board auth.** The board server (`apps/board/src/server.ts`) does what §10 says:
  - Host check → 421;
  - cookie `HttpOnly; SameSite=Strict; Path=/api`, host-only, with a random value;
  - single-use nonce and ticket with a 60 s TTL;
  - mutating routes need `Origin` equal to `http://<host>` and `X-DNR-CSRF: 1`;
  - CORS on health and ping only for the Playground origin, plus ACAPN.
- **MCP.** It returns no A/R tokens.
- **Fixtures.** The golden fixtures use exactly the 01-research top-level fields (`hook_event_name`, `cwd`, `session_id`, `tool_name`, `tool_input`). Each is marked "provisional until S2", which is honest.
- **Performance.** `reports/perf.md` is honest. It says hyperfine was missing and what was measured instead, and my rough timings agree.
- **Synthetic content is labelled.** The synthetic TS case is tagged "synthetic" in `/play`. Graveyard states marked "illustrative" are labelled.
