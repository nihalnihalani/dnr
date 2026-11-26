/**
 * Trial locations (§9.3, §8 environment): ROOT (the dnr repo), TRIAL_ROOT, DJANGO_SRC,
 * SECOND_SRC. TRIAL_ROOT must be absolute, outside ROOT and not a sibling of it (TRIAL-01).
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface TrialPaths {
  root: string;
  trialRoot: string;
  djangoSrc: string | null;
  secondSrc: string | null;
  /** Where committed reports go; dry runs redirect this under TRIAL_ROOT so nothing in the repo changes. */
  reportsDir: string;
  /** Where labelers' packets live (the dnr-labeling clone). */
  labelingDir: string;
  dryRun: boolean;
}

export class TrialRootError extends Error {
  constructor(m: string) {
    super(m);
    this.name = 'TrialRootError';
  }
}

function real(p: string): string {
  // Resolve the longest existing prefix so a not-yet-created TRIAL_ROOT is still checked.
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    tail.unshift(cur.slice(up.length + (up.endsWith(sep) ? 0 : 1)));
    cur = up;
  }
  let base = cur;
  try {
    base = realpathSync.native(cur);
  } catch {}
  return tail.length ? join(base, ...tail) : base;
}

const inside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/** TRIAL-01: absolute, not inside ROOT, not containing ROOT, and not a sibling of ROOT. */
export function checkTrialRoot(root: string, trialRoot: string): void {
  if (!isAbsolute(trialRoot)) throw new TrialRootError(`TRIAL_ROOT must be absolute (got ${trialRoot})`);
  const r = real(root);
  const t = real(trialRoot);
  if (inside(t, r)) throw new TrialRootError(`TRIAL_ROOT ${t} is inside ROOT ${r}`);
  if (inside(r, t)) throw new TrialRootError(`TRIAL_ROOT ${t} contains ROOT ${r}`);
  if (dirname(t) === dirname(r)) throw new TrialRootError(`TRIAL_ROOT ${t} is a sibling of ROOT ${r}`);
}

export function trialPaths(
  env: NodeJS.ProcessEnv,
  opts: { dryRun?: boolean; root?: string } = {},
): TrialPaths {
  const root = resolve(opts.root ?? env.ROOT ?? DEFAULT_ROOT);
  const tr = env.TRIAL_ROOT;
  if (!tr) throw new TrialRootError('TRIAL_ROOT is not set (for example /var/tmp/dnr-trial)');
  checkTrialRoot(root, tr);
  const trialRoot = resolve(tr);
  const dj = env.DJANGO_SRC ?? resolve(root, '../dnr-work/django');
  const dryRun = opts.dryRun ?? false;
  return {
    root,
    trialRoot,
    djangoSrc: existsSync(join(dj, '.git')) ? resolve(dj) : null,
    secondSrc: env.SECOND_SRC && existsSync(env.SECOND_SRC) ? resolve(env.SECOND_SRC) : null,
    reportsDir: dryRun ? join(trialRoot, 'dry-reports') : join(root, 'reports'),
    labelingDir: dryRun
      ? join(trialRoot, 'dry-labeling')
      : resolve(env.DNR_LABELING_DIR ?? resolve(root, '../dnr-labeling')),
    dryRun,
  };
}

/** $TRIAL_ROOT layout (design: `$TRIAL_ROOT` layout). Run IDs contain `/`, so per-run dirs nest. */
export const layout = (tr: string) => ({
  repos: (sha: string) => join(tr, 'repos', sha),
  run: (id: string) => join(tr, 'runs', id),
  home: (id: string) => join(tr, 'homes', id),
  orders: (id: string) => join(tr, 'orders', id),
  state: (id: string) => join(tr, 'state', id),
  out: (id: string) => join(tr, 'out', id),
  envs: (sha10: string) => join(tr, 'envs', sha10),
  repo2Build: (sha10: string) => join(tr, 'repo2-build', sha10),
  synSrc: join(tr, 'syn-src'),
  config: join(tr, 'config.json'),
  manifest: join(tr, 'manifest.jsonl'),
  prepared: join(tr, 'prepared.jsonl'),
  probe: (sha10: string) => join(tr, 'probe', sha10),
  sealedKey: join(tr, 'sealed', 'packet-key.json'),
  lockdown: join(tr, 'lockdown.json'),
});
