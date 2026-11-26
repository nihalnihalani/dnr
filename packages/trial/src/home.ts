/**
 * §9.3 per-run HOME: the S8 credential file, the arm's hook bundle in `$HOME/.kiro/hooks/`, and
 * the arm's agent config (with the pinned model) in `$HOME/.kiro/agents/`. `$HOME/.kiro` is
 * hashed after seeding and after the run, excluding the globs S8 recorded as Kiro's own writes.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { Arm } from '@dnr/schemas';
import { z } from 'zod';
import { type Bundle, bundleOf } from './arms';
import { sha256Hex } from './prng';
import { clientScript } from './relay';

/**
 * Spike S8 outputs (`fixtures/s8.json`, committed by the Kiro workstream once S8 runs). Until it
 * exists the harness uses no credential file and no exclusion globs, and says so in meta.json.
 */
export const S8 = z.strictObject({
  /** Path of the credential file headless kiro-cli reads, relative to HOME (e.g. `.kiro/credentials.json`). */
  credential_rel: z.string().nullable(),
  /** Globs (relative to `$HOME/.kiro`) Kiro writes during a run; excluded from the HOME hash. */
  kiro_write_globs: z.array(z.string()),
  /** Whether hook commands inherit the environment of kiro-cli (informational: hooks get DNR paths on their command line either way). */
  hooks_inherit_env: z.boolean().nullable(),
});
export type S8 = z.infer<typeof S8>;

export function loadS8(root: string): { s8: S8; source: string } {
  const p = join(root, 'fixtures/s8.json');
  if (existsSync(p)) return { s8: S8.parse(JSON.parse(readFileSync(p, 'utf8'))), source: 'fixtures/s8.json' };
  return {
    s8: { credential_rel: null, kiro_write_globs: [], hooks_inherit_env: null },
    source: 'pending (spike S8)',
  };
}

export interface HookEnv {
  DNR_MODE: string;
  DNR_STATE_DIR: string;
  DNR_ORDERS: string;
  DNR_CONFIG: string;
  DNR_RECORD_PATH: string;
}

interface HookDef {
  name: string;
  trigger: 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'Stop';
  matcher?: string;
  args: string;
  timeout: number;
}

/** Hook set per bundle. Commands match `.kiro/hooks/dnr-*.json`; record arms never block. */
export const BUNDLES: Record<Exclude<Bundle, 'none'>, HookDef[]> = {
  // Record-only (design: pre-write and post-shell under DNR_MODE=record).
  record: [
    {
      name: 'dnr-pre-write',
      trigger: 'PreToolUse',
      matcher: 'write',
      args: 'check --stdin --hook kiro',
      timeout: 10,
    },
    {
      name: 'dnr-post-shell',
      trigger: 'PostToolUse',
      matcher: 'shell',
      args: 'session shell-after --stdin',
      timeout: 10,
    },
  ],
  // L: enforcing pre-write, guard-shell, post-shell, session-start and Stop, deny format (§9.2).
  live: [
    { name: 'dnr-session-start', trigger: 'SessionStart', args: 'session start --stdin', timeout: 10 },
    {
      name: 'dnr-pre-write',
      trigger: 'PreToolUse',
      matcher: 'write',
      args: 'check --stdin --hook kiro',
      timeout: 10,
    },
    {
      name: 'dnr-guard-shell',
      trigger: 'PreToolUse',
      matcher: 'shell',
      args: 'guard-shell --stdin',
      timeout: 10,
    },
    {
      name: 'dnr-post-shell',
      trigger: 'PostToolUse',
      matcher: 'shell',
      args: 'session shell-after --stdin',
      timeout: 10,
    },
    {
      name: 'dnr-stop-backstop',
      trigger: 'Stop',
      args: 'check --worktree --hook stop --max-forced-turns 2',
      timeout: 30,
    },
  ],
};

const shq = (s: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * The hook command. The DNR_* variables are written inline with `env`, so the hook sees them
 * whether or not S8 finds that hooks inherit kiro-cli's environment.
 */
export function hookCommand(dnr: string[], args: string, env: HookEnv | null): string {
  const pre = env
    ? `env ${Object.entries(env)
        .map(([k, v]) => `${k}=${shq(v)}`)
        .join(' ')} `
    : '';
  return `${pre}${dnr.map(shq).join(' ')} ${args}`;
}

/** os-user isolation: the hook command is the relay client in the run HOME (relay.ts). */
export function relayCommand(home: string, args: string): string {
  return `/bin/sh ${shq(join(home, '.kiro', 'dnr-relay.sh'))} ${args}`;
}

/**
 * Hook files for a bundle, `{ "<name>.json": <Kiro hook file> }` (format of `.kiro/hooks/dnr-*.json`).
 * T1(a): DNR paths appear only on the hook command line, never in the agent's environment. With
 * `relayHome` (os-user isolation) the command is the relay client and names no DNR path at all.
 */
export function bundleFiles(
  bundle: Bundle,
  dnr: string[],
  env: HookEnv | null,
  relayHome: string | null = null,
): Record<string, unknown> {
  if (bundle === 'none') return {};
  const out: Record<string, unknown> = {};
  for (const h of BUNDLES[bundle])
    out[`${h.name}.json`] = {
      version: 'v1',
      hooks: [
        {
          name: h.name,
          trigger: h.trigger,
          ...(h.matcher ? { matcher: h.matcher } : {}),
          action: {
            type: 'command',
            command: relayHome ? relayCommand(relayHome, h.args) : hookCommand(dnr, h.args, env),
          },
          timeout: h.timeout,
          enabled: true,
        },
      ],
    };
  return out;
}

/** sha256 of a bundle's template (placeholders for per-run paths), hashed in prereg-v1. */
export function bundleTemplateHash(bundle: Bundle, relay = false): string {
  if (relay) return sha256Hex(JSON.stringify(bundleFiles(bundle, ['<DNR>'], null, '<HOME>')));
  const env: HookEnv = {
    DNR_MODE: bundle === 'live' ? 'enforce' : 'record',
    DNR_STATE_DIR: '<TRIAL_ROOT>/state/<RUN_ID>',
    DNR_ORDERS: '<TRIAL_ROOT>/orders/<RUN_ID>',
    DNR_CONFIG: '<TRIAL_ROOT>/config.json',
    DNR_RECORD_PATH: '<TRIAL_ROOT>/state/<RUN_ID>/events.jsonl',
  };
  return sha256Hex(JSON.stringify(bundleFiles(bundle, ['<DNR>'], bundle === 'none' ? null : env)));
}

export class PinError extends Error {
  constructor(m: string) {
    super(m);
    this.name = 'PinError';
  }
}

/**
 * The agent config written into the run HOME: `trial/agents/<agent>.json` with `model` set to
 * the pin. A config that already names a model must name the pin (task 0.4).
 */
export function agentConfigFor(root: string, agent: string, model: string): Record<string, unknown> {
  const src = join(root, 'trial/agents', `${agent}.json`);
  const cfg = JSON.parse(readFileSync(src, 'utf8')) as Record<string, unknown>;
  if (cfg.name !== agent) throw new PinError(`${src}: name ${String(cfg.name)} ≠ ${agent}`);
  if (typeof cfg.model === 'string' && cfg.model !== model)
    throw new PinError(`${src}: model ${cfg.model} ≠ pinned ${model}`);
  const tools = Array.isArray(cfg.tools) ? (cfg.tools as unknown[]) : [];
  if (tools.some((t) => typeof t === 'string' && /web|fetch|search|browser/i.test(t)))
    throw new PinError(`${src}: trial agents get file and shell tools only (§9.3)`);
  return { ...cfg, model };
}

export interface SeedInput {
  root: string;
  home: string;
  arm: Arm;
  agent: string;
  model: string;
  dnr: string[];
  env: HookEnv | null;
  s8: S8;
  /** Absolute path of the credential file to copy (S8), or null. */
  credentialFrom: string | null;
  /** os-user isolation: the relay directory the hook client talks to (relay.ts). */
  relayDir: string | null;
}

export async function seedHome(i: SeedInput): Promise<void> {
  await rm(i.home, { recursive: true, force: true });
  await mkdir(join(i.home, '.kiro', 'agents'), { recursive: true });
  const cfg = agentConfigFor(i.root, i.agent, i.model);
  await writeFile(join(i.home, '.kiro', 'agents', `${i.agent}.json`), `${JSON.stringify(cfg, null, 2)}\n`);
  const files = bundleFiles(bundleOf(i.arm), i.dnr, i.env, i.relayDir ? i.home : null);
  if (Object.keys(files).length > 0) {
    await mkdir(join(i.home, '.kiro', 'hooks'), { recursive: true });
    for (const [n, body] of Object.entries(files))
      await writeFile(join(i.home, '.kiro', 'hooks', n), `${JSON.stringify(body, null, 2)}\n`);
  }
  if (i.credentialFrom && i.s8.credential_rel) {
    const dst = join(i.home, i.s8.credential_rel);
    await mkdir(join(dst, '..'), { recursive: true });
    copyFileSync(i.credentialFrom, dst);
  }
  // No sidecar with DNR paths in HOME (T1(a)): the hook command line carries them.
  if (i.relayDir && Object.keys(files).length > 0)
    await writeFile(join(i.home, '.kiro', 'dnr-relay.sh'), clientScript(i.relayDir), { mode: 0o755 });
}

/** Minimal glob: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function walk(dir: string, base: string, out: string[]): void {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
}

/** sha256 over (path, sha256(content)) of every file under `$HOME/.kiro`, minus the S8 globs. */
export function hashKiroDir(home: string, excludeGlobs: readonly string[]): { hash: string; files: number } {
  const dir = join(home, '.kiro');
  if (!existsSync(dir)) return { hash: sha256Hex(''), files: 0 };
  const res = excludeGlobs.map(globToRegExp);
  const all: string[] = [];
  walk(dir, dir, all);
  const kept = all.filter((p) => !res.some((r) => r.test(p)));
  const lines = kept.map((p) => `${p}\0${sha256Hex(readFileSync(join(dir, p)))}`);
  return { hash: sha256Hex(lines.join('\n')), files: kept.length };
}

/** sha256 of an order-set directory (file names and contents), hashed before and after each run. */
export function hashDir(dir: string): string {
  if (!existsSync(dir)) return sha256Hex('');
  const all: string[] = [];
  walk(dir, dir, all);
  return sha256Hex(all.map((p) => `${p}\0${sha256Hex(readFileSync(join(dir, p)))}`).join('\n'));
}

export const fileName = basename;
