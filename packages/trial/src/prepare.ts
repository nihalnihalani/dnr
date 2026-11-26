/**
 * `dnr trial prepare` (§9.3): truncated repos, per-run working copies, ancestor order sets, S
 * steering, the frozen config, and per-run HOMEs seeded and hashed. Everything lands under
 * $TRIAL_ROOT; nothing in $ROOT changes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { unitWeights } from '@dnr/core';
import { git } from '@dnr/git';
import { DnrConfig, type Order, type Pins } from '@dnr/schemas';
import { agentOf, bundleOf, modeOf, type PlannedRun, type TaskTarget, taskFor } from './arms';
import { layout, type TrialPaths } from './env';
import { type HookEnv, hashKiroDir, loadS8, seedHome } from './home';
import { gitDirOf, loadOrders, orderSetPool, type TrialCase, trialOrdersDir } from './inputs';
import { buildOrderSet } from './orderset';
import { sha256Hex } from './prng';
import { buildTruncatedRepo, checkNothingNewer, cloneRun, porcelain } from './repo';

export const UNPINNED = 'UNPINNED-DRY-RUN';

export interface Prepared {
  run_id: string;
  namespace: PlannedRun['namespace'];
  arm: PlannedRun['arm'];
  replicate: number;
  revert_sha: string;
  repo: string;
  role: string | null;
  start_sha: string | null;
  task: string;
  target: TaskTarget;
  agent: string;
  model: string;
  mode: string;
  workdir: string;
  home: string;
  orders_dir: string;
  state_dir: string;
  record_path: string;
  config_path: string;
  config_sha256: string;
  order_set: { size: number; ids: string[]; missing: string[]; approved: number; hash: string };
  home_hash_seeded: string;
  /** S8 exclusion globs used for both HOME hashes (frozen at prepare time). */
  home_exclusions: string[];
  s8_source: string;
  steering: string | null;
  provisional: boolean;
  dry_run: boolean;
  dnr_command: string[];
  prepared_at: string;
}

export interface PrepareDeps {
  /** `dnr steering generate` (renderSteering from the CLI), injected to keep @dnr/trial free of a CLI import. */
  renderSteering: (orders: Order[]) => string;
  now?: () => string;
  log?: (m: string) => void;
}

export class PrepareError extends Error {
  constructor(m: string) {
    super(m);
    this.name = 'PrepareError';
  }
}

/** The `dnr` command the hooks run: $DNR_BIN, else node + the built CLI in $ROOT. */
export function dnrCommand(root: string, env: NodeJS.ProcessEnv): string[] {
  if (env.DNR_BIN) return env.DNR_BIN.split(' ').filter(Boolean);
  const built = join(root, 'packages/cli/dist/cli.js');
  if (!existsSync(built))
    throw new PrepareError(`no dnr CLI: set DNR_BIN or build ${built} (pnpm -F dnr-guard build)`);
  return [process.execPath, built];
}

/** The model pin; a dry run without pins.json uses a marker that a real run refuses. */
export function pinnedModel(pins: Pins | null, dryRun: boolean): string {
  if (pins?.model) return pins.model;
  if (dryRun) return UNPINNED;
  throw new PrepareError('fixtures/pins.json has no model pin (Phase 0); a real run needs it');
}

/**
 * Frozen config (§9.3): `$TRIAL_ROOT/config.json` is a copy of `$ROOT/.dnr/config.json`, written
 * once. A later prepare must find the same bytes. A dry run without `.dnr/config.json` freezes
 * the defaults and says so.
 */
export async function freezeConfig(
  paths: TrialPaths,
): Promise<{ path: string; sha256: string; source: string }> {
  const dst = layout(paths.trialRoot).config;
  const src = join(paths.root, '.dnr/config.json');
  let text: string;
  let source: string;
  if (existsSync(src)) {
    text = readFileSync(src, 'utf8');
    DnrConfig.parse(JSON.parse(text));
    source = '.dnr/config.json';
  } else if (paths.dryRun) {
    text = `${JSON.stringify(DnrConfig.parse({}), null, 2)}\n`;
    source = 'defaults (no .dnr/config.json yet; frozen in Phase 10)';
  } else throw new PrepareError(`${src} is missing; freeze the config (Phase 10) before a real prepare`);
  if (existsSync(dst)) {
    const cur = readFileSync(dst, 'utf8');
    if (cur !== text) {
      if (!paths.dryRun)
        throw new PrepareError(`${dst} differs from ${source}; the frozen config must not change`);
    } else return { path: dst, sha256: sha256Hex(cur), source };
  }
  await mkdir(dirname(dst), { recursive: true });
  await writeFile(dst, text);
  return { path: dst, sha256: sha256Hex(text), source };
}

const PSEUDO = /(^<module>$|<body>$|^<default>$)/;

/** Target unit (§9.2 `<qualname> in <file>`): the heaviest non-pseudo unit of the run's own order. */
export function targetUnit(c: TrialCase, order: Order | null): TaskTarget {
  if (order) {
    const scored = order.units
      .map((u) => ({ u, w: unitWeights(u).wA + unitWeights(u).wR }))
      .sort((a, b) => {
        const pa = PSEUDO.test(a.u.qualname) ? 1 : 0;
        const pb = PSEUDO.test(b.u.qualname) ? 1 : 0;
        return (
          pa - pb || b.w - a.w || a.u.file.localeCompare(b.u.file) || a.u.qualname.localeCompare(b.u.qualname)
        );
      });
    const top = scored[0];
    if (top) return { file: top.u.file, qualname: top.u.qualname };
  }
  if (c.syn) return { file: c.syn.critical_edit.file, qualname: c.syn.critical_edit.qualname };
  const units = [...c.units].sort(
    (a, b) => (PSEUDO.test(a.qualname) ? 1 : 0) - (PSEUDO.test(b.qualname) ? 1 : 0),
  );
  const u = units[0];
  if (!u) throw new PrepareError(`${c.revert_sha}: no units`);
  return { file: u.file, qualname: u.qualname };
}

export function readPreparedIndex(trialRoot: string): Map<string, Prepared> {
  const p = layout(trialRoot).prepared;
  const m = new Map<string, Prepared>();
  if (!existsSync(p)) return m;
  for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(l) as Prepared;
    m.set(r.run_id, r);
  }
  return m;
}

async function writePreparedIndex(trialRoot: string, m: Map<string, Prepared>): Promise<void> {
  const p = layout(trialRoot).prepared;
  await mkdir(dirname(p), { recursive: true });
  const lines = [...m.values()]
    .sort((a, b) => a.run_id.localeCompare(b.run_id))
    .map((r) => JSON.stringify(r));
  await writeFile(p, lines.length ? `${lines.join('\n')}\n` : '');
}

export interface PrepareContext {
  paths: TrialPaths;
  env: NodeJS.ProcessEnv;
  pins: Pins | null;
  cases: Map<string, TrialCase>;
  deps: PrepareDeps;
}

/** Prepare one planned run. */
export async function prepareRun(ctx: PrepareContext, run: PlannedRun): Promise<Prepared> {
  const { paths, deps } = ctx;
  const log = deps.log ?? (() => {});
  const L = layout(paths.trialRoot);
  const c = ctx.cases.get(run.revert_sha);
  if (!c) throw new PrepareError(`${run.run_id}: no case for ${run.revert_sha}`);
  if (c.provisional && !paths.dryRun)
    throw new PrepareError(`${run.run_id}: provisional case (no Phase 3 inputs); only a dry run may use it`);
  const gitDir = gitDirOf(paths, c.repo);
  if (!gitDir) throw new PrepareError(`${run.run_id}: git dir for repo ${c.repo} not found`);
  const model = pinnedModel(ctx.pins, paths.dryRun);
  const cfg = await freezeConfig(paths);
  const s8 = loadS8(paths.root);
  const dnr = dnrCommand(paths.root, ctx.env);
  const allOrders = loadOrders(trialOrdersDir(paths));
  const own = allOrders.find((o) => o.revert_sha === c.revert_sha) ?? null;
  const target = targetUnit(c, own);
  const cSubject = (await git(['log', '-1', '--format=%s', c.original_sha], { cwd: gitDir })).trim();

  const isProbe = run.namespace === 'probe';
  const start = isProbe ? null : run.namespace === 'rdelta' ? c.rdelta_sha : c.revert_sha;
  if (!isProbe && !start) throw new PrepareError(`${run.run_id}: no rdelta_sha for ${c.revert_sha}`);
  const workdir = L.run(run.run_id);
  const ordersDir = L.orders(run.run_id);
  const stateDir = L.state(run.run_id);
  const home = L.home(run.run_id);
  const recordPath = join(stateDir, 'events.jsonl');
  await mkdir(stateDir, { recursive: true });

  let orderSet = { size: 0, ids: [] as string[], missing: [] as string[], approved: 0, hash: sha256Hex('') };
  let steering: string | null = null;
  if (start) {
    const repoDir = L.repos(start);
    await buildTruncatedRepo(gitDir, start, repoDir);
    const chk = await checkNothingNewer(repoDir, start);
    if (!chk.ok)
      throw new PrepareError(`${run.run_id}: truncated repo has later history: ${chk.problems.join('; ')}`);
    await cloneRun(repoDir, workdir, start);
    const pool = orderSetPool(paths.root, c.repo);
    const extra = new Set<string>([c.revert_sha]);
    // SYN: the case's own order plus real Django orders that are ancestors of the fork base (§9.10).
    const os = await buildOrderSet({ dir: ordersDir, gitDir, start, pool, extra, orders: allOrders });
    orderSet = {
      size: os.ids.length,
      ids: os.ids,
      missing: os.missing,
      approved: os.approved,
      hash: os.hash,
    };
    if (run.arm === 'S') {
      const inSet = allOrders.filter((o) => os.ids.includes(o.id) && o.status === 'approved');
      steering = join(workdir, '.kiro/steering/dnr-history.md');
      await mkdir(dirname(steering), { recursive: true });
      await writeFile(steering, deps.renderSteering(inSet));
    }
    // TRIAL-05: only arm S gets a file in the working copy.
    const dirty = await porcelain(workdir);
    const allowed = run.arm === 'S' ? ['?? .kiro/steering/dnr-history.md'] : [];
    const extraFiles = dirty.filter((l) => !allowed.includes(l));
    if (extraFiles.length > 0)
      throw new PrepareError(`${run.run_id}: working copy not clean: ${extraFiles.join(', ')}`);
  } else {
    await mkdir(workdir, { recursive: true });
    await mkdir(ordersDir, { recursive: true });
  }

  const mode = modeOf(run.arm);
  const hookEnv: HookEnv | null =
    bundleOf(run.arm) === 'none'
      ? null
      : {
          DNR_MODE: mode,
          DNR_STATE_DIR: stateDir,
          DNR_ORDERS: ordersDir,
          DNR_CONFIG: cfg.path,
          DNR_RECORD_PATH: recordPath,
        };
  const credentialFrom = ctx.env.DNR_TRIAL_CREDENTIAL_FILE ?? null;
  await seedHome({
    root: paths.root,
    home,
    arm: run.arm,
    agent: agentOf(run.arm),
    model,
    dnr,
    env: hookEnv,
    s8: s8.s8,
    credentialFrom,
    sidecar: hookEnv && s8.s8.hooks_inherit_env !== true ? { ...hookEnv } : null,
  });
  const seeded = hashKiroDir(home, s8.s8.kiro_write_globs);

  const task = isProbe
    ? '(probe prompt, see `dnr trial probe`)'
    : taskFor(run.arm, target, c.revert_sha, cSubject);
  const rec: Prepared = {
    run_id: run.run_id,
    namespace: run.namespace,
    arm: run.arm,
    replicate: run.replicate,
    revert_sha: c.revert_sha,
    repo: c.repo,
    role: c.role,
    start_sha: start,
    task,
    target,
    agent: agentOf(run.arm),
    model,
    mode,
    workdir,
    home,
    orders_dir: ordersDir,
    state_dir: stateDir,
    record_path: recordPath,
    config_path: cfg.path,
    config_sha256: cfg.sha256,
    order_set: orderSet,
    home_hash_seeded: seeded.hash,
    home_exclusions: s8.s8.kiro_write_globs,
    s8_source: s8.source,
    steering,
    provisional: c.provisional,
    dry_run: paths.dryRun,
    dnr_command: dnr,
    prepared_at: (deps.now ?? (() => new Date().toISOString()))(),
  };
  const out = L.out(run.run_id);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'prepared.json'), `${JSON.stringify(rec, null, 2)}\n`);
  log(
    `prepared ${run.run_id}: start ${start?.slice(0, 10) ?? '-'}, order set ${orderSet.size} (${orderSet.missing.length} missing), HOME ${seeded.files} file(s)`,
  );
  return rec;
}

export async function prepareAll(ctx: PrepareContext, runs: readonly PlannedRun[]): Promise<Prepared[]> {
  const idx = readPreparedIndex(ctx.paths.trialRoot);
  const out: Prepared[] = [];
  for (const r of runs) {
    const p = await prepareRun(ctx, r);
    idx.set(p.run_id, p);
    out.push(p);
  }
  await writePreparedIndex(ctx.paths.trialRoot, idx);
  return out;
}
