/**
 * `dnr trial falsealarm [--config <path>] [--role tune|gate|trial|none]` (§8, §9.6, Phase 5).
 *
 * False-alarm scan: every later non-merge commit X on the branch that touches a covered unit is
 * scored over the whole order with the crossing rule against its first parent (§5.5), comparing
 * the post-revert snapshot with the commit. A crossing is a match-tier false block (F), unless
 * the commit message names one of C's tickets, which makes it a re-land (RL). A commit that
 * changes a covered unit without matching counts as a warn-tier block, reported on its own.
 * Stale and re-landed are measured at X^, not at the clone's HEAD (§5.9).
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  createState,
  extractUnitChanges,
  isCrossing,
  type MatchConfig,
  staleReport,
  UnitCache,
  unitKey,
} from '@dnr/core';
import { catBlobs, defaultBranch, runGit } from '@dnr/git';
import { filesOf, loadParser } from '@dnr/hook';
import type { Order } from '@dnr/schemas';
import { nowIso, OrderStore } from '@dnr/store';
import { parse, str } from '../args';
import { repoContext } from '../context';
import { EXIT, missingDependency, usage } from '../errors';
import type { CliIO } from '../io';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface OrderAlarms {
  id: string;
  role: string | null;
  scanned: number;
  false_blocks: Array<{ sha: string; edit: number }>;
  relands: Array<{ sha: string; edit: number }>;
  warn_blocks: string[];
  skipped_stale: string[];
  skipped_relanded: string[];
}

function mentionsTicket(message: string, order: Order): boolean {
  return order.tickets.some((t) => new RegExp(`(#|ticket/|issues/)${t.id}\\b`).test(message));
}

export async function scanOrder(input: {
  gitDir: string;
  order: Order;
  branch: string;
  config: MatchConfig;
  cache: UnitCache;
  role: string | null;
}): Promise<OrderAlarms> {
  const { gitDir, order } = input;
  const out: OrderAlarms = {
    id: order.id,
    role: input.role,
    scanned: 0,
    false_blocks: [],
    relands: [],
    warn_blocks: [],
    skipped_stale: [],
    skipped_relanded: [],
  };
  const files = filesOf(order);
  const from = order.revert_sha ?? order.snapshot_sha;
  const r = await runGit(
    ['rev-list', '--no-merges', '--reverse', '--parents', `${from}..${input.branch}`, '--', ...files],
    {
      cwd: gitDir,
      okCodes: [0, 128],
    },
  );
  if (r.code !== 0) return out;
  const covered = new Set(order.units.map((u) => unitKey(u.file, u.qualname)));
  const provider = input.cache.provider;
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [X, P] = line.split(' ') as [string, string | undefined];
    const parent = P ?? EMPTY_TREE;
    const specs = files.flatMap((f) => [`${X}:${f}`, `${parent}:${f}`, `${order.snapshot_sha}:${f}`]);
    const blobs = await catBlobs(gitDir, specs);
    const text = (rev: string, f: string) => blobs.get(`${rev}:${f}`) ?? null;
    // Does X touch a covered unit?
    let touches = false;
    for (const f of files) {
      const before = text(parent, f);
      const after = text(X, f);
      if (before === after) continue;
      for (const c of extractUnitChanges(provider, { path: f, before, after }))
        if (covered.has(unitKey(c.file, c.qualname))) touches = true;
    }
    if (!touches) continue;
    out.scanned++;
    const snap = createState((f) => text(order.snapshot_sha, f), input.cache);
    const prev = createState((f) => text(parent, f), input.cache);
    const next = createState((f) => text(X, f), input.cache);
    if (staleReport(order, snap, prev, { fingerprintFloor: input.config.fingerprint_floor }).stale) {
      out.skipped_stale.push(X);
      continue;
    }
    const cr = isCrossing(order, snap, prev, next, { config: input.config });
    if (cr.parent.matched) {
      out.skipped_relanded.push(X);
      continue;
    }
    if (cr.crossing) {
      const msg = (await runGit(['log', '-1', '--format=%B', X], { cwd: gitDir })).stdout;
      (mentionsTicket(msg, order) ? out.relands : out.false_blocks).push({ sha: X, edit: cr.next.edit });
    } else out.warn_blocks.push(X);
  }
  return out;
}

export async function cmdFalsealarm(argv: string[], io: CliIO): Promise<number> {
  const { values: v } = parse(argv.slice(1), {
    config: { type: 'string' },
    role: { type: 'string' },
    orders: { type: 'string' },
    'git-dir': { type: 'string' },
    branch: { type: 'string' },
    out: { type: 'string' },
  });
  if (v.help) {
    io.out(
      'dnr trial falsealarm [--config <path>] [--role tune|gate|trial|none] [--orders <dir>] [--git-dir <path>] [--branch <ref>] [--out <file>]\n',
    );
    return EXIT.OK;
  }
  const role = str(v.role);
  if (role && !['tune', 'gate', 'trial', 'none'].includes(role))
    throw usage('dnr trial falsealarm: --role is tune, gate, trial or none');
  const ctx = await repoContext(io, v.config ? { config: resolve(io.cwd, str(v.config) as string) } : {});
  const ordersDir = v.orders
    ? resolve(io.cwd, str(v.orders) as string)
    : existsSync(join(ctx.repoRoot, 'reports', 'orders'))
      ? join(ctx.repoRoot, 'reports', 'orders')
      : ctx.store.paths.ordersDir;
  const gitDir = v['git-dir']
    ? resolve(io.cwd, str(v['git-dir']) as string)
    : (io.env.DJANGO_SRC ?? ctx.repoRoot);
  if (!existsSync(gitDir))
    throw missingDependency(`DNR: git dir ${gitDir} not found (set --git-dir or DJANGO_SRC)`);
  const branch = str(v.branch) ?? (await defaultBranch(gitDir));
  const roles = new Map<string, string>();
  const af = join(ctx.repoRoot, 'fixtures', 'assignment.json');
  if (existsSync(af))
    for (const a of JSON.parse(readFileSync(af, 'utf8')) as Array<{ revert_sha: string; role: string }>)
      roles.set(a.revert_sha, a.role);
  if (role && role !== 'none' && roles.size === 0)
    throw missingDependency(`DNR: --role ${role} needs ${af} (dnr trial assign)`);
  let orders = (await new OrderStore(ordersDir).list()).filter((o) => o.status !== 'retired');
  if (role) orders = orders.filter((o) => (roles.get(o.revert_sha ?? '') ?? 'none') === role);
  const cache = new UnitCache(await loadParser());
  const results: OrderAlarms[] = [];
  for (const order of orders)
    results.push(
      await scanOrder({
        gitDir,
        order,
        branch,
        config: ctx.config,
        cache,
        role: roles.get(order.revert_sha ?? '') ?? null,
      }),
    );
  const totals = {
    orders: results.length,
    N: results.reduce((n, r) => n + r.scanned, 0),
    F: results.reduce((n, r) => n + r.false_blocks.length, 0),
    RL: results.reduce((n, r) => n + r.relands.length, 0),
    warn_blocks: results.reduce((n, r) => n + r.warn_blocks.length, 0),
  };
  const report = {
    generated_at: nowIso(io.env),
    config: v.config
      ? resolve(io.cwd, str(v.config) as string)
      : ctx.store.paths.configFromEnv
        ? ctx.store.paths.configFile
        : null,
    threshold: ctx.config.threshold,
    role: role ?? 'all',
    branch,
    totals,
    orders: results,
  };
  const out = v.out
    ? resolve(io.cwd, str(v.out) as string)
    : join(ctx.repoRoot, 'reports', 'false-alarms.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  io.out(
    `DNR: false-alarm scan: ${totals.orders} order(s), N = ${totals.N} later commits touching a covered unit, F = ${totals.F} false block(s), RL = ${totals.RL} re-land(s), ${totals.warn_blocks} warn-tier. Written to ${out}\n`,
  );
  return EXIT.OK;
}
