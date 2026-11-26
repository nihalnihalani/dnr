/** `dnr check` (§8): --stdin --hook kiro|stop, --worktree, --staged, --commit, --file, --replay. */
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  blockText,
  type CrossingFinding,
  checkCommit,
  checkFile,
  checkStaged,
  checkWorktree,
  failOpen,
  formatReplay,
  replayEvents,
  runStop,
  stagedOrderWeakening,
  warnMessage,
} from '@dnr/hook';
import { parse, str } from '../args';
import { repoContext } from '../context';
import { EXIT, usage } from '../errors';
import type { CliIO } from '../io';

const OPTS = {
  stdin: { type: 'boolean' },
  hook: { type: 'string' },
  'max-forced-turns': { type: 'string' },
  worktree: { type: 'boolean' },
  staged: { type: 'boolean' },
  commit: { type: 'string' },
  config: { type: 'string' },
  file: { type: 'string' },
  proposed: { type: 'string' },
  replay: { type: 'string' },
  canonical: { type: 'boolean' },
  'git-dir': { type: 'string' },
  json: { type: 'boolean' },
} as const;

export const CHECK_HELP = `dnr check --stdin --hook kiro             PreToolUse write hook
dnr check --worktree [--hook stop --max-forced-turns 2]   whole-order check / Stop backstop
dnr check --staged                        pre-commit (crossing rule, blob-matched grants)
dnr check --commit <sha> [--config <p>]   crossing against X^; re-landed flagged
dnr check --file <rel> --proposed <path>  direct check
dnr check --replay <events.jsonl> [--canonical] [--git-dir <working copy>]`;

function printFindings(io: CliIO, label: string, fs: CrossingFinding[], json: boolean): number {
  const crossing = fs.filter((f) => f.crossing && !f.granted);
  if (json) io.out(`${JSON.stringify(fs, null, 2)}\n`);
  else {
    for (const f of fs) {
      if (f.crossing)
        io.err(
          `DNR: ${label} ${/changes$/.test(label) ? 're-apply' : 're-applies'} ${f.order_id} (edit ${f.edit.toFixed(2)}, was ${f.parent_edit.toFixed(2)})${f.qualnames.length ? ` in ${f.qualnames.join(', ')}` : ''}${f.granted ? ' — allowed by a used grant' : ''}\n`,
        );
      else if (f.relanded)
        io.err(
          `DNR: ${f.order_id} is re-landed (already matched before ${label}); it only warns until re-approved\n`,
        );
    }
    if (crossing.length === 0 && !fs.some((f) => f.relanded)) io.out(`DNR: ${label}: no order crossed.\n`);
  }
  return crossing.length;
}

export async function cmdCheck(argv: string[], io: CliIO): Promise<number> {
  const { values: v, positionals } = parse(argv, OPTS);
  if (v.help) {
    io.out(`${CHECK_HELP}\n`);
    return EXIT.OK;
  }
  if (positionals.length) throw usage(`dnr check: unexpected argument ${positionals[0]}`);
  const write = (r: { exitCode: number; stdout: string; stderr: string }) => {
    if (r.stdout) io.out(r.stdout);
    if (r.stderr) io.err(r.stderr);
    return r.exitCode;
  };

  if (v.stdin) {
    const hook = str(v.hook) ?? 'kiro';
    const stdin = await io.readStdin();
    if (hook === 'kiro') {
      // Fast path for the write hook: load only the pre-write module (latency, R8).
      const { runPreWrite: run } = await import('@dnr/hook/prewrite');
      return write(await run(stdin, { env: io.env, cwd: io.cwd }));
    }
    if (hook === 'stop') {
      const max = v['max-forced-turns'] ? Number(v['max-forced-turns']) : undefined;
      return write(
        await runStop(stdin, {
          env: io.env,
          cwd: io.cwd,
          ...(max !== undefined ? { maxForcedTurns: max } : {}),
        }),
      );
    }
    throw usage(`dnr check: unknown --hook ${hook} (kiro or stop)`);
  }

  if (v.worktree && v.hook === 'stop') {
    // Kiro sends the Stop event on stdin.
    const stdin = await io.readStdin().catch(() => '{}');
    const max = v['max-forced-turns'] ? Number(v['max-forced-turns']) : undefined;
    return write(
      await runStop(stdin || '{}', {
        env: io.env,
        cwd: io.cwd,
        ...(max !== undefined ? { maxForcedTurns: max } : {}),
      }),
    );
  }
  if (v.hook) throw usage('dnr check: --hook needs --stdin (kiro) or --worktree (stop)');

  if (v.staged) {
    // Pre-commit fails open like every hook mode (§5.12).
    let code = 0;
    const r = await failOpen('pre-commit', '{}', { env: io.env, cwd: io.cwd }, async () => {
      const ctx = await repoContext(io, { ...(v.config ? { config: str(v.config) as string } : {}) });
      const n = printFindings(io, 'the staged changes', await checkStaged(ctx), !!v.json);
      const weakened = await stagedOrderWeakening(ctx);
      for (const id of weakened)
        io.err(
          `DNR: the staged changes remove or weaken order ${id} without a human-attested change (run the change through \`dnr orders …\`).\n`,
        );
      const mode = ctx.config.mode;
      // Weakening an order is refused in every mode except record (wave-3 N3).
      code =
        (n > 0 && (mode === 'enforce' || mode === 'commit-enforce')) ||
        (weakened.length > 0 && mode !== 'record')
          ? EXIT.FINDINGS
          : EXIT.OK;
      if (n > 0 && code === EXIT.FINDINGS)
        io.err(
          'DNR: commit blocked. A human maintainer can approve the re-land with `dnr allow <id>` or `dnr board`.\n',
        );
      return { exitCode: code, stdout: '', stderr: '' };
    });
    return r.exitCode;
  }

  if (v.commit) {
    const ctx = await repoContext(io, {
      ...(v.config ? { config: resolve(io.cwd, str(v.config) as string) } : {}),
    });
    const n = printFindings(
      io,
      `commit ${str(v.commit)?.slice(0, 10)}`,
      await checkCommit(ctx, str(v.commit) as string),
      !!v.json,
    );
    return n > 0 ? EXIT.FINDINGS : EXIT.OK;
  }

  if (v.worktree) {
    const ctx = await repoContext(io);
    return printFindings(io, 'the working tree', await checkWorktree(ctx), !!v.json) > 0
      ? EXIT.FINDINGS
      : EXIT.OK;
  }

  if (v.file || v.proposed) {
    if (!v.file || !v.proposed) throw usage('dnr check --file <rel> --proposed <path>');
    const ctx = await repoContext(io);
    const proposed = resolve(io.cwd, str(v.proposed) as string);
    if (!existsSync(proposed)) throw usage(`dnr check: --proposed ${proposed} does not exist`);
    const r = await checkFile(ctx, str(v.file) as string, proposed, io.cwd);
    let stderr = '';
    if (r.order && (r.decision.outcome === 'block' || r.decision.outcome === 'ask'))
      stderr = blockText(r.order, r.decision, { qualnames: r.qualnames, threshold: ctx.config.threshold });
    else if (r.order && r.decision.outcome === 'warn_block')
      stderr = warnMessage(r.order, r.decision, {
        qualnames: r.qualnames,
        threshold: ctx.config.threshold,
        downgraded: r.decision.fired_by !== null,
      });
    io.out(`${JSON.stringify({ decision: r.decision, stderr }, null, 2)}\n`);
    return ['block', 'warn_block', 'ask'].includes(r.decision.outcome) ? EXIT.FINDINGS : EXIT.OK;
  }

  if (v.replay) {
    const ctx = await repoContext(io);
    const file = resolve(io.cwd, str(v.replay) as string);
    if (!existsSync(file)) throw usage(`dnr check --replay: ${file} does not exist`);
    let gitDir = v['git-dir'] ? resolve(io.cwd, str(v['git-dir']) as string) : ctx.repoRoot;
    if (existsSync(join(gitDir, '.git')) && statSync(join(gitDir, '.git')).isDirectory())
      gitDir = join(gitDir, '.git');
    io.out(formatReplay(await replayEvents(ctx, file, gitDir), !!v.canonical));
    return EXIT.OK;
  }
  throw usage(`dnr check: choose a mode\n${CHECK_HELP}`);
}
