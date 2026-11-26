/**
 * `dnr init [repo] [--mode] [--decision-format] [--hooks pre-write|all] [--crew] [--force]` (§8).
 * Idempotent: a second run changes nothing. Existing files that differ are kept unless --force,
 * and an existing pre-commit hook is never replaced.
 */
import { chmodSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { findRepoRoot, gitPath } from '@dnr/git';
import { bundleSha256 } from '@dnr/hook';
import { DnrConfig } from '@dnr/schemas';
import { openStore } from '@dnr/store';
import { createTwoFilesPatch } from 'diff';
import { parse, str } from '../args';
import { packagePath } from '../assets';
import { requireHuman } from '../context';
import { CliError, EXIT, invalidData, usage } from '../errors';
import { crewWorkflow, DNR_HOOKS, GITIGNORE_LINES, hookText, preCommitShim } from '../hooks';
import type { CliIO } from '../io';
import { dnrRules, mergePermissions, permissionsFile } from '../permissions';

/** Paths npx / pnpm dlx / bunx run packages from; hooks pointing there would silently fail open later. */
export function isEphemeralInstall(p: string): boolean {
  return /[\\/]_npx[\\/]|[\\/]\.npm[\\/]_npx|npm-cache[\\/]_npx|[\\/]pnpm[\\/]dlx|[\\/]dlx-[^\\/]+[\\/]|[\\/]\.bun[\\/]install[\\/]cache|[\\/]bunx-/.test(
    p,
  );
}

type Status = 'created' | 'updated' | 'unchanged' | 'kept';

export async function cmdInit(argv: string[], io: CliIO): Promise<number> {
  const { values: v, positionals } = parse(argv, {
    mode: { type: 'string' },
    'decision-format': { type: 'string' },
    hooks: { type: 'string' },
    crew: { type: 'boolean' },
    'crew-repo': { type: 'string' },
    force: { type: 'boolean' },
    'no-permissions': { type: 'boolean' },
  });
  if (v.help) {
    io.out(
      'dnr init [repo] [--mode enforce|warn-only|commit-enforce] [--decision-format deny|ask] [--hooks pre-write|all] [--crew] [--force]\n',
    );
    return EXIT.OK;
  }
  if (positionals.length > 1) throw usage('dnr init [repo]');
  if (isEphemeralInstall(io.scriptPath))
    throw new CliError(
      `DNR: refusing to install hooks from a temporary npx/dlx path (${io.scriptPath}). Hooks would point at a cache that disappears and then silently fail open. Install DNR first: npm i -g dnr-guard, then run dnr init.`,
      EXIT.DEPENDENCY,
    );
  const mode = str(v.mode);
  if (mode && !['enforce', 'warn-only', 'commit-enforce'].includes(mode))
    throw usage(`dnr init: --mode ${mode} is not enforce, warn-only or commit-enforce`);
  const fmt = str(v['decision-format']);
  if (fmt && !['deny', 'ask'].includes(fmt))
    throw usage(`dnr init: --decision-format ${fmt} is not deny or ask`);
  const hooksSel = str(v.hooks) ?? 'all';
  if (!['all', 'pre-write'].includes(hooksSel))
    throw usage(`dnr init: --hooks ${hooksSel} is not pre-write or all`);
  requireHuman(io, 'init');

  const target = resolve(io.cwd, positionals[0] ?? '.');
  const root = findRepoRoot(target);
  if (!root) throw usage(`DNR: ${target} is not inside a git repository (run git init first)`);
  const force = !!v.force;
  const report: Array<[string, Status]> = [];

  const put = async (rel: string, text: string, opts: { overwrite?: boolean } = {}): Promise<Status> => {
    const p = join(root, rel);
    if (existsSync(p)) {
      const cur = readFileSync(p, 'utf8');
      if (cur === text) return record(rel, 'unchanged');
      if (!(opts.overwrite ?? force)) return record(rel, 'kept');
      await writeFile(p, text);
      return record(rel, 'updated');
    }
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text);
    return record(rel, 'created');
  };
  const record = (rel: string, s: Status): Status => {
    report.push([rel, s]);
    return s;
  };

  // Hooks (§6).
  // Wave-3 N2: hooks and the pre-commit shim call DNR by absolute node + cli.js paths, so a `dnr`
  // shim earlier on PATH or a shell function cannot replace it; the bundle's sha256 is recorded.
  const cli = realOr(io.scriptPath);
  const dnrPath = `${shq(process.execPath)} ${shq(cli)}`;
  for (const h of DNR_HOOKS) {
    if (hooksSel === 'pre-write' && h.name !== 'dnr-pre-write') continue;
    await put(`.kiro/hooks/${h.name}.json`, hookText(h, dnrPath));
  }

  // Config: keep existing keys; --mode / --decision-format set theirs.
  const cfgRel = '.dnr/config.json';
  const cfgPath = join(root, cfgRel);
  let cfg: Record<string, unknown> = {};
  if (existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    } catch (e) {
      throw invalidData(`DNR: ${cfgPath} is not valid JSON: ${String(e)}`);
    }
  } else cfg = { mode: 'enforce', decision_format: 'deny' };
  if (mode) cfg.mode = mode;
  if (fmt) cfg.decision_format = fmt;
  const valid = DnrConfig.safeParse(cfg);
  if (!valid.success) throw invalidData(`DNR: ${cfgPath} is invalid: ${valid.error.issues[0]?.message}`);
  const cfgText = `${JSON.stringify(cfg, null, 2)}\n`;
  if (existsSync(cfgPath) && !mode && !fmt) record(cfgRel, 'unchanged');
  else await put(cfgRel, cfgText, { overwrite: true });
  await mkdir(join(root, '.dnr', 'orders'), { recursive: true });

  if (hooksSel === 'all') {
    // .gitignore lines.
    const gi = join(root, '.gitignore');
    const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    const have = new Set(cur.split('\n').map((l) => l.trim()));
    const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
    if (missing.length) {
      await writeFile(gi, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
      record('.gitignore', cur ? 'updated' : 'created');
    } else record('.gitignore', 'unchanged');

    // Pre-commit shim, only if no pre-commit hook exists.
    const hooksDir = await gitPath(root, 'hooks');
    const pc = join(hooksDir, 'pre-commit');
    if (existsSync(pc)) {
      record('pre-commit hook', readFileSync(pc, 'utf8') === preCommitShim(dnrPath) ? 'unchanged' : 'kept');
    } else {
      await mkdir(hooksDir, { recursive: true });
      await writeFile(pc, preCommitShim(dnrPath));
      chmodSync(pc, 0o755);
      record('pre-commit hook', 'created');
    }

    // Steering, the drafter agent and prompt, and the MCP server entry.
    await put('.kiro/steering/dnr.md', readFileSync(packagePath('templates/steering/dnr.md'), 'utf8'));
    await put(
      '.kiro/agents/dnr-drafter.json',
      readFileSync(packagePath('templates/agents/dnr-drafter.json'), 'utf8'),
    );
    await put('.kiro/prompts/drafter.md', readFileSync(packagePath('templates/prompts/drafter.md'), 'utf8'));
    if (!existsSync(join(root, '.kiro/settings/mcp.json')))
      await put('.kiro/settings/mcp.json', readFileSync(packagePath('templates/mcp.json'), 'utf8'));
    else record('.kiro/settings/mcp.json', 'kept');
  }

  if (v.crew) {
    const crewRepo = str(v['crew-repo']) ?? io.env.DNR_CREW_REPO ?? 'OWNER/dnr-crew';
    await put('.github/workflows/dnr.yml', crewWorkflow(crewRepo));
    if (crewRepo.startsWith('OWNER/'))
      io.err(
        'DNR: edit .github/workflows/dnr.yml: replace OWNER with the dnr-crew owner (or pass --crew-repo).\n',
      );
  }

  // Wave-3 N2: record the bundle's sha256; Stop and `dnr doctor` verify it.
  const sha = bundleSha256(cli);
  const install = { node: process.execPath, cli, sha256: sha };
  const installRel = '.dnr/install.json';
  const prevInstall = existsSync(join(root, installRel))
    ? readFileSync(join(root, installRel), 'utf8')
    : null;
  const installText = `${JSON.stringify(install, null, 2)}\n`;
  if (prevInstall !== installText) {
    await mkdir(join(root, '.dnr'), { recursive: true });
    await writeFile(join(root, installRel), installText);
    record(installRel, prevInstall === null ? 'created' : 'updated');
  } else record(installRel, 'unchanged');
  if (!sha)
    io.err(`DNR: cannot read ${cli}; the bundle hash is not recorded, and \`dnr doctor\` will flag it.\n`);

  // Kiro's own deny rules (user level), shown as a diff and confirmed at the TTY.
  if (hooksSel === 'all' && !v['no-permissions']) await installPermissions(io, cli, record);

  // A guarded init is an allowed change of the enforcement set (§5.11).
  const store = openStore(root, { env: io.env });
  await store.sessions.refreshOrdersHash(store.ordersHash());

  for (const [rel, s] of report) io.out(`${s.padEnd(9)} ${rel}\n`);
  if (report.some(([, s]) => s === 'kept'))
    io.out('DNR: files marked "kept" differ from DNR\'s version; re-run with --force to replace them.\n');
  io.out('Next: dnr scan\n');
  return EXIT.OK;
}

function realOr(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Single-quote for the shell (hook commands run through a shell). */
export function shq(s: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

async function installPermissions(
  io: CliIO,
  cli: string,
  record: (rel: string, s: Status) => Status,
): Promise<void> {
  const file = permissionsFile(io.env);
  const installDir = dirname(dirname(cli));
  const shims: string[] = [];
  for (const dir of (io.env.PATH ?? '').split(':'))
    if (dir && existsSync(join(dir, 'dnr'))) shims.push(join(dir, 'dnr'));
  const block = dnrRules([`${installDir}/**`, ...shims]);
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const next = mergePermissions(cur, block);
  if (cur === next) {
    record('~/.kiro/settings/permissions.yaml', 'unchanged');
    return;
  }
  io.out(
    `DNR would add Kiro deny rules to ${file} (they apply to every workspace):\n${createTwoFilesPatch(file, file, cur ?? '', next, 'current', 'with DNR rules')}`,
  );
  const answer = io.prompt ? (await io.prompt('Install these rules? [y/N] ')).trim().toLowerCase() : '';
  if (answer !== 'y' && answer !== 'yes') {
    io.out(
      'DNR: skipped the Kiro permission rules (run `dnr init` again to install them; `dnr doctor` reports them missing).\n',
    );
    record('~/.kiro/settings/permissions.yaml', 'kept');
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, next);
  record('~/.kiro/settings/permissions.yaml', cur === null ? 'created' : 'updated');
}
