/** `dnr guard-shell --stdin`, `dnr session start|confirm|shell-after|show|end|gc`, `dnr allow`. */
import {
  grantOrigin,
  parseHookEvent,
  runGuardShell,
  runSessionConfirm,
  runSessionStart,
  runShellAfter,
  sessionEnd,
  sessionGc,
  sessionShow,
} from '@dnr/hook';
import { nowIso, nowMs, parseTtl } from '@dnr/store';
import { parse, str } from '../args';
import { repoContext, requireHuman } from '../context';
import { CliError, EXIT, usage } from '../errors';
import type { CliIO } from '../io';

function write(io: CliIO, r: { exitCode: number; stdout: string; stderr: string }): number {
  if (r.stdout) io.out(r.stdout);
  if (r.stderr) io.err(r.stderr);
  return r.exitCode;
}

export async function cmdGuardShell(argv: string[], io: CliIO): Promise<number> {
  const { values: v } = parse(argv, { stdin: { type: 'boolean' } });
  if (v.help || !v.stdin) {
    io.out('dnr guard-shell --stdin    PreToolUse shell hook (§5.10)\n');
    return v.help ? EXIT.OK : EXIT.USAGE;
  }
  return write(io, await runGuardShell(await io.readStdin(), { env: io.env, cwd: io.cwd }));
}

const SESSION_HELP = `dnr session start --stdin         SessionStart hook
dnr session confirm --stdin       PostToolUse write hook (turns an approved ask into a grant)
dnr session shell-after --stdin   PostToolUse shell hook (adds changed files to touched)
dnr session show [--all] [--session-id <id>]
dnr session end [--stdin]         end a session (humans only without --stdin)
dnr session gc                    remove idle sessions and expired grants (humans only)`;

export async function cmdSession(argv: string[], io: CliIO): Promise<number> {
  const [sub, ...rest] = argv;
  const { values: v } = parse(rest, {
    stdin: { type: 'boolean' },
    all: { type: 'boolean' },
    'session-id': { type: 'string' },
  });
  if (!sub || v.help || sub.startsWith('-')) {
    io.out(`${SESSION_HELP}\n`);
    return sub ? EXIT.OK : EXIT.USAGE;
  }
  const hookOpts = { env: io.env, cwd: io.cwd };
  switch (sub) {
    case 'start':
      return write(io, await runSessionStart(v.stdin ? await io.readStdin() : '{}', hookOpts));
    case 'confirm':
      if (!v.stdin) throw usage('dnr session confirm --stdin');
      return write(io, await runSessionConfirm(await io.readStdin(), hookOpts));
    case 'shell-after':
      if (!v.stdin) throw usage('dnr session shell-after --stdin');
      return write(io, await runShellAfter(await io.readStdin(), hookOpts));
    case 'show': {
      await repoContext(io);
      const list = await sessionShow({
        cwd: io.cwd,
        env: io.env,
        sessionId: str(v['session-id']) ?? null,
        all: !!v.all,
      });
      io.out(`${JSON.stringify(list ?? [], null, 2)}\n`);
      return EXIT.OK;
    }
    case 'end': {
      let sessionId: string | null = str(v['session-id']) ?? null;
      let cwd = io.cwd;
      if (v.stdin) {
        const ev = parseHookEvent(await io.readStdin(), io.cwd);
        sessionId = ev.session_id;
        cwd = ev.cwd;
      } else requireHuman(io, 'session end');
      const ok = await sessionEnd({ cwd, env: io.env, sessionId });
      if (!v.stdin) io.out(ok ? 'DNR: session ended.\n' : 'DNR: no such session.\n');
      return EXIT.OK;
    }
    case 'gc': {
      requireHuman(io, 'session gc');
      await repoContext(io);
      const r = await sessionGc({ cwd: io.cwd, env: io.env });
      io.out(`DNR: removed ${r.sessions} idle session(s) and ${r.grants} expired grant(s).\n`);
      return EXIT.OK;
    }
    default:
      throw usage(`dnr session: unknown subcommand ${sub}\n${SESSION_HELP}`);
  }
}

export async function cmdAllow(argv: string[], io: CliIO): Promise<number> {
  const { values: v, positionals } = parse(argv, {
    confirm: { type: 'boolean' },
    ttl: { type: 'string' },
    by: { type: 'string' },
    orders: { type: 'string' },
  });
  if (v.help) {
    io.out(
      'dnr allow <order_id> [--ttl 1h]   allow-once grant for the current or next session (humans only)\ndnr allow --confirm <order_id>      confirm a suspect grant so it applies (humans only)\n',
    );
    return EXIT.OK;
  }
  const id = positionals[0];
  if (!id || positionals.length > 1) throw usage('dnr allow <order_id> [--ttl 1h]');
  requireHuman(io, 'allow');
  let ttl: number;
  try {
    ttl = parseTtl(str(v.ttl) ?? '1h');
  } catch (e) {
    throw usage(String((e as Error).message));
  }
  const ctx = await repoContext(io, { ...(v.orders ? { orders: str(v.orders) as string } : {}) });
  if (v.confirm) {
    // Wave-3 N5: a human confirms a suspect grant so it applies.
    const done = await ctx.store.grants.confirm(
      id,
      undefined,
      str(v.by) ?? io.env.USER ?? 'human',
      nowIso(io.env),
    );
    if (done.length === 0) throw new CliError(`DNR: no unconfirmed suspect grant for ${id}`, EXIT.FINDINGS);
    for (const g of done)
      io.out(
        `DNR: confirmed the suspect grant for ${id} (${g.origin?.markers.join(', ')}); it now applies.\n`,
      );
    return EXIT.OK;
  }
  const order = await ctx.store.orders.get(id);
  if (!order) throw new CliError(`DNR: no order ${id}`, EXIT.USAGE);
  const at = nowMs(io.env);
  const origin = await grantOrigin({
    via: 'cli',
    store: ctx.store,
    env: io.env,
    now: at,
    ...(io.processChain ? { chain: io.processChain() } : {}),
    ...(io.isTTY ? { isTTY: io.isTTY() } : {}),
  });
  const g = await ctx.store.grants.create({
    order_id: id,
    kind: 'allow_once',
    session_key: null,
    granted_by: str(v.by) ?? io.env.USER ?? 'human',
    ttl_ms: ttl,
    at,
    origin,
  });
  if (origin.suspect)
    io.err(
      `DNR: this grant is flagged suspect (${origin.markers.join(', ')}) and does not apply until a human confirms it: \`dnr allow --confirm ${id}\` from your own terminal, or Confirm on the board.\n`,
    );
  if (order.status !== 'approved')
    io.err(`DNR: note: ${id} is ${order.status}, so it does not block anyway.\n`);
  io.out(`DNR: allowed ${id} once, for the current or next agent session, until ${g.expires_at}.\n`);
  return EXIT.OK;
}
