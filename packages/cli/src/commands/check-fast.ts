/** `dnr check --stdin --hook kiro`: the write hook entry, importing only the pre-write module. */
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { committedStateArgs, findRepoRoot, memoGit } from '@dnr/git';
import type { CliIO } from '../io';

/**
 * Start the committed-state read (`git ls-tree HEAD`, wave-2 C1) while the pre-write module loads.
 * Best effort: if the arguments differ from the loader's, the loader just spawns its own.
 */
function prefetchCommitted(stdin: string, io: CliIO): void {
  try {
    const j = JSON.parse(stdin) as { cwd?: unknown };
    const cwd = typeof j.cwd === 'string' ? (isAbsolute(j.cwd) ? j.cwd : resolve(io.cwd, j.cwd)) : io.cwd;
    const found = findRepoRoot(cwd);
    if (!found) return;
    const root = realpathSync.native(found);
    const rel = (p: string) => {
      const r = relative(root, isAbsolute(p) ? p : resolve(root, p));
      return !r || r.startsWith('..') || r.startsWith(sep) ? null : r.split(sep).join('/');
    };
    const scope = [
      rel(io.env.DNR_ORDERS ?? '.dnr/orders'),
      rel(io.env.DNR_CONFIG ?? '.dnr/config.json'),
    ].filter((x): x is string => !!x);
    if (scope.length) memoGit(root, committedStateArgs(scope), [0, 128]);
  } catch {}
}

export async function cmdCheckFast(argv: string[], io: CliIO): Promise<number> {
  const i = argv.indexOf('--hook');
  const hook = i >= 0 ? argv[i + 1] : 'kiro';
  if (hook !== 'kiro' || argv.some((a) => a.startsWith('-') && !['--stdin', '--hook'].includes(a))) {
    return (await import('./check')).cmdCheck(argv, io);
  }
  const stdin = await io.readStdin();
  prefetchCommitted(stdin, io);
  const { runPreWrite } = await import('@dnr/hook/prewrite');
  const r = await runPreWrite(stdin, { env: io.env, cwd: io.cwd });
  if (r.stdout) io.out(r.stdout);
  if (r.stderr) io.err(r.stderr);
  return r.exitCode;
}
