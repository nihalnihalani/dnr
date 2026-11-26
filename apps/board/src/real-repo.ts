/**
 * Test support: a real git repository holding a real revert, for the board's tests (vitest and
 * Playwright). Nothing here is mocked or seeded (AGENTS.md).
 *
 * - History: Django's `django/db/models/sql/query.py` from the committed `dnr export-case` bundle
 *   (packages/cli/templates/demo/43933a1dca.case.json): C^, then C (#26434), then a real
 *   `git revert` of C.
 * - Order: built from that history by @dnr/core `buildOrder`, written to .dnr/orders/ and committed.
 * - Store: the same `createBoardStore` adapter `dnr board` uses, over @dnr/store and git.
 * - States are made the real way: approve/retire through the store (the test is the human
 *   maintainer), stale and re-landed by committing code, drift by editing the order file.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOrder } from '@dnr/core';
import { loadGrammarsNode } from '@dnr/grammar/node';
import { type HookContext, openContext, runPreWrite } from '@dnr/hook';
import { CaseBundle, type Order } from '@dnr/schemas';
// dnr-guard has no package exports (tsup bundle), so the adapter `dnr board` uses is imported from source.
import { createBoardStore } from '../../../packages/cli/src/board-store';
import { NotFoundError, TransitionError } from './store-port';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEMO_BUNDLE = join(root, 'packages/cli/templates/demo/43933a1dca.case.json');
export const MAINTAINER = 'test-maintainer';

export class RealRepo {
  private constructor(
    readonly dir: string,
    readonly C: string,
    readonly R: string,
    readonly order: Order,
    readonly file: string,
    private readonly texts: { pre: string; change: string },
  ) {}

  /** Environment for the hook and store: none of the developer's own DNR settings leak in. */
  get env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(this.dir, '.home') };
    for (const k of Object.keys(env)) if (k.startsWith('DNR_') || k.startsWith('KIRO')) delete env[k];
    return env;
  }

  git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Django test history',
        GIT_AUTHOR_EMAIL: 'history@example.test',
        GIT_COMMITTER_NAME: 'Django test history',
        GIT_COMMITTER_EMAIL: 'history@example.test',
      },
    }).trim();
  }

  write(path: string, text: string) {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), text);
  }

  commit(msg: string): string {
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', msg);
    return this.git('rev-parse', 'HEAD');
  }

  /** `withOrder: false` stops after the revert: a repository with history but no orders yet. */
  static async create(opts: { withOrder?: boolean } = {}): Promise<RealRepo> {
    const bundle = CaseBundle.parse(JSON.parse(readFileSync(DEMO_BUNDLE, 'utf8')));
    const f = bundle.files[0];
    if (!f) throw new Error(`${DEMO_BUNDLE} has no files`);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dnr-board-repo-')));
    const boot = new RealRepo(dir, '', '', bundle.order, f.path, {
      pre: f.pre_change_text,
      change: f.change_text,
    });
    boot.git('init', '-q', '-b', 'main');
    boot.write(f.path, f.pre_change_text);
    boot.write('.gitignore', '.dnr/*\n!.dnr/orders/\n.home/\n');
    boot.commit('Django at C^ (django/db/models/sql/query.py)');
    boot.write(f.path, f.change_text);
    const C = boot.commit(
      'Fixed #26434 -- Removed faulty clearing of ordering field when missing from explicit grouping.',
    );
    boot.git('revert', '--no-edit', C);
    const R = boot.git('rev-parse', 'HEAD');
    const built = buildOrder({
      provider: await loadGrammarsNode(),
      original_sha: C,
      revert_sha: R,
      snapshot_sha: R,
      files: [
        { path: f.path, before: f.pre_change_text, after: f.change_text, post_revert: f.pre_change_text },
      ],
      // The links name the real Django commits this history was copied from.
      links: bundle.order.links,
      tickets: bundle.order.tickets,
      reason: bundle.order.reason,
      reason_source: bundle.order.reason_source,
      status: 'draft',
      at: new Date().toISOString(),
    });
    if (!built.ok) throw new Error(`buildOrder: ${built.skip_reason}`);
    if (opts.withOrder === false)
      return new RealRepo(dir, C, R, built.order, f.path, { pre: f.pre_change_text, change: f.change_text });
    boot.write(`.dnr/orders/${built.order.id}.json`, `${JSON.stringify(built.order, null, 2)}\n`);
    boot.commit(`Add DNR order ${built.order.id}`);
    return new RealRepo(dir, C, R, built.order, f.path, { pre: f.pre_change_text, change: f.change_text });
  }

  async context(extraEnv: NodeJS.ProcessEnv = {}): Promise<HookContext> {
    const ctx = await openContext(this.dir, { ...this.env, ...extraEnv });
    if (!ctx) throw new Error(`no repository at ${this.dir}`);
    return ctx;
  }

  /** The `BoardStorePort` that `dnr board` passes to `startBoard`. */
  /** `extraEnv` is the environment the board runs in (for example a Kiro agent's variables). */
  async boardStore(extraEnv: NodeJS.ProcessEnv = {}) {
    return createBoardStore(await this.context(extraEnv), { TransitionError, NotFoundError });
  }

  // --- real state changes -------------------------------------------------------------------
  async approve(by = MAINTAINER) {
    await (await this.context()).store.orders.transition(this.order.id, 'approved', by);
  }
  async retire(by = MAINTAINER) {
    await (await this.context()).store.orders.transition(this.order.id, 'retired', by);
  }
  /** The covered unit is rewritten in a later commit that is not C: the order goes stale. */
  makeStale() {
    const text = readFileSync(join(this.dir, this.file), 'utf8');
    const start = text.indexOf('    def clear_ordering(self, force=False, clear_default=True):');
    const end = text.indexOf('    def set_group_by(', start);
    if (start < 0 || end < 0) throw new Error('clear_ordering not found');
    const old = text.slice(start, end);
    // A refactor that moves the logic into a module-level helper: most of the unit's tokens go.
    const rewrite = [
      '    def clear_ordering(self, force=False, clear_default=True):',
      '        return clear_query_ordering(self, force, clear_default)',
      '',
      '',
    ].join('\n');
    if (!text.includes(old)) throw new Error('clear_ordering body not found');
    this.write(this.file, text.replace(old, rewrite));
    return this.commit('Move Query.clear_ordering into a helper');
  }
  /** A maintainer commits the order file after changing it (approve, retire, edit). */
  commitOrders(msg = 'Update DNR orders') {
    return this.commit(msg);
  }
  /** C is committed again: the order is re-landed. */
  makeRelanded() {
    this.write(this.file, this.texts.change);
    return this.commit('Re-land #26434');
  }
  /** The order file differs from the committed copy. */
  makeDrift() {
    const p = `.dnr/orders/${this.order.id}.json`;
    const o = JSON.parse(readFileSync(join(this.dir, p), 'utf8')) as Order;
    this.write(p, `${JSON.stringify({ ...o, reason: `${o.reason} (edited locally)` }, null, 2)}\n`);
  }
  /** A real agent write through the PreToolUse hook (records an event). */
  async agentWrite(text = this.texts.change) {
    const ev = {
      hook_event_name: 'PreToolUse',
      cwd: this.dir,
      session_id: 'board-test-session',
      tool_name: 'fs_write',
      tool_input: { command: 'create', path: join(this.dir, this.file), file_text: text },
    };
    return runPreWrite(JSON.stringify(ev), { env: this.env, cwd: this.dir });
  }

  dispose() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
