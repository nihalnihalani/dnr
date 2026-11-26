/** `dnr check --stdin --hook kiro`: the write hook entry, importing only the pre-write module. */
import type { CliIO } from '../io';

export async function cmdCheckFast(argv: string[], io: CliIO): Promise<number> {
  const i = argv.indexOf('--hook');
  const hook = i >= 0 ? argv[i + 1] : 'kiro';
  if (hook !== 'kiro' || argv.some((a) => a.startsWith('-') && !['--stdin', '--hook'].includes(a))) {
    return (await import('./check')).cmdCheck(argv, io);
  }
  const stdin = await io.readStdin();
  const { runPreWrite } = await import('@dnr/hook/prewrite');
  const r = await runPreWrite(stdin, { env: io.env, cwd: io.cwd });
  if (r.stdout) io.out(r.stdout);
  if (r.stderr) io.err(r.stderr);
  return r.exitCode;
}
