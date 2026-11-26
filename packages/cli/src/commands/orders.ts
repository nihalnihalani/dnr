/**
 * `dnr orders build|add|list|show|approve|retire|unretire|edit|reapprove|verify|refresh|relocate`.
 * Approval-type actions are human-only (R6 guard); guard-shell also denies them to agents.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createState,
  materialFromTexts,
  orderWeight,
  relocateUnit,
  UnitCache,
  unitKey,
  unitWeights,
} from '@dnr/core';
import { headCommit, resolveCommit, treeDiffNames } from '@dnr/git';
import { BlobReader, filesOf, type HookContext, loadParser } from '@dnr/hook';
import { Order, RevertCase, ScanCandidate } from '@dnr/schemas';
import { nowIso, OrderStore, TransitionError } from '@dnr/store';
import { z } from 'zod';
import { effectiveStatuses, rebaseOnHead } from '../analysis';
import { parse, str } from '../args';
import { type BuildCase, buildOne } from '../build';
import { repoContext, requireHuman } from '../context';
import { CliError, EXIT, invalidData, usage } from '../errors';
import type { CliIO } from '../io';

const HELP = `dnr orders build [--from <reverts.json|candidates.json>] [--only <sha>] [--out-dir <dir>] [--git-dir <path>]
dnr orders add --original <sha> [--snapshot <sha>] [--reason <text>] [--git-dir <path>]
dnr orders list [--orders <dir>] [--json]
dnr orders show <id> [--tokens] [--orders <dir>]
dnr orders approve <id>|--all [--by <name>]        (humans only)
dnr orders retire|unretire <id> [--by <name>]       (humans only)
dnr orders edit <id> --reason <text> [--by <name>]  (humans only)
dnr orders reapprove <id> [--by <name>]             (humans only; rebases the snapshot onto HEAD)
dnr orders verify [--orders <dir>]                  Zod-validate every order (65 on invalid)
dnr orders refresh [--orders <dir>]                 rebuild the coverage index and derived-status cache
dnr orders relocate --orders <dir> [--git-dir <path>]  write cache/fingerprints.json only`;

const OPTS = {
  orders: { type: 'string' },
  by: { type: 'string' },
  all: { type: 'boolean' },
  tokens: { type: 'boolean' },
  json: { type: 'boolean' },
  from: { type: 'string' },
  only: { type: 'string', multiple: true },
  'out-dir': { type: 'string' },
  'git-dir': { type: 'string' },
  reason: { type: 'string' },
  original: { type: 'string' },
  snapshot: { type: 'string' },
} as const;

const GUARDED = new Set(['approve', 'retire', 'unretire', 'edit', 'reapprove']);

function repoEnvDir(repo: string, env: NodeJS.ProcessEnv): string | undefined {
  const m: Record<string, string | undefined> = {
    django: env.DJANGO_SRC,
    cpython: env.SECOND_SRC,
    sympy: env.SECOND_SRC,
    syn: env.TRIAL_ROOT ? join(env.TRIAL_ROOT, 'syn-src') : undefined,
    'ts-demo': env.TS_DEMO_SRC,
  };
  return m[repo];
}

/** Read `--from`: RevertCase[] (trial) or ScanCandidate[] (product mode). */
export function readCases(file: string): {
  cases: (BuildCase & { subject?: string })[];
  kind: 'revert' | 'scan';
} {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw invalidData(`DNR: cannot read ${file}: ${String(e)}`);
  }
  const rc = z.array(RevertCase).safeParse(raw);
  if (rc.success)
    return {
      kind: 'revert',
      cases: rc.data.map((c) => ({
        revert_sha: c.revert_sha,
        original_sha: c.original_sha,
        tickets: c.tickets,
        repo: c.repo,
      })),
    };
  const sc = z.array(ScanCandidate).safeParse(raw);
  if (sc.success)
    return {
      kind: 'scan',
      cases: sc.data.map((c) => ({
        revert_sha: c.revert_sha,
        original_sha: c.original_sha,
        tickets: c.tickets,
        subject: c.subject,
      })),
    };
  throw invalidData(
    `DNR: ${file} is neither RevertCase[] nor ScanCandidate[]: ${rc.error.issues[0]?.message ?? ''}`,
  );
}

export async function cmdOrders(argv: string[], io: CliIO): Promise<number> {
  const [sub, ...rest] = argv;
  const { values: v, positionals } = parse(sub?.startsWith('-') ? [] : rest, OPTS);
  if (!sub || sub === 'help' || sub.startsWith('-')) {
    io.out(`${HELP}\n`);
    return sub ? EXIT.OK : EXIT.USAGE;
  }
  if (v.help) {
    io.out(`${HELP}\n`);
    return EXIT.OK;
  }
  if (GUARDED.has(sub)) requireHuman(io, `orders ${sub}`);
  const ordersOverride = v.orders ? resolve(io.cwd, str(v.orders) as string) : undefined;
  const ctx = await repoContext(io, ordersOverride ? { orders: ordersOverride } : {});
  const store = ctx.store.orders;
  const by = str(v.by) ?? io.env.USER ?? 'human';
  const at = nowIso(io.env);
  const id = positionals[0];

  switch (sub) {
    case 'build': {
      const outDir = v['out-dir'] ? resolve(io.cwd, str(v['out-dir']) as string) : ctx.store.paths.ordersDir;
      if (resolve(outDir) === resolve(ctx.store.paths.ordersDir))
        requireHuman(io, 'orders build (into the live order directory)');
      const from = v.from ? resolve(io.cwd, str(v.from) as string) : ctx.store.paths.candidatesFile;
      if (!existsSync(from)) throw usage(`DNR: ${from} not found. Run \`dnr scan\` first, or pass --from.`);
      const { cases, kind } = readCases(from);
      const only = (v.only as string[] | undefined) ?? [];
      const picked = only.length
        ? cases.filter((c) =>
            only.some((o) => (c.revert_sha ?? '').startsWith(o) || c.original_sha.startsWith(o)),
          )
        : cases;
      if (only.length && picked.length === 0)
        throw usage(`DNR: --only ${only.join(',')} matches no revert in ${from}`);
      const out = new OrderStore(outDir, ctx.store.paths.cacheDir, () =>
        ctx.store.sessions.refreshOrdersHash(ctx.store.ordersHash()),
      );
      const parser = await loadParser();
      let built = 0;
      for (const c of picked) {
        const gitDir = v['git-dir']
          ? resolve(io.cwd, str(v['git-dir']) as string)
          : kind === 'revert' && c.repo
            ? (repoEnvDir(c.repo, io.env) ?? ctx.repoRoot)
            : ctx.repoRoot;
        const existingId = `dnr-${(c.revert_sha ?? c.original_sha).slice(0, 10)}`;
        const r = await buildOne({
          gitDir,
          provider: parser,
          c,
          existing: await out.get(existingId),
          testGlobs: ctx.config.test_globs,
          now: at,
        });
        if (!r.ok) {
          io.err(`DNR: ${r.id} skipped: ${r.skip_reason}\n`);
          continue;
        }
        if (r.changed) await out.put(r.order);
        built++;
        const w = orderWeight(r.order);
        io.out(
          `${r.order.id} ${r.created ? 'created' : r.changed ? 'rebuilt' : 'unchanged'} (${r.order.status}): ${r.order.units.length} unit(s), w(A)+w(R) = ${w}${w < ctx.config.min_order_weight ? ` < min_order_weight ${ctx.config.min_order_weight}: warn-only` : ''}\n`,
        );
      }
      io.out(
        `DNR: ${built} order(s) in ${outDir}.\nNext: dnr draft --all${v['out-dir'] ? ` --orders ${outDir}` : ''}\n`,
      );
      return EXIT.OK;
    }
    case 'add': {
      const original = str(v.original);
      if (!original) throw usage('dnr orders add --original <sha> [--snapshot <sha>] [--reason <text>]');
      const gitDir = v['git-dir'] ? resolve(io.cwd, str(v['git-dir']) as string) : ctx.repoRoot;
      const C = await resolveCommit(gitDir, original);
      if (!C) throw usage(`DNR: ${original} is not a commit`);
      const snap = v.snapshot
        ? await resolveCommit(gitDir, str(v.snapshot) as string)
        : await headCommit(gitDir);
      if (!snap) throw usage('DNR: no snapshot commit');
      const r = await buildOne({
        gitDir,
        provider: await loadParser(),
        c: { revert_sha: null, original_sha: C, snapshot_sha: snap, tickets: [] },
        existing: await store.get(`dnr-${C.slice(0, 10)}`),
        testGlobs: ctx.config.test_globs,
        now: at,
        ...(v.reason ? { reason: str(v.reason) as string } : {}),
      });
      if (!r.ok) throw new CliError(`DNR: ${r.id}: ${r.skip_reason}`, EXIT.FINDINGS);
      await store.put({ ...r.order, source: 'manual' });
      io.out(
        `${r.order.id} ${r.created ? 'created' : 'rebuilt'} (draft). Next: dnr orders approve ${r.order.id}\n`,
      );
      return EXIT.OK;
    }
    case 'list': {
      const { orders, invalid } = await store.load();
      const eff = await effectiveStatuses(ctx, orders);
      if (v.json)
        io.out(
          `${JSON.stringify(
            orders.map((o) => ({
              id: o.id,
              status: o.status,
              effective: eff.get(o.id),
              reason_source: o.reason_source,
              reason: o.reason,
              files: filesOf(o),
            })),
            null,
            2,
          )}\n`,
        );
      else {
        if (orders.length === 0) io.out('DNR: no orders. Run `dnr scan`, then `dnr orders build`.\n');
        for (const o of orders)
          io.out(
            `${o.id}  ${(eff.get(o.id) ?? o.status).padEnd(8)}  ${o.reason_source.padEnd(11)}  ${o.reason.slice(0, 90)}\n`,
          );
      }
      for (const i of invalid) io.err(`DNR: invalid order file ${i.file}: ${i.error}\n`);
      return invalid.length ? EXIT.DATA : EXIT.OK;
    }
    case 'show': {
      if (!id) throw usage('dnr orders show <id> [--tokens]');
      const o = await store.get(id);
      if (!o) throw usage(`DNR: no order ${id}`);
      const eff = (await effectiveStatuses(ctx, [o])).get(o.id);
      const w = orderWeight(o);
      io.out(`${o.id}  status ${o.status} (effective ${eff})  source ${o.source}\n`);
      io.out(`reason (${o.reason_source}): ${o.reason}\n`);
      io.out(`original ${o.original_sha}\nrevert   ${o.revert_sha ?? '—'}\nsnapshot ${o.snapshot_sha}\n`);
      for (const l of o.links) io.out(`link ${l.rel}: ${l.url}\n`);
      for (const u of o.units) {
        const uw = unitWeights(u);
        io.out(
          `unit ${u.file} ${u.qualname} (${u.kind}, ${u.tokenizer.grammar}): |A| = ${u.A.length}, |R| = ${u.R.length}, w(A) = ${uw.wA}, w(R) = ${uw.wR}\n`,
        );
        if (v.tokens) {
          io.out(`  A: ${JSON.stringify(u.A)}\n  R: ${JSON.stringify(u.R)}\n`);
        }
      }
      io.out(
        `w(A)+w(R) = ${w} ${w >= ctx.config.min_order_weight ? '≥' : '<'} min_order_weight ${ctx.config.min_order_weight}\n`,
      );
      for (const h of o.history) io.out(`history ${h.at} ${h.action} by ${h.by}\n`);
      for (const g of await ctx.store.grants.list(o.id))
        io.out(
          `grant ${g.kind} via ${g.origin?.via ?? 'unknown'} by ${g.granted_by} at ${g.granted_at} (expires ${g.expires_at}, ${g.used.length} use(s))${g.origin?.suspect ? ` SUSPECT: made while an agent session was active (${g.origin.markers.join(', ')})` : ''}\n`,
        );
      return EXIT.OK;
    }
    case 'approve': {
      const ids = v.all
        ? (await store.list()).filter((o) => o.status === 'draft').map((o) => o.id)
        : id
          ? [id]
          : [];
      if (ids.length === 0 && !v.all) throw usage('dnr orders approve <id>|--all [--by <name>]');
      for (const x of ids) {
        try {
          await store.approve(x, by, at);
          io.out(`${x} approved by ${by}\n`);
        } catch (e) {
          if (e instanceof TransitionError) throw new CliError(e.message, EXIT.FINDINGS);
          throw e;
        }
      }
      if (v.all) io.out(`DNR: approved ${ids.length} draft order(s).\n`);
      return EXIT.OK;
    }
    case 'retire':
    case 'unretire': {
      if (!id) throw usage(`dnr orders ${sub} <id>`);
      try {
        const o = sub === 'retire' ? await store.retire(id, by, at) : await store.unretire(id, by, at);
        io.out(`${id} is now ${o.status}${sub === 'unretire' ? ' (approve it again to enforce)' : ''}\n`);
      } catch (e) {
        if (e instanceof TransitionError) throw new CliError(e.message, EXIT.FINDINGS);
        throw e;
      }
      return EXIT.OK;
    }
    case 'edit': {
      const reason = str(v.reason);
      if (!id || !reason) throw usage('dnr orders edit <id> --reason <text>');
      const r = Order.shape.reason.safeParse(reason);
      if (!r.success) throw invalidData(`DNR: reason must be 1–280 characters`);
      await store.editReason(id, reason, by, 'human', at);
      io.out(`${id}: reason updated\n`);
      return EXIT.OK;
    }
    case 'reapprove': {
      if (!id) throw usage('dnr orders reapprove <id>');
      const o = await store.require(id);
      if (o.status === 'retired')
        throw new CliError(`DNR: ${id} is retired; unretire it first`, EXIT.FINDINGS);
      const next = await rebaseOnHead(ctx, o, by, at);
      await store.put(next);
      io.out(`${id} re-approved; snapshot rebased onto ${next.snapshot_sha.slice(0, 10)}\n`);
      return EXIT.OK;
    }
    case 'verify': {
      const { orders, invalid } = await store.load();
      for (const i of invalid) io.err(`DNR: invalid ${i.file}: ${i.error}\n`);
      // Duplicate (file, qualname) units within an order are invalid too.
      for (const o of orders) {
        const seen = new Set<string>();
        for (const u of o.units) {
          const k = unitKey(u.file, u.qualname);
          if (seen.has(k))
            invalid.push({ file: store.fileFor(o.id), error: `duplicate unit ${u.file} ${u.qualname}` });
          seen.add(k);
        }
      }
      if (invalid.length) return EXIT.DATA;
      io.out(`DNR: ${orders.length} order(s) valid.\n`);
      return EXIT.OK;
    }
    case 'refresh': {
      const { orders } = await store.load();
      store.coverage();
      const eff = await effectiveStatuses(ctx, orders);
      io.out(
        `DNR: refreshed ${orders.length} order(s): ${[...eff.values()].filter((s) => s === 'stale' || s === 'relanded').length} stale or re-landed.\n`,
      );
      return EXIT.OK;
    }
    case 'relocate':
      return relocate(ctx, io, v['git-dir'] ? resolve(io.cwd, str(v['git-dir']) as string) : ctx.repoRoot);
    default:
      throw usage(`dnr orders: unknown subcommand ${sub}\n${HELP}`);
  }
}

/**
 * `dnr orders relocate` (§5.16 load-time relocation): for each modified/removed unit missing at
 * HEAD, search files changed since the snapshot and record the best candidate at or above the
 * fingerprint floor. Writes only `$DNR_STATE_DIR/cache/fingerprints.json`.
 */
async function relocate(ctx: HookContext, io: CliIO, gitDir: string): Promise<number> {
  const orders = await ctx.store.orders.list();
  const parser = await loadParser();
  const cache = new UnitCache(parser);
  const reader = new BlobReader(gitDir);
  const head = await headCommit(gitDir);
  if (!head) throw new CliError('DNR: no HEAD', EXIT.DEPENDENCY);
  const out: Record<
    string,
    Array<{
      from: { file: string; qualname: string };
      to: { file: string; qualname: string };
      similarity: number;
    }>
  > = {};
  for (const o of orders) {
    const files = filesOf(o);
    const changed = await treeDiffNames(gitDir, o.snapshot_sha, head).catch(() => [] as string[]);
    const search = changed.filter((f) => /\.(py|tsx?|[mc]?[jt]sx?)$/.test(f));
    await reader.prefetch([
      ...files.flatMap((f) => [`${o.original_sha}:${f}`, `${o.snapshot_sha}:${f}`]),
      ...[...files, ...search].map((f) => `${head}:${f}`),
    ]);
    const material = materialFromTexts(
      parser,
      o,
      (f) => reader.get(o.original_sha, f),
      (f) => reader.get(o.snapshot_sha, f),
    );
    const headState = createState((f) => reader.get(head, f), cache);
    const own = new Set(o.units.map((u) => unitKey(u.file, u.qualname)));
    for (const u of o.units) {
      if (u.kind === 'added') continue;
      if (headState.units(u.file)?.units.get(u.qualname)) continue;
      const m = material.get(unitKey(u.file, u.qualname));
      if (!m) continue;
      const rel = relocateUnit(u, m, headState, search, ctx.config.fingerprint_floor, own);
      if (rel) {
        const list = out[o.id] ?? [];
        out[o.id] = list;
        list.push({
          from: { file: u.file, qualname: u.qualname },
          to: { file: rel.file, qualname: rel.qualname },
          similarity: rel.similarity,
        });
      }
    }
  }
  const file = join(ctx.store.paths.cacheDir, 'fingerprints.json');
  await mkdir(ctx.store.paths.cacheDir, { recursive: true });
  await writeFile(file, `${JSON.stringify({ head, relocations: out }, null, 2)}\n`);
  io.out(`DNR: ${Object.values(out).flat().length} relocation(s) written to ${file}\n`);
  return EXIT.OK;
}

void readdirSync;
