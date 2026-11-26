/**
 * `dnr doctor` (§8): node, git, the grammar ABI, the hook JSON, the `dnr` command as hooks see it
 * (it must resolve on PATH), the kiro-cli version, and the board port. Exit 0 when all pass.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { findRepoRoot } from '@dnr/git';
import { installMismatch, loadParser } from '@dnr/hook';
import { openStore } from '@dnr/store';
import { parse } from 'shell-quote';
import { EXIT } from '../errors';
import { DNR_HOOKS, hookJson } from '../hooks';
import type { CliIO } from '../io';
import { BEGIN, END, permissionsFile } from '../permissions';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function which(cmd: string, env: NodeJS.ProcessEnv): string | null {
  if (isAbsolute(cmd)) return existsSync(cmd) ? cmd : null;
  for (const dir of (env.PATH ?? '').split(':')) if (dir && existsSync(join(dir, cmd))) return join(dir, cmd);
  return null;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
  });
}

export async function cmdDoctor(argv: string[], io: CliIO): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out('dnr doctor   check node, git, grammars, hooks, PATH, kiro-cli and the board port\n');
    return EXIT.OK;
  }
  const checks: Check[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node', ok: major >= 24, detail: `v${process.versions.node} (need ≥ 24)` });
  try {
    checks.push({
      name: 'git',
      ok: true,
      detail: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
    });
  } catch {
    checks.push({ name: 'git', ok: false, detail: 'git not found' });
  }
  try {
    const p = await loadParser();
    p.parse('python', 'def f():\n    return 1\n').delete();
    checks.push({ name: 'grammars', ok: true, detail: 'python, typescript and tsx load (ABI ok)' });
  } catch (e) {
    checks.push({ name: 'grammars', ok: false, detail: String((e as Error).message) });
  }
  const root = findRepoRoot(io.cwd);
  if (!root) checks.push({ name: 'repo', ok: false, detail: `${io.cwd} is not in a git repository` });
  else {
    for (const h of DNR_HOOKS) {
      const p = join(root, '.kiro', 'hooks', `${h.name}.json`);
      if (!existsSync(p)) {
        checks.push({
          name: `hook ${h.name}`,
          ok: h.name === 'dnr-session-start',
          detail: h.name === 'dnr-session-start' ? 'not installed (optional)' : 'missing: run dnr init',
        });
        continue;
      }
      try {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        const want = hookJson(h) as { hooks: Array<{ action: { command: string } }> };
        const cmd: string = j?.hooks?.[0]?.action?.command ?? '';
        const shape =
          j.version === 'v1' &&
          j.hooks?.[0]?.trigger === h.trigger &&
          (h.matcher ? j.hooks[0].matcher === h.matcher : !('matcher' in j.hooks[0])) &&
          cmd.endsWith(want.hooks[0]?.action.command.slice(3) ?? '');
        const words = (parse(cmd) as unknown[]).filter((w): w is string => typeof w === 'string');
        const bin = words[0] ?? '';
        // Absolute `node cli.js` (wave-3 N2): both must exist; bare `dnr` must resolve on PATH.
        const script = /(^|\/)node$/.test(bin) ? words[1] : undefined;
        const resolved =
          which(bin, io.env) && (!script || existsSync(script)) ? (script ?? which(bin, io.env)) : null;
        checks.push({
          name: `hook ${h.name}`,
          ok: shape && !!resolved,
          detail: !shape
            ? 'differs from §6: run dnr init --force'
            : resolved
              ? `\`${bin}\` resolves to ${resolved}`
              : `\`${bin}\` does not resolve on PATH; hooks would fail open`,
        });
      } catch (e) {
        checks.push({ name: `hook ${h.name}`, ok: false, detail: `invalid JSON: ${String(e)}` });
      }
    }
    const store = openStore(root, { env: io.env });
    try {
      const { config } = await store.loadConfig();
      checks.push({
        name: 'config',
        ok: true,
        detail: `mode ${config.mode}, decision_format ${config.decision_format}`,
      });
      const free = await portFree(config.board_port);
      checks.push({
        name: 'board port',
        ok: free,
        detail: `${config.board_port} ${free ? 'is free' : 'is in use'}`,
      });
    } catch (e) {
      checks.push({ name: 'config', ok: false, detail: String((e as Error).message) });
    }
  }
  if (root) {
    // Wave-3 N2: the bundle recorded at init is unchanged; Kiro's own deny rules are installed.
    const mismatch = installMismatch(root, openStore(root, { env: io.env }).paths.stateDir);
    const recorded = existsSync(join(root, '.dnr', 'install.json'));
    checks.push({
      name: 'bundle integrity',
      ok: recorded && !mismatch,
      detail: !recorded
        ? 'no .dnr/install.json: run dnr init'
        : (mismatch ?? 'the bundle matches the sha256 recorded at dnr init'),
    });
    const pf = permissionsFile(io.env);
    const text = existsSync(pf) ? readFileSync(pf, 'utf8') : null;
    const ok = !!text && text.includes(BEGIN) && text.includes(END);
    checks.push({
      name: 'kiro permissions',
      ok,
      detail: ok
        ? `DNR deny rules present in ${pf}`
        : `DNR deny rules missing from ${pf}: run dnr init (spike S17 verifies matching)`,
    });
  }
  try {
    const out = execFileSync('kiro-cli', ['--version'], {
      encoding: 'utf8',
      env: io.env,
      timeout: 5000,
    }).trim();
    const m = /(\d+)\.(\d+)/.exec(out);
    const ok = !!m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 4));
    checks.push({ name: 'kiro-cli', ok, detail: `${out} (need ≥ 3.4, 3.6 preferred)` });
  } catch {
    checks.push({ name: 'kiro-cli', ok: false, detail: 'kiro-cli not found on PATH' });
  }
  for (const c of checks) io.out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(24)} ${c.detail}\n`);
  return checks.every((c) => c.ok) ? EXIT.OK : EXIT.FINDINGS;
}
