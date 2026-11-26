/**
 * The real hook as the P9 reference: `dnr check --file <rel> --proposed <tmp>` (built CLI) run in
 * a temporary git repository seeded with the case.
 *
 * The repo has two commits: C (each order file at change_text) and R (baseline_text, the
 * post-revert snapshot). The approved order is written to .dnr/orders/ with its snapshot_sha and
 * c_state_ref shas pointed at those two commits, so stale/re-landed derivation and the order
 * material come from git exactly as in a real checkout. Everything else in the order is the
 * bundle's, byte for byte.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaseBundle, Decision, Order } from '@dnr/schemas';
import { newSession, openStore, sessionKeyFor } from '@dnr/store';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const CLI = join(root, 'packages/cli/dist/cli.js');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'p9',
      GIT_AUTHOR_EMAIL: 'p9@example.test',
      GIT_COMMITTER_NAME: 'p9',
      GIT_COMMITTER_EMAIL: 'p9@example.test',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  }).trim();

function writeFiles(dir: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
}

/** Environment for the CLI: nothing from the developer's own DNR setup leaks in. */
function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('DNR_')) delete env[k];
  return env;
}

export class CaseRepo {
  readonly dir: string;
  readonly order: Order;
  private constructor(
    dir: string,
    order: Order,
    private readonly baseline: Record<string, string>,
  ) {
    this.dir = dir;
    this.order = order;
  }

  static create(bundle: CaseBundle): CaseRepo {
    if (!existsSync(CLI)) throw new Error(`P9 needs the built CLI at ${CLI}: run pnpm -F @dnr/cli build`);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dnr-p9-')));
    git(dir, 'init', '-q', '-b', 'main');
    writeFiles(dir, Object.fromEntries(bundle.files.map((f) => [f.path, f.change_text])));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'C');
    const C = git(dir, 'rev-parse', 'HEAD');
    const baseline = Object.fromEntries(bundle.files.map((f) => [f.path, f.baseline_text]));
    writeFiles(dir, baseline);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'R');
    const R = git(dir, 'rev-parse', 'HEAD');
    const order: Order = {
      ...bundle.order,
      status: 'approved',
      snapshot_sha: R,
      units: bundle.order.units.map((u) => ({ ...u, c_state_ref: { ...u.c_state_ref, sha: C } })),
    };
    mkdirSync(join(dir, '.dnr/orders'), { recursive: true });
    writeFileSync(join(dir, `.dnr/orders/${order.id}.json`), `${JSON.stringify(order, null, 2)}\n`);
    writeFileSync(join(dir, '.gitignore'), '.dnr/*\n!.dnr/orders/\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'orders');
    return new CaseRepo(dir, order, baseline);
  }

  /**
   * Put the repo in a session state (working tree = `files`, warned set = `warned`), then run
   * `dnr check --file` on one proposed write.
   */
  async check(
    files: Record<string, string>,
    warned: readonly string[],
    write: { path: string; proposed_text: string },
  ): Promise<{ decision: Decision; stderr: string }> {
    writeFiles(this.dir, { ...this.baseline, ...files });
    const store = openStore(this.dir, { env: {} });
    const sk = sessionKeyFor(null, this.dir);
    await store.sessions.delete(sk.key).catch(() => {});
    if (warned.length) {
      const s = newSession({
        key: sk,
        baseline_tree: git(this.dir, 'rev-parse', 'HEAD^{tree}'),
        orders_hash: store.ordersHash(),
        at: '2026-11-26T12:00:00Z',
      });
      await store.sessions.put({ ...s, warned: [...warned] });
    }
    const tmp = join(this.dir, '.dnr', 'proposed.tmp');
    writeFileSync(tmp, write.proposed_text);
    let out = '';
    try {
      out = execFileSync('node', [CLI, 'check', '--file', write.path, '--proposed', tmp], {
        cwd: this.dir,
        encoding: 'utf8',
        env: cliEnv(),
      });
    } catch (e) {
      // Exit 1 means block / warn_block / ask; the JSON is still on stdout.
      out = (e as { stdout?: string }).stdout ?? '';
      if (!out) throw e;
    }
    return JSON.parse(out) as { decision: Decision; stderr: string };
  }

  dispose() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
