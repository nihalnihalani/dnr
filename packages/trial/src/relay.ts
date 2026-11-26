/**
 * Hook relay for `--isolation os-user` (T1(b)). The agent user cannot read the order set, state
 * or config, and cannot run the harness's `dnr` (its Node lives under the harness user's home).
 * So the hook command in the run HOME is a /bin/sh client that hands the event to a relay server
 * running as the harness user, over FIFOs the harness owns:
 *
 *   lock/   mkdir lock (one hook at a time per run)
 *   req     client → server: one line of hook arguments, then the hook's stdin, then EOF
 *   out     server → client: the hook's stdout
 *   err     server → client: the hook's stderr
 *   code    server → client: the hook's exit code
 *
 * The server only runs the hook commands of the run's bundle (exact argument allowlist), with the
 * run's DNR_* paths, and logs every request. No setuid binary, no root at run time.
 */
import { execFile, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { grantAcl } from './acl';
import { BUNDLES, type HookEnv } from './home';

export const RELAY_FIFOS = ['req', 'out', 'err', 'code'] as const;

/** Every hook argument list a bundle may send (the server refuses anything else). */
export function allowedArgs(): Set<string> {
  return new Set([...BUNDLES.record, ...BUNDLES.live].map((h) => h.args));
}

/** The client script written into `$HOME/.kiro/dnr-relay.sh`. */
export function clientScript(relayDir: string): string {
  const d = `'${relayDir.replace(/'/g, `'\\''`)}'`;
  return [
    '#!/bin/sh',
    '# DNR trial hook relay client (§9.3 isolation amendment): forwards this hook to the harness.',
    `d=${d}`,
    'until mkdir "$d/lock/held" 2>/dev/null; do sleep 0.05; done',
    'trap \'rmdir "$d/lock/held"\' EXIT',
    'cat "$d/out" &',
    'o=$!',
    'cat "$d/err" >&2 &',
    'e=$!',
    '{ printf \'%s\\n\' "$*"; cat; } > "$d/req"',
    'wait $o $e',
    'read code < "$d/code"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
    'exit "${code:-0}"',
    '',
  ].join('\n');
}

function sh(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (e, _o, se) =>
      e ? reject(new Error(`${cmd} ${args.join(' ')}: ${se || e.message}`)) : resolve(),
    );
  });
}

/**
 * Creates the relay directory. With an agent user, ACLs give it search on the directory, write on
 * `req`, read on `out`/`err`/`code`, and create/remove inside `lock/` only.
 */
export async function makeRelayDir(dir: string, agentUser: string | null): Promise<void> {
  mkdirSync(join(dir, 'lock'), { recursive: true });
  for (const f of RELAY_FIFOS)
    if (!existsSync(join(dir, f))) await sh('mkfifo', ['-m', '0600', join(dir, f)]);
  await sh('chmod', ['0711', dir]);
  await sh('chmod', ['0700', join(dir, 'lock')]);
  if (!agentUser) return;
  await grantAcl(agentUser, 'search', dir);
  await grantAcl(agentUser, 'lockdir', join(dir, 'lock'));
  await grantAcl(agentUser, 'write', join(dir, 'req'));
  for (const f of ['out', 'err', 'code']) await grantAcl(agentUser, 'read', join(dir, f));
}

export interface RelayConfig {
  relayDir: string;
  workdir: string;
  dnr: string[];
  env: HookEnv;
  log: string;
}

/** Handles one request (blocking FIFO I/O; runs in the dedicated relay process). */
export function serveOnce(c: RelayConfig, allowed = allowedArgs()): void {
  const req = readFileSync(join(c.relayDir, 'req'));
  const nl = req.indexOf(10);
  const args = (nl < 0 ? req : req.subarray(0, nl)).toString('utf8').trim();
  const stdin = nl < 0 ? Buffer.alloc(0) : req.subarray(nl + 1);
  let out = Buffer.alloc(0);
  let err = Buffer.from('');
  let code = 0;
  if (!allowed.has(args)) {
    err = Buffer.from(`DNR relay: refused hook arguments "${args.slice(0, 120)}"\n`);
    code = 64;
  } else {
    const r = spawnSync(c.dnr[0] as string, [...c.dnr.slice(1), ...args.split(' ')], {
      cwd: c.workdir,
      input: stdin,
      env: { ...process.env, ...c.env },
      maxBuffer: 64 << 20,
    });
    out = r.stdout ?? out;
    err = r.stderr ?? err;
    code = r.status ?? 70;
  }
  appendFileSync(
    c.log,
    `${JSON.stringify({ at: new Date().toISOString(), args, code, bytes_in: stdin.length })}\n`,
  );
  writeFileSync(join(c.relayDir, 'out'), out);
  writeFileSync(join(c.relayDir, 'err'), err);
  writeFileSync(join(c.relayDir, 'code'), `${code}\n`);
}

/** `dnr trial __relay <config.json>`: serve until killed. */
export function serveForever(c: RelayConfig): never {
  const allowed = allowedArgs();
  for (;;) serveOnce(c, allowed);
}
