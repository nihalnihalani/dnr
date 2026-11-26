/**
 * §9.3: while waves run, `chmod 000` makes the ticket text, sealed results, labeling inputs and
 * every source clone unreadable to agents (same OS user). Original modes are saved to
 * `$TRIAL_ROOT/lockdown.json` first, so a crashed wave can be restored with `trial run --unlock`.
 */
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface LockEntry {
  path: string;
  mode: number;
}

export function lockdownTargets(p: {
  root: string;
  djangoSrc: string | null;
  secondSrc: string | null;
  trialRoot: string;
}): string[] {
  return [
    join(p.root, 'fixtures/discussion'),
    join(p.root, 'reports/sealed'),
    join(p.root, 'reports/labeling'),
    p.djangoSrc,
    p.secondSrc,
    join(p.trialRoot, 'syn-src'),
  ].filter((x): x is string => !!x && existsSync(x));
}

export async function lock(
  targets: readonly string[],
  file: string,
  log: (m: string) => void = () => {},
): Promise<LockEntry[]> {
  if (existsSync(file))
    throw new Error(`${file} exists: a previous lockdown was not restored (run \`dnr trial run --unlock\`)`);
  const entries = targets.map((path) => ({ path, mode: statSync(path).mode & 0o7777 }));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(entries, null, 2)}\n`);
  for (const e of entries) {
    chmodSync(e.path, 0o000);
    log(`lockdown: chmod 000 ${e.path} (was ${e.mode.toString(8)})`);
  }
  return entries;
}

export async function unlock(file: string, log: (m: string) => void = () => {}): Promise<number> {
  if (!existsSync(file)) return 0;
  const entries = JSON.parse(readFileSync(file, 'utf8')) as LockEntry[];
  for (const e of entries) {
    chmodSync(e.path, e.mode);
    log(`lockdown: restored ${e.path} to ${e.mode.toString(8)}`);
  }
  await rm(file);
  return entries.length;
}
