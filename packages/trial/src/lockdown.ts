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

/**
 * Paths closed while a wave runs: the plan's list (§9.3), widened by the isolation amendment
 * (T1(f)): the dnr repo's reports/ and fixtures/ (orders, candidates, assignment), every truncated
 * repo, and the outputs, order sets, state, worktrees and HOMEs of every prepared run that is not
 * in this wave. Runs in flight stay open (the relay and the harness read them).
 */
export function lockdownTargets(
  p: { root: string; djangoSrc: string | null; secondSrc: string | null; trialRoot: string },
  inFlight: ReadonlyArray<{ run_id: string }> = [],
  prepared: ReadonlyMap<string, { run_id: string }> = new Map(),
): string[] {
  const live = new Set(inFlight.map((r) => r.run_id));
  const others = [...prepared.keys()].filter((id) => !live.has(id));
  const tr = p.trialRoot;
  return [
    ...new Set(
      [
        join(p.root, 'fixtures/discussion'),
        join(p.root, 'reports/sealed'),
        join(p.root, 'reports/labeling'),
        p.djangoSrc,
        p.secondSrc,
        join(tr, 'syn-src'),
        join(p.root, 'reports'),
        join(p.root, 'fixtures'),
        join(tr, 'repos'),
        join(tr, 'sealed'),
        ...others.flatMap((id) => ['out', 'orders', 'state', 'runs', 'homes'].map((d) => join(tr, d, id))),
      ].filter((x): x is string => !!x && existsSync(x)),
    ),
  ];
}

export async function lock(
  targets: readonly string[],
  file: string,
  log: (m: string) => void = () => {},
): Promise<LockEntry[]> {
  if (existsSync(file))
    throw new Error(`${file} exists: a previous lockdown was not restored (run \`dnr trial run --unlock\`)`);
  // Deepest first, so a parent closed earlier never blocks reaching its child; unlock reverses.
  const sorted = [...targets].sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
  const entries = sorted.map((path) => ({ path, mode: statSync(path).mode & 0o7777 }));
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
  for (const e of [...entries].reverse()) {
    chmodSync(e.path, e.mode);
    log(`lockdown: restored ${e.path} to ${e.mode.toString(8)}`);
  }
  await rm(file);
  return entries.length;
}
