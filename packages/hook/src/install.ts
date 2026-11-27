/**
 * Wave-3 N2: paths that control what runs when Kiro invokes a DNR hook. A write tool must not
 * replace DNR's own code, a `dnr` shim on PATH, or a shell startup file a hook shell may source.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const RC_FILES = [
  '.zshenv',
  '.zprofile',
  '.zshrc',
  '.zlogin',
  '.bash_profile',
  '.bashrc',
  '.bash_login',
  '.profile',
  '.kshrc',
  '.cshrc',
  '.tcshrc',
];

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** The installed package root of the running CLI (`…/dnr-guard`), or null when not bundled. */
export function installRoot(env: NodeJS.ProcessEnv): string | null {
  const self = env.DNR_SELF ?? process.argv[1] ?? '';
  if (!/[\\/]dist[\\/]cli\.m?js$/.test(self)) return null;
  return dirname(dirname(real(self)));
}

/**
 * Production audit P3: the `node` binary every hook command runs, and the global module tree next
 * to it. Under nvm, Homebrew or Volta both are user-writable, and a hook that cannot execute exits
 * 126/127, which Kiro treats as warn-and-allow. Both the path as written and its realpath count.
 */
export function nodePaths(node: string = process.execPath): string[] {
  const out = new Set<string>();
  for (const p of [node, real(node)]) {
    out.add(p);
    out.add(`${join(dirname(dirname(p)), 'lib', 'node_modules')}/**`);
  }
  return [...out];
}

export function installGlobs(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [...nodePaths()];
  const root = installRoot(env);
  if (root) out.push(`${root}/**`);
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue;
    for (const name of ['dnr', 'dnr-guard']) {
      const p = join(dir, name);
      if (existsSync(p)) {
        out.push(p, real(p));
      }
    }
  }
  const home = env.HOME;
  if (home) {
    const h = real(home);
    for (const f of RC_FILES) out.push(join(h, f));
    out.push(`${join(h, '.config', 'fish')}/**`, `${join(h, '.config', 'dnr')}/**`);
    try {
      for (const n of readdirSync(h)) if (/^\.(zsh|bash)_?env/.test(n)) out.push(join(h, n));
    } catch {}
  }
  return out;
}

/** sha256 over every file in the bundle's directory (the entry and its chunks), or null. */
export function bundleSha256(cli: string): string | null {
  try {
    const dir = dirname(cli);
    const h = createHash('sha256');
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n);
      if (!statSync(p).isFile()) continue;
      h.update(`${n}\0`).update(readFileSync(p)).update('\0');
    }
    return h.digest('hex');
  } catch {
    return null;
  }
}

export interface InstallRecord {
  node: string;
  cli: string;
  sha256: string | null;
  /** sha256 of the node binary (its realpath) the hooks run; absent in records from before P3. */
  node_sha256?: string | null;
}

/** sha256 of one file, read in chunks (the node binary is ~100 MB), or null. */
export function fileSha256(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(real(path), 'r');
    const h = createHash('sha256');
    const buf = Buffer.alloc(1 << 22);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
    return h.digest('hex');
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Compare the recorded bundle hash with the bundle on disk (wave-3 N2). Null when it matches. */
export function installMismatch(repoRoot: string, stateDir: string): string | null {
  for (const f of [join(stateDir, 'install.json'), join(repoRoot, '.dnr', 'install.json')]) {
    let rec: InstallRecord;
    try {
      rec = JSON.parse(readFileSync(f, 'utf8')) as InstallRecord;
    } catch {
      continue;
    }
    if (rec.node_sha256) {
      const n = fileSha256(rec.node);
      if (n === null) return `the node binary recorded at init (${rec.node}) is missing`;
      if (n !== rec.node_sha256)
        return `the node binary at ${rec.node} changed since \`dnr init\` (sha256 differs)`;
    }
    if (!rec.sha256) return null;
    const now = bundleSha256(rec.cli);
    if (now === null) return `the DNR bundle recorded at init (${rec.cli}) is missing`;
    if (now !== rec.sha256) return `the DNR bundle at ${rec.cli} changed since \`dnr init\` (sha256 differs)`;
    return null;
  }
  return null;
}
