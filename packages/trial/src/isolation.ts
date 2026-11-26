/**
 * Run isolation (§9.3 isolation amendment, 2026-11-27; audit finding T1). A same-user agent can
 * read anything the harness can, so real runs need one of:
 * - `os-user`: the agent runs as a dedicated OS user (default `dnrtrial`) through a root-owned
 *   launcher that sudoers lets the harness user run without a password. That user can read only
 *   its run's worktree and HOME (ACLs set by the harness, which owns them: macOS `chmod +a`,
 *   Linux `setfacl`; no root at run time; refused where neither exists). Hooks reach the harness through a FIFO relay (relay.ts).
 * - `sandbox`: `kiro-cli --sandbox`, allowed only when spike S1 records that it confines the file
 *   and shell tools (`fixtures/s1.json`).
 * `none` is allowed only for dry runs, which never start an agent.
 *
 * One-time setup for `os-user` (the human runs these; the harness never does):
 *   sudo dscl . -create /Users/dnrtrial                       # or System Settings → Users
 *   sudo dscl . -create /Users/dnrtrial UserShell /bin/sh
 *   sudo dscl . -create /Users/dnrtrial UniqueID 5501 && sudo dscl . -create /Users/dnrtrial PrimaryGroupID 20
 *   sudo dscl . -create /Users/dnrtrial NFSHomeDirectory /var/empty
 *   sudo install -o root -g wheel -m 0755 scripts/trial/dnr-trial-agent.sh /usr/local/libexec/dnr-trial-agent
 *   echo "$(id -un) ALL=(dnrtrial) NOPASSWD: /usr/local/libexec/dnr-trial-agent" | sudo tee /etc/sudoers.d/dnr-trial
 *   sudo chmod 0440 /etc/sudoers.d/dnr-trial
 *   # kiro-cli must be installed where dnrtrial can execute it (e.g. /usr/local/bin/kiro-cli)
 * `dnr trial run` then checks all of this (`osUserPreflight`) before any run starts.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { type AclMechanism, aclMechanism, grantAcl } from './acl';

export type Isolation = 'none' | 'os-user' | 'sandbox';
export const ISOLATIONS: readonly Isolation[] = ['none', 'os-user', 'sandbox'];
export const DEFAULT_AGENT_USER = 'dnrtrial';
export const DEFAULT_LAUNCHER = '/usr/local/libexec/dnr-trial-agent';

/** `fixtures/s1.json`, written when spike S1 runs (Kiro workstream). */
export const S1 = z.strictObject({
  /** `kiro-cli --sandbox` confines both the file and the shell tools to the working directory. */
  sandbox_confines_file_and_shell: z.boolean(),
  recorded_by: z.string().min(1),
  recorded_at: z.string().min(1),
  evidence: z.string().min(1),
});
export type S1 = z.infer<typeof S1>;

export function loadS1(root: string): S1 | null {
  const p = join(root, 'fixtures/s1.json');
  return existsSync(p) ? S1.parse(JSON.parse(readFileSync(p, 'utf8'))) : null;
}

export class IsolationError extends Error {
  constructor(m: string) {
    super(m);
    this.name = 'IsolationError';
  }
}

/**
 * T1(d): real runs and prereg need `os-user`, or `sandbox` with S1 recorded as confining.
 * `none` only with --dry-run (no agent is started).
 */
export const NO_ACL =
  'isolation os-user needs owner-set ACLs (macOS chmod +a, or Linux setfacl from the acl package); none is available here';

export function requireIsolation(
  mode: Isolation,
  opts: { dryRun: boolean; s1: S1 | null; acl?: AclMechanism | null },
): void {
  if (mode === 'os-user' && (opts.acl === undefined ? aclMechanism() : opts.acl) === null)
    throw new IsolationError(NO_ACL);
  if (opts.dryRun) return;
  if (mode === 'os-user') return;
  if (mode === 'sandbox') {
    if (opts.s1?.sandbox_confines_file_and_shell === true) return;
    throw new IsolationError(
      opts.s1
        ? 'isolation sandbox: spike S1 recorded that `kiro-cli --sandbox` does not confine file and shell tools; use --isolation os-user'
        : 'isolation sandbox is unverified: spike S1 is not recorded (fixtures/s1.json); use --isolation os-user',
    );
  }
  throw new IsolationError(
    'a same-user agent can read the harness files (§9.3 isolation amendment): real runs need --isolation os-user (or sandbox once S1 confirms it); --isolation none is for --dry-run only',
  );
}

export function parseIsolation(v: unknown): Isolation {
  const s = (v ?? 'none') as string;
  if (!(ISOLATIONS as readonly string[]).includes(s))
    throw new IsolationError(`--isolation is ${ISOLATIONS.join(', ')}`);
  return s as Isolation;
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (e, so, se) => {
      const c = e
        ? typeof (e as { code?: unknown }).code === 'number'
          ? ((e as { code: number }).code as number)
          : 127
        : 0;
      resolve({ code: c, out: String(so), err: String(se) });
    });
  });
}

export interface OsUser {
  user: string;
  launcher: string;
}

/** The sudo prefix for the agent: `sudo -n -u <user> <launcher> <mode> …`. */
export function sudoArgs(
  o: OsUser,
  mode: 'run' | 'probe' | 'check',
  rest: string[],
): { cmd: string; args: string[] } {
  return { cmd: 'sudo', args: ['-n', '-u', o.user, o.launcher, mode, ...rest] };
}

/**
 * Checks, before any run: the user exists, the launcher is root-owned and not writable by
 * others, sudo runs it without a password, the agent user can read and write its own dirs, and
 * it can read none of `forbidden` (the dnr repo, the Django clone, other runs, $TRIAL_ROOT itself).
 */
export async function osUserPreflight(
  o: OsUser,
  own: { workdir: string; home: string },
  forbidden: readonly string[],
): Promise<string[]> {
  const problems: string[] = [];
  const id = await run('id', ['-u', o.user]);
  if (id.code !== 0)
    return [`OS user ${o.user} does not exist (see the one-time setup in packages/trial/src/isolation.ts)`];
  if (!existsSync(o.launcher)) return [`launcher ${o.launcher} is not installed`];
  const st = statSync(o.launcher);
  if (st.uid !== 0 || (st.mode & 0o022) !== 0)
    problems.push(`${o.launcher} must be owned by root and not group/other writable`);
  const chk = sudoArgs(o, 'check', []);
  const c = await run(chk.cmd, chk.args);
  if (c.code !== 0)
    return [
      ...problems,
      `sudo -n -u ${o.user} ${o.launcher} failed (sudoers rule missing?): ${c.err.trim().slice(0, 200)}`,
    ];
  const probe = async (p: string, want: 'rw' | 'none') => {
    const a = sudoArgs(o, 'probe', [want, p]);
    const r = await run(a.cmd, a.args);
    if (r.code !== 0) problems.push(`${o.user} ${want === 'rw' ? 'cannot use' : 'can read'} ${p}`);
  };
  await probe(own.workdir, 'rw');
  await probe(own.home, 'rw');
  for (const f of forbidden) await probe(f, 'none');
  return problems;
}

/**
 * Gives the agent user its run's worktree and HOME and nothing else (owner-set macOS ACLs, no
 * root): traversal-only (0711) on the ancestors under $TRIAL_ROOT, `o-rwx` on the run's tree, an
 * inherited ACL for the agent user, and an inherited ACL for the harness user so files the agent
 * creates stay readable to the harness.
 */
export async function grantRunDirs(input: {
  trialRoot: string;
  dirs: string[];
  agentUser: string;
  harnessUser: string;
}): Promise<void> {
  if (!aclMechanism()) throw new IsolationError(NO_ACL);
  for (const d of input.dirs) {
    // ancestors: traverse only
    let cur = d;
    while (cur.startsWith(input.trialRoot) && cur !== input.trialRoot) {
      cur = join(cur, '..');
      chmodSync(cur, 0o711);
    }
    const r1 = await run('chmod', ['-R', 'o-rwx', d]);
    if (r1.code !== 0) throw new IsolationError(`chmod -R o-rwx ${d}: ${r1.err.trim()}`);
    for (const u of [input.agentUser, input.harnessUser]) {
      try {
        await grantAcl(u, 'full', d);
      } catch (e) {
        throw new IsolationError((e as Error).message.trim());
      }
    }
  }
}

/** Removes others' access below $TRIAL_ROOT for everything the agent must not see (T1(f)). */
export async function closeOthers(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  const r = await run('chmod', ['-R', 'o-rwx', dir]);
  if (r.code !== 0) throw new IsolationError(`chmod -R o-rwx ${dir}: ${r.err.trim()}`);
}
