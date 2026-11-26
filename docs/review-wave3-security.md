# Wave 3 security re-attack (b3f4301, 292e43b, bd3ebb2)

This is the devil's advocate's re-test, run on November 26, 2026. I re-ran every reproduction in `docs/review-wave2.md` against HEAD (`292e43b`), then attacked the new layers: trusted committed state, the tamper report, post-shell scoring, and grant origin.

I used the same method as wave 2:
- a clean clone of HEAD in my scratchpad, with the built `dnr`;
- a `--shared` Django clone at `43933a1dca`, `dnr init` and `dnr orders approve` run by a human in a pty;
- hook stdin events in the 01-research shape.

Everything ran in scratch copies. The new teammates' work (`packages/trial`, `dnr-crew`) is not reviewed here.

## Re-run of wave 2

| Wave-2 finding | Result at HEAD |
|---|---|
| C1. An invalid config means every hook fails open | **Fixed.** `{"threshold":2}` falls back to the defaults; pre-write blocks (exit 2) and Stop reports the tamper |
| C1. A corrupt session file means fail-open | **Fixed.** The session is rebuilt with the committed tree as baseline; pre-write blocks and Stop reports it |
| C2. Case-variant path (`Django/…`, `QUERY.py`) | **Fixed.** Both exit 2 |
| C3. The R6 guard escape | **Partly fixed.** The grant is still created, now flagged `suspect`. It still lets the write through (finding N5) |
| H1. `mode: "record"` in the config | **Fixed.** Defaults are used and Stop reports it |
| H2. Writes to `.git/config` and `.kiro/steering/dnr.md`; `rm -rf .kiro`; `find .kiro -delete`; `GIT_CONFIG_PARAMETERS` | **Fixed.** All exit 2 |
| H3. guard-shell catalog: alias, variable, `$g`, `tee`, `cat-file`, `restore -s<sha>`, `checkout <sha> <path>`, `archive \| tar`, `eval`, `\| sh`, `open x.command` | **Fixed.** All exit 2 |
| H3. `git cherry-pick $(git rev-parse ea3a71c2d0)` and `:/msg` | Still allowed by guard-shell. post-shell now catches the result straight away, committed or not (N6) |
| H4. The board nonce in argv | **Fixed.** It moved to a 0600 temp file. A same-user process can still read it (N7) |

Things I checked that hold:
- post-shell scores after every shell call. After an uncommitted `cherry-pick -n` it prints "the shell command you just ran re-applies dnr-43933a1dca…". After a committing cherry-pick it prints "the commit you just made (a8177a8c08) re-applies…".
- `.gitattributes` tricks (`*.py -diff`, a `diff=` driver) don't fool `dnr check --staged`, which still exits 1.
- Fast path: three runs of `scripts/bench-hook.mjs --runs 50` gave p95 70.7, 67.5 and 71.0 ms (p50 about 65 ms), at load average about 2.4. The match case gave p95 158 to 172 ms. The `reports/perf.md` claim of 79.2 ms "on a quiet run" is conservative for this machine, but there is little margin, and the report itself says p95 reaches 79 to 122 ms under load. A Linux CI number is still owed.

## New findings

### Critical

**N1. One write-tool call to `.git/HEAD` breaks git, and every hook fails open again.**
- *Where:* the protect tier (`packages/hook/src/prewrite.ts`) covers `.git/config`, `config.worktree` and the hooks directory, but not the rest of `$GIT_DIR`. When a git call fails, `failopen.ts` exits 0. The amended R7 covers tampered DNR *state*, not a broken repository.
- *Repro:* no shell is needed.
  ```bash
  E i1 SessionStart | dnr session start --stdin
  # agent: fs_write .git/HEAD "garbage"   → pre-write on .git/HEAD exits 0 (not protected)
  printf 'garbage\n' > .git/HEAD
  W django/db/models/sql/query.py i1 | dnr check --stdin --hook kiro; echo $?   # 0; hook.log: error_open … Command failed: git …
  E i2 SessionStart | dnr session start --stdin   # a new session: still exit 0, same error_open
  E i2 Stop | dnr check --worktree --hook stop     # silent
  # agent then restores .git/HEAD; the re-application has landed and nothing reported it
  ```
  `.git/refs/heads/<branch>` is writable the same way, and so are `git update-ref`, `git reset --hard` and `git commit-tree` from the shell.
- *Fix:*
  1. Protect all of `$GIT_DIR/**` (via `git rev-parse --git-dir` and `--git-common-dir`) from write tools. An agent never needs `fs_write` inside `.git`.
  2. Treat "git fails inside a repository that has DNR hooks or orders" as tampering, not as a DNR bug:
     - load orders from the working copy as a fallback;
     - block or warn writes to covered files;
     - have Stop report "the git repository is unusable".
  3. Extend the R7 amendment to cover it.

**N2. The agent's write tool can overwrite DNR's own code and the shell startup files.**
- *Where:* the protect tier has no entry for DNR's installation or the hook shell's startup files.
- *Repro:* every one of these is allowed by pre-write (exit 0):
  - `fs_write` on the resolved `dnr` bundle (`realpath $(which dnr)`, i.e. `…/dist/cli.js`);
  - on the `dnr` on PATH;
  - on `~/.local/bin/dnr`;
  - on `~/.zshenv` and `~/.bashrc`.

  Overwriting `cli.js` with a script that exits 0 turns off every hook, Stop and pre-commit with one write and no shell. If Kiro runs hook commands through `zsh -c` (S8 is pending), `~/.zshenv` is sourced for every hook, and a function or a PATH entry there replaces `dnr`. The hooks still call bare `dnr` (`dnr init` output: `"command": "dnr check --stdin --hook kiro"`), so a shim earlier on PATH works too.
- *Fix:*
  1. Add to the protected set:
     - the realpath of the running CLI's package directory;
     - the `dnr` that PATH resolves to;
     - `~/.zshenv`, `~/.zprofile`, `~/.zshrc`, `~/.bash_profile`, `~/.bashrc`, `~/.profile`.
  2. Have `dnr init` write absolute `node` and `cli.js` paths into the hooks and the pre-commit shim.
  3. Have `dnr doctor` and Stop check the bundle's sha256 against the one recorded at `dnr init`.
  4. Strongest: have `dnr init` also install a Kiro permission policy that denies the agent's file-write tools outside the workspace and under `.dnr/` and `.git/`. Kiro enforces that policy itself, so a broken DNR can't switch it off.
  5. State in `docs/threat-model.md` that a same-user process that is actively hostile can always beat a same-user hook. DNR's target is an agent that re-applies a change by mistake or under task pressure, plus visible evidence when it routes around DNR.

**N3. A tamper is reported once, then becomes the next session's normal state.**
- *Where:* `packages/hook/src/trusted.ts:112-168` and `context.ts`.
  - Orders that exist only in the working copy are "used as they are". That is the default after `dnr init` and `orders approve`, until a maintainer commits `.dnr/`.
  - A committed order set is trusted exactly as it is in HEAD, and HEAD is under the agent's control.
  - The Stop report is one-shot, and a new session takes whatever state it finds as its baseline.
- *Repro 1, orders not committed:*
  ```bash
  E f1 SessionStart | dnr session start --stdin
  python3 -c "…o['status']='retired'…"                     # or delete the file, or `git stash -u` / `git clean -fdx`
  W django/db/models/sql/query.py f1 | dnr check …; echo $?  # 0: the write lands in the same session
  E f1 Stop | dnr check --worktree --hook stop               # one tamper report, after the write landed
  E f2 SessionStart | …; W … f2 | dnr check …; echo $?        # next session: 0, Stop silent
  ```
- *Repro 2, orders committed by the maintainer:* the agent runs `python3 -c …retired…`, then `git add -A && git commit -m tidy`, or `git commit -am tidy`.
  - guard-shell allows both commands: `git add -A .dnr` *is* denied, but the plain forms are not.
  - pre-commit says "no order crossed" and lets the commit through.
  - HEAD now has `"status":"retired"`. The same session blocks nothing and gets one tamper report; the next session is silent.
  - `git reset --hard HEAD~1` on the maintainer's order commit, and `git update-ref`, have the same effect. Both are allowed.
- *Fix:* make removing enforcement monotonic, and possible only through a human command.
  1. The enforced set is the **union** of approved orders in the session-start set, HEAD, the working copy, and the last set recorded by a guarded human `dnr` command. Record that last set in an append-only `.dnr/attest.jsonl`, committed by `dnr orders approve`, `retire` and the board.
  2. Any weakening that isn't in the attest log opens a **persistent tamper flag**. It carries across sessions until a human runs `dnr orders verify --accept`. While it is open, writes to covered files *block* rather than allow.
  3. pre-commit refuses a commit that removes or weakens anything under `.dnr/` unless its attest entry exists.
  4. guard-shell denies `git reset`, `update-ref`, `stash -u` and `clean -x` when they would touch `.dnr/`.

### High

**N4. An agent's re-land commit permanently downgrades the order to "re-landed".**
- *Where:* re-landed is derived from match(HEAD) against the snapshot (§5.9), and Stop skips re-landed orders.
- *Repro:*
  - The agent runs `git cherry-pick $(git rev-parse ea3a71c2d0)`, which guard-shell allows.
  - post-shell flags the commit once, and Stop then stays silent.
  - From then on `dnr orders show dnr-43933a1dca` prints `status approved (effective relanded)`, and later sessions only warn.
- *Fix:* count a commit as a re-land only if it was made outside an agent session, or under a grant that applies (its blobs match a used grant). Otherwise derive a new state, `violated`:
  - it keeps enforcing and is shown on the board with the commit SHA;
  - Stop repeats it every session until a human re-approves the order or reverts the commit.

  This may need a plan amendment to §5.9.

**N5. A suspect grant still lets the write through.**
- *Where:* `packages/hook/src/grant-origin.ts`, plus the grant check in pre-write.
- *Repro:* I re-ran the wave-2 C3 harness unchanged. `dnr allow` now prints "this grant is flagged suspect (active-session:…)" and writes `origin.suspect: true`. The next pre-write of the re-application then returns `allow_grant`, exit 0. Stop reports the suspect grant only after the write has landed.
- *Second problem:* the suspect markers are "some Kiro session is active". A maintainer working next to an open Kiro session, which is the normal case, will get every real grant flagged, so the flag turns into noise.
- *Fix:*
  1. A suspect grant does not apply until a human confirms it on the board, which shows a code the agent can't see.
  2. Base suspicion on the *creating process*: no controlling terminal shared with a login session, a parent that is launchd or init, or a cleared environment. Not on whether any session exists.

### Medium

**N6. guard-shell still misses two forms of revision.**
- *Where:* `$(…)` substitutions and `:/<regex>` revisions in R2–R5.
- *Effect:* post-shell now catches the result straight away, including commits (verified), so this is defence in depth only.
- *Fix:* evaluate simple `$(git rev-parse …)` substitutions, and resolve `:/…` through `env.resolve`.

**N7. The board nonce is still readable by a same-user process.**
- *Where:* the 0600 temp HTML file (`packages/cli/src/commands/board.ts:26-40`). An agent running as the same user can read `$TMPDIR/dnr-board-*/open.html` before the browser loads it.
- *Fix:* have the human type a short code that `dnr board` prints to its own TTY. Otherwise, document this in the threat model as the same-user limit.

**N8. The fast path has almost no margin.**
- *Where:* every pre-write now spawns `git ls-tree` (`trusted.ts:104`).
- *Effect:* p95 was 67 to 71 ms here and up to 122 ms under load, against an 80 ms target.
- *Fix:* read HEAD's `.dnr` tree straight from the object store, or skip the spawn when the target file isn't covered by any working-copy order *and* `.dnr` has no tracked files. Get the Linux CI number before freezing R8.

### Low

- **L1.** `node scripts/bench-hook.mjs --help` throws `ERR_PARSE_ARGS_UNKNOWN_OPTION` with a stack trace.

## Out of scope by design (noted, not findings)

- **Linked worktrees and second clones.** Writes outside the repository root are not checked by pre-write. Bringing them back into the repo needs a shell `merge` or `cp`, which post-shell scores straight away. A push from a second clone skips every local layer; the Crew/CI `dnr` check is the net for that.
- **Symlinked `.dnr` and `mv .dnr`.** Both are denied by R1, and committed orders are read from HEAD anyway.
