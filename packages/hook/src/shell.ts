/**
 * `dnr guard-shell --stdin`: the PreToolUse shell hook (§5.10). Denies (exit 2) when any rule
 * matches. Otherwise it takes the temp-index tree snapshot that `dnr session shell-after` compares
 * against (§5.11).
 *
 * R1 protected paths · R2 git revert of an order's revert · R3 cherry-pick of an original ·
 * R4 git apply / am / patch that matches an order · R5 checkout/restore/show from an original ·
 * R6 enforcement-changing dnr subcommands (through any wrapper) · R7 network clients to the
 * board port · R8 hook bypasses (commit --no-verify / -n, core.hooksPath, terminal automation).
 */
import { existsSync, globSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { overlayState, scoreOrder } from '@dnr/core';
import { revList, snapshotTree, tryResolve } from '@dnr/git';
import type { EventRecord, Order, Session } from '@dnr/schemas';
import { applyPatch, parsePatch } from 'diff';
import {
  appendEvents,
  baseDecision,
  type HookContext,
  type HookIO,
  type HookOptions,
  keyOf,
  makeEvent,
  OK,
  openContext,
  prepareSession,
  sessionPatch,
} from './context';
import { createState, filesOf, loadParser, UnitCache } from './engine';
import { parseHookEvent, shellCommandOf } from './event';
import { failOpen } from './failopen';
import { cap } from './messages';
import { loadEntries } from './orders';
import { isProtectedPath } from './prewrite';
import { BlobReader, readWorktree, repoRelative } from './repo';
import { isDnr, parseCommands, type SimpleCommand } from './shell-parse';

export type ShellRule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8';

export interface ShellFinding {
  rule: ShellRule;
  /** 'deny' blocks the command; 'warn' is the one-per-session R4 warning for an unreadable patch. */
  level: 'deny' | 'warn';
  detail: string;
  order_id?: string;
}

/** Everything the rules need besides the parsed command. Injectable for tests. */
export interface ShellEnv {
  cwd: string;
  repoRoot: string;
  home: string | null;
  isProtected(absPath: string): boolean;
  /** Approved orders whose grant does not apply. */
  orders: Order[];
  /** Resolve a revision to a full SHA (null when it does not resolve). */
  resolve(rev: string): Promise<string | null>;
  revList(range: string): Promise<string[]>;
  /** Board ports: config board_port plus the live port in board.json. */
  boardPorts: number[];
  ordersDir: string;
  /** Score a virtually applied patch: returns the matching order id, if any. */
  patchMatches(files: Map<string, string | null>): Promise<string | null>;
  readFile(absPath: string): string | null;
}

/** dnr subcommands that change enforcement or carry a secret (R6). */
export function r6Subcommand(args: readonly string[], ordersDir: string, cwd: string): string | null {
  const pos = args.filter((a) => !a.startsWith('-'));
  const [sub, sub2] = pos;
  if (!sub) return null;
  if (['allow', 'board', 'init', 'draft'].includes(sub)) return sub;
  if (sub === 'orders' && sub2 && ['approve', 'retire', 'unretire', 'edit', 'reapprove'].includes(sub2))
    return `orders ${sub2}`;
  if (sub === 'orders' && sub2 === 'build') {
    const i = args.findIndex((a) => a === '--out-dir' || a.startsWith('--out-dir='));
    if (i < 0) return 'orders build';
    const v = args[i]?.includes('=') ? args[i]?.split('=').slice(1).join('=') : args[i + 1];
    if (!v) return 'orders build';
    return resolve(cwd, v) === resolve(ordersDir) ? 'orders build' : null;
  }
  if (sub === 'session' && sub2 && ['end', 'gc'].includes(sub2) && !args.includes('--stdin'))
    return `session ${sub2}`;
  return null;
}

const LOOPBACK = /^(127(?:\.\d{1,3}){3}|localhost|\[?::1\]?|0\.0\.0\.0|[a-z0-9.-]*\.localhost)$/i;
const NET_CLIENTS = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'socat',
  'http',
  'https',
  'xh',
  'aria2c',
  'lynx',
  'w3m',
]);
const SCRIPTERS = new Set([
  'python',
  'python3',
  'python2',
  'node',
  'ruby',
  'perl',
  'php',
  'deno',
  'bun',
  'tsx',
]);

function hostPortOf(token: string): { host: string; port: number | null } | null {
  let t = token.replace(/^['"]|['"]$/g, '');
  if (!/^[a-z]+:\/\//i.test(t)) t = `http://${t}`;
  try {
    const u = new URL(t);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return { host, port: u.port ? Number(u.port) : null };
  } catch {
    return null;
  }
}

function isLoopback(host: string): boolean {
  return LOOPBACK.test(host) || host === '::1';
}

const base = (p: string) => p.split('/').pop() ?? p;

/** Positional (non-option) args after a git subcommand. */
function gitSub(argv: string[]): { sub: string; args: string[]; configs: string[] } | null {
  if (base(argv[0] ?? '') !== 'git') return null;
  const configs: string[] = [];
  let i = 1;
  while (i < argv.length && (argv[i] as string).startsWith('-')) {
    const t = argv[i] as string;
    if (t === '-c' || t === '-C' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') {
      if (t === '-c') configs.push(argv[i + 1] ?? '');
      i += 2;
    } else {
      if (t.startsWith('--config-env')) configs.push(t);
      i++;
    }
  }
  const sub = argv[i];
  if (!sub) return null;
  return { sub, args: argv.slice(i + 1), configs };
}

async function resolvesTo(env: ShellEnv, rev: string, shas: Set<string>): Promise<string | null> {
  const clean = rev.replace(/\^\{commit\}$/, '');
  if (/^[0-9a-f]{7,40}$/.test(clean)) {
    for (const s of shas) if (s.startsWith(clean)) return s;
  }
  const full = await env.resolve(clean);
  return full && shas.has(full) ? full : null;
}

function pathTokens(c: SimpleCommand): string[] {
  const out: string[] = [];
  for (const a of c.argv.slice(1)) {
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      if (eq > 0) out.push(a.slice(eq + 1));
      continue;
    }
    out.push(a);
  }
  for (const r of c.redirects) out.push(r.target);
  return out.filter((t) => t.length > 0 && !/^[a-z]+:\/\//i.test(t));
}

function expandPath(env: ShellEnv, token: string): string[] {
  let t = token;
  if (t === '~' || t.startsWith('~/')) t = `${env.home ?? '~'}${t.slice(1)}`;
  if (t.startsWith('$HOME')) t = `${env.home ?? '$HOME'}${t.slice(5)}`;
  if (t.startsWith('$')) return [];
  const abs = isAbsolute(t) ? t : resolve(env.cwd, t);
  const out = [abs];
  if (/[*?[]/.test(t)) {
    try {
      for (const m of globSync(t, { cwd: env.cwd })) out.push(isAbsolute(m) ? m : resolve(env.cwd, m));
    } catch {}
    // The literal directory part of a glob, e.g. `.dnr/*` → `.dnr/`.
    const lit = t.split('/').filter((seg) => !/[*?[]/.test(seg));
    if (lit.length) out.push(resolve(env.cwd, lit.join('/'), '__glob__'));
  }
  return out;
}

/** Evaluate every rule over one command string. */
export async function evaluateShell(command: string, env: ShellEnv): Promise<ShellFinding[]> {
  const cmds = parseCommands(command, { HOME: env.home ?? undefined });
  const findings: ShellFinding[] = [];
  const reverts = new Map(env.orders.filter((o) => o.revert_sha).map((o) => [o.revert_sha as string, o.id]));
  const originals = new Map(env.orders.map((o) => [o.original_sha, o.id]));
  const revertSet = new Set(reverts.keys());
  const origSet = new Set(originals.keys());

  for (const c of cmds) {
    const argv = c.argv;
    const a0 = argv[0];
    // R1: any path token under a protected glob.
    for (const tok of pathTokens(c)) {
      for (const p of expandPath(env, tok)) {
        if (env.isProtected(p)) {
          findings.push({ rule: 'R1', level: 'deny', detail: `path ${tok} is protected` });
          break;
        }
      }
    }
    // R6: enforcement-changing dnr subcommands, directly or through a wrapper.
    if (isDnr(a0)) {
      const sub = r6Subcommand(argv.slice(1), env.ordersDir, env.cwd);
      if (sub) findings.push({ rule: 'R6', level: 'deny', detail: `\`dnr ${sub}\` is for humans only` });
    }
    // R7: network clients to the board port on a loopback host.
    const b0 = base(a0 ?? '');
    if (NET_CLIENTS.has(b0)) {
      const args = argv.slice(1);
      let loop = false;
      let portHit = false;
      for (const t of args) {
        if (t.startsWith('-')) continue;
        const hp = hostPortOf(t);
        if (hp && isLoopback(hp.host)) {
          loop = true;
          if (hp.port !== null && env.boardPorts.includes(hp.port)) portHit = true;
        }
        if (/^\d+$/.test(t) && env.boardPorts.includes(Number(t))) portHit = portHit || loop;
      }
      // nc localhost 4317 / telnet 127.0.0.1 4317 / curl --unix-socket … are covered by host + bare port.
      if (loop && portHit)
        findings.push({ rule: 'R7', level: 'deny', detail: `${b0} to the DNR board port` });
    }
    if (SCRIPTERS.has(b0.replace(/\d+(\.\d+)?$/, '')) || SCRIPTERS.has(b0)) {
      const ci = argv.findIndex(
        (t) => t === '-c' || t === '-e' || t === '--eval' || t === '-p' || t === '-E',
      );
      const code = ci >= 0 ? (argv[ci + 1] ?? '') : '';
      if (code && /(127\.0\.0\.1|localhost|::1|0\.0\.0\.0|\.localhost)/i.test(code)) {
        if (env.boardPorts.some((p) => new RegExp(`(^|[^0-9])${p}([^0-9]|$)`).test(code)))
          findings.push({ rule: 'R7', level: 'deny', detail: `${b0} script opening the DNR board port` });
      }
    }
    // R8: hook and approval bypasses.
    if (b0 === 'osascript')
      findings.push({ rule: 'R8', level: 'deny', detail: 'osascript can drive a human terminal' });
    if (b0 === 'open' && argv.some((t) => /terminal|iterm|warp|kitty|alacritty|wezterm|ghostty/i.test(t)))
      findings.push({ rule: 'R8', level: 'deny', detail: 'opening a terminal app from an agent session' });
    if (b0 === 'tmux' && argv.includes('send-keys'))
      findings.push({ rule: 'R8', level: 'deny', detail: 'tmux send-keys' });
    if (b0 === 'screen' && argv.includes('stuff'))
      findings.push({ rule: 'R8', level: 'deny', detail: 'screen stuff' });

    const g = gitSub(argv);
    if (!g) continue;
    if (g.configs.some((x) => /core\.hookspath/i.test(x)))
      findings.push({ rule: 'R8', level: 'deny', detail: 'git -c core.hooksPath' });
    if (g.sub === 'config' && g.args.some((x) => /^core\.hookspath$/i.test(x))) {
      const reading = g.args.some((x) => ['--get', '--get-all', '-l', '--list', '--show-origin'].includes(x));
      const positional = g.args.filter((x) => !x.startsWith('-'));
      if (!reading && (positional.length >= 2 || g.args.some((x) => x.startsWith('--unset'))))
        findings.push({ rule: 'R8', level: 'deny', detail: 'changing core.hooksPath' });
    }
    if (g.sub === 'commit' || g.sub === 'merge' || g.sub === 'am' || g.sub === 'rebase') {
      const noVerify = g.args.some((x) => x === '--no-verify');
      const shortN =
        g.sub === 'commit' &&
        g.args.some((x) => {
          if (!/^-[A-Za-z]+$/.test(x)) return false;
          const flags = x.slice(1);
          const n = flags.indexOf('n');
          if (n < 0) return false;
          // Any arg-taking short flag before `n` consumes the rest of the cluster.
          return !/[mFcCtSu]/.test(flags.slice(0, n));
        });
      if (noVerify || shortN)
        findings.push({ rule: 'R8', level: 'deny', detail: `git ${g.sub} skipping the pre-commit hook` });
    }

    const positional = g.args.filter((x) => !x.startsWith('-'));
    if (g.sub === 'revert') {
      for (const rev of positional) {
        const hit = await resolvesTo(env, rev, revertSet);
        if (hit)
          findings.push({
            rule: 'R2',
            level: 'deny',
            detail: `git revert ${rev}`,
            order_id: reverts.get(hit) as string,
          });
      }
    }
    if (g.sub === 'cherry-pick') {
      for (const rev of positional) {
        let hit: string | null = null;
        if (rev.includes('..')) {
          const list = await env.revList(rev);
          hit = list.find((s) => origSet.has(s)) ?? null;
        } else hit = await resolvesTo(env, rev, origSet);
        if (hit)
          findings.push({
            rule: 'R3',
            level: 'deny',
            detail: `git cherry-pick ${rev}`,
            order_id: originals.get(hit) as string,
          });
      }
    }
    if (g.sub === 'checkout' || g.sub === 'restore') {
      const revs: string[] = [];
      g.args.forEach((x, i) => {
        if (x === '--source' || x === '-s') revs.push(g.args[i + 1] ?? '');
        else if (x.startsWith('--source=')) revs.push(x.slice(9));
      });
      const dd = g.args.indexOf('--');
      if (g.sub === 'checkout' && dd > 0) revs.push(...g.args.slice(0, dd).filter((x) => !x.startsWith('-')));
      for (const rev of revs) {
        const hit = rev ? await resolvesTo(env, rev, origSet) : null;
        if (hit)
          findings.push({
            rule: 'R5',
            level: 'deny',
            detail: `git ${g.sub} from ${rev}`,
            order_id: originals.get(hit) as string,
          });
      }
    }
    if (g.sub === 'show' && c.redirects.some((r) => r.op.startsWith('>'))) {
      for (const spec of positional) {
        const rev = spec.includes(':') ? spec.slice(0, spec.indexOf(':')) : '';
        const hit = rev ? await resolvesTo(env, rev, origSet) : null;
        if (hit)
          findings.push({
            rule: 'R5',
            level: 'deny',
            detail: `git show ${spec} > …`,
            order_id: originals.get(hit) as string,
          });
      }
    }
    if (g.sub === 'apply' || g.sub === 'am') {
      await patchRule(env, c, positional, findings);
    }
  }
  // `patch` is not a git subcommand.
  for (const c of cmds) {
    if (base(c.argv[0] ?? '') !== 'patch') continue;
    const files: string[] = [];
    c.argv.forEach((x, i) => {
      if (x === '-i' || x === '--input') files.push(c.argv[i + 1] ?? '');
      else if (x.startsWith('--input=')) files.push(x.slice(8));
    });
    for (const r of c.redirects) if (r.op === '<') files.push(r.target);
    await patchRule(env, c, files, findings);
  }
  return dedupe(findings);
}

function dedupe(fs: ShellFinding[]): ShellFinding[] {
  const seen = new Set<string>();
  return fs.filter((f) => {
    const k = `${f.rule}|${f.detail}|${f.order_id ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function patchRule(env: ShellEnv, c: SimpleCommand, files: string[], findings: ShellFinding[]) {
  const stdinFiles = c.redirects.filter((r) => r.op === '<').map((r) => r.target);
  const candidates = [...new Set([...files, ...stdinFiles].filter(Boolean))];
  const texts: string[] = [];
  for (const f of candidates) {
    const t = env.readFile(resolve(env.cwd, f));
    if (t !== null) texts.push(t);
  }
  if (texts.length === 0) {
    findings.push({
      rule: 'R4',
      level: 'warn',
      detail: `${base(c.argv[0] ?? '')} with a patch DNR cannot read`,
    });
    return;
  }
  const proposed = new Map<string, string | null>();
  for (const t of texts) {
    let patches: ReturnType<typeof parsePatch> = [];
    try {
      patches = parsePatch(t);
    } catch {
      continue;
    }
    for (const p of patches) {
      const name = (p.newFileName && p.newFileName !== '/dev/null' ? p.newFileName : p.oldFileName) ?? '';
      const rel = name.replace(/^[ab]\//, '');
      if (!rel) continue;
      const cur = proposed.has(rel)
        ? (proposed.get(rel) ?? '')
        : (env.readFile(resolve(env.repoRoot, rel)) ?? '');
      const next = applyPatch(cur, p);
      if (next === false) continue;
      proposed.set(rel, p.newFileName === '/dev/null' ? null : next);
    }
  }
  if (proposed.size === 0) return;
  const hit = await env.patchMatches(proposed);
  if (hit) findings.push({ rule: 'R4', level: 'deny', detail: `patch re-applies ${hit}`, order_id: hit });
}

function boardPorts(ctx: HookContext): number[] {
  const ports = [ctx.config.board_port];
  try {
    const j = JSON.parse(readFileSync(ctx.store.paths.boardFile, 'utf8')) as { port?: unknown };
    if (typeof j.port === 'number') ports.push(j.port);
  } catch {}
  return ports;
}

/** Build the real ShellEnv for a hook invocation. */
async function shellEnvFor(
  ctx: HookContext,
  env: NodeJS.ProcessEnv,
  cwd: string,
  s: Session,
): Promise<ShellEnv> {
  const grants = new Set((await ctx.store.grants.applying(s, ctx.now())).map((g) => g.order_id));
  const orders = (await ctx.store.orders.list()).filter((o) => o.status === 'approved' && !grants.has(o.id));
  return {
    cwd,
    repoRoot: ctx.repoRoot,
    home: env.HOME ?? null,
    isProtected: (p) => isProtectedPath(ctx, env, p),
    orders,
    resolve: (rev) => tryResolve(ctx.repoRoot, rev),
    revList: (range) => revList(ctx.repoRoot, range),
    boardPorts: boardPorts(ctx),
    ordersDir: ctx.store.paths.ordersDir,
    readFile: (p) => {
      try {
        return existsSync(p) ? readFileSync(p, 'utf8') : null;
      } catch {
        return null;
      }
    },
    patchMatches: async (files) => {
      const relFiles = [...files.keys()];
      const ids = orders.filter((o) => filesOf(o).some((f) => relFiles.includes(f))).map((o) => o.id);
      if (ids.length === 0) return null;
      const parser = await loadParser();
      const cache = new UnitCache(parser);
      const reader = new BlobReader(ctx.repoRoot);
      const { entries } = await loadEntries(ctx, ids, reader, cache);
      const all = [...new Set(entries.flatMap((e) => filesOf(e.order)))];
      await reader.prefetch(all.map((f) => `${s.baseline_tree}:${f}`));
      const baseline = createState((f) => reader.get(s.baseline_tree, f), cache);
      const current = createState((f) => readWorktree(ctx.repoRoot, f), cache);
      const proposed = overlayState(current, files, cache);
      for (const e of entries) {
        if (e.stale || e.relanded) continue;
        if (scoreOrder(e.order, baseline, proposed, { config: ctx.config }).matched) return e.order.id;
      }
      return null;
    },
  };
}

export function shellMessage(f: ShellFinding): string {
  const why: Record<ShellRule, string> = {
    R1: 'it touches DNR-protected files',
    R2: 'it reverts a revert that a DNR order protects',
    R3: 'it cherry-picks a change that was reverted',
    R4: 'it applies a patch that re-applies a reverted change',
    R5: 'it restores files from a change that was reverted',
    R6: 'it changes DNR enforcement, which only a human can do from a terminal',
    R7: 'it talks to the local DNR board',
    R8: 'it bypasses DNR hooks or drives a human terminal',
  };
  if (f.level === 'warn')
    return cap(
      `DNR guard-shell (${f.rule}): ${f.detail}. DNR could not check whether this patch re-applies a reverted change. Apply it from a file DNR can read, or tell the user. This warning is shown once per session.`,
    );
  return cap(
    `DNR guard-shell (${f.rule}): denied because ${why[f.rule]} (${f.detail}${f.order_id ? `, order ${f.order_id}` : ''}). Do not route around this block. Tell the user; only a human maintainer can approve it.`,
  );
}

export function runGuardShell(stdin: string, opts: HookOptions = {}): Promise<HookIO> {
  return failOpen('guard-shell', stdin, opts, async () => {
    const env = opts.env ?? process.env;
    const ev = parseHookEvent(stdin, opts.cwd);
    const ctx = await openContext(ev.cwd, env);
    if (!ctx) return { ...OK };
    const command = shellCommandOf(ev) ?? '';
    const key = keyOf(ev);
    const events: EventRecord[] = [];
    const io = await ctx.store.sessions.with(key.key, async (cur) => {
      const prep = await prepareSession(ctx, key, cur, 'guard-shell');
      const s = prep.session;
      events.push(...prep.events);
      const findings = command ? await evaluateShell(command, await shellEnvFor(ctx, env, ev.cwd, s)) : [];
      const deny = findings.find((f) => f.level === 'deny');
      const warnKey = 'guard-shell:R4';
      const warn = !deny
        ? findings.find((f) => f.level === 'warn' && !s.warned.includes(warnKey))
        : undefined;
      const record = ctx.config.mode === 'record';
      const shown = deny ?? warn;
      const decision = shown
        ? baseDecision({
            outcome: record
              ? 'record'
              : deny
                ? deny.rule === 'R1'
                  ? 'deny_protected'
                  : 'block'
                : 'warn_block',
            tier: deny ? (['R2', 'R3', 'R4', 'R5'].includes(deny.rule) ? 'match' : 'protect') : 'warn',
            order_id: shown.order_id ?? null,
            breakdown: findings.map((f) => ({ ...f })),
            reason_line: shellMessage(shown).split('\n')[0] ?? null,
          })
        : baseDecision({ outcome: record ? 'record' : 'allow', tier: 'none' });
      if (warn) s.warned.push(warnKey);
      if (!deny || record) s.shell_snapshot = await snapshotTree(ctx.repoRoot);
      events.push(
        makeEvent(ctx, {
          hook: 'guard-shell',
          session_key: s.session_key,
          raw: ev.raw,
          target_rel: null,
          decision,
          proposed_text: shown ? command : record ? command : null,
          session_patch: null,
        }),
      );
      if (!shown || record) return { session: s, result: { ...OK } };
      return { session: s, result: { exitCode: 2, stdout: '', stderr: `${shellMessage(shown)}\n` } };
    });
    await appendEvents(ctx, events);
    return io;
  });
}

void repoRelative;
void sessionPatch;
