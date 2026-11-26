/** Test helpers: synthetic git repos with one reverted change and its approved order. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildOrder } from '@dnr/core';
import { loadGrammarsNode } from '@dnr/grammar/node';
import type { EventRecord, Order } from '@dnr/schemas';

export interface Repo {
  dir: string;
  git(...args: string[]): string;
  write(path: string, text: string): void;
  read(path: string): string;
  commit(message: string): string;
  cleanup(): void;
}

let tick = 0;

export function makeRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'dnr-hook-test-'));
  const run = (args: string[]) => {
    tick++;
    const date = new Date(Date.UTC(2021, 0, 1) + tick * 60_000).toISOString();
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@invalid',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@invalid',
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: dir,
      },
    });
  };
  run(['init', '-q', '-b', 'main']);
  run(['config', 'commit.gpgsign', 'false']);
  return {
    dir,
    git: (...a) => run(a),
    write(p, t) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    },
    read: (p) => readFileSync(join(dir, p), 'utf8'),
    commit(m) {
      run(['add', '-A']);
      run(['commit', '-q', '--allow-empty', '-m', m]);
      return run(['rev-parse', 'HEAD']).trim();
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const BEFORE = `def total(items):
    result = 0
    for item in items:
        result += item.price
    return result


def unrelated(x):
    return x + 1
`;

export const AFTER = `def total(items, discount=None):
    result = 0
    for item in items:
        if item.active:
            result += item.price * item.quantity
    return result


def unrelated(x):
    return x + 1
`;

/** A formatting-only / comment-only edit to the covered unit. */
export const COMMENT_ONLY = BEFORE.replace('    result = 0\n', '    # running sum\n    result = 0\n\n');
/** A different edit to the covered unit (does not re-apply C). */
export const OTHER_EDIT = BEFORE.replace('    return result\n', '    return round(result, 2)\n');

export const EXTRA_BEFORE = `def helper(a, b):
    return a - b
`;
export const EXTRA_AFTER = `def helper(a, b):
    if a is None:
        raise ValueError("a is required")
    return max(a - b, 0)
`;

const BEFORE_DEFAULT = BEFORE;
const AFTER_DEFAULT = AFTER;

export interface Fixture {
  repo: Repo;
  C: string;
  R: string;
  order: Order;
}

/**
 * C changes `total` in shop.py (and `helper` in util.py when `twoFile`), R reverts it, then the
 * order (approved) is written to `.dnr/orders/`. HEAD = R (the post-revert snapshot).
 */
export async function revertFixture(
  opts: { twoFile?: boolean; status?: Order['status']; before?: string; after?: string } = {},
): Promise<Fixture> {
  const BEFORE = opts.before ?? BEFORE_DEFAULT;
  const AFTER = opts.after ?? AFTER_DEFAULT;
  const repo = makeRepo();
  repo.write('shop.py', BEFORE);
  repo.write('notes.txt', 'hello\n');
  if (opts.twoFile) repo.write('util.py', EXTRA_BEFORE);
  repo.commit('base');
  repo.write('shop.py', AFTER);
  if (opts.twoFile) repo.write('util.py', EXTRA_AFTER);
  const C = repo.commit('Fixed #1 -- Change totals');
  repo.git('revert', '--no-edit', C);
  const R = repo.git('rev-parse', 'HEAD').trim();
  const parser = await loadGrammarsNode();
  const files = [{ path: 'shop.py', before: BEFORE, after: AFTER, post_revert: BEFORE }];
  if (opts.twoFile)
    files.push({ path: 'util.py', before: EXTRA_BEFORE, after: EXTRA_AFTER, post_revert: EXTRA_BEFORE });
  const r = buildOrder({
    provider: parser,
    original_sha: C,
    revert_sha: R,
    snapshot_sha: R,
    files,
    links: [
      { rel: 'revert', url: `https://github.com/example/shop/commit/${R}` },
      { rel: 'original', url: `https://github.com/example/shop/commit/${C}` },
    ],
    tickets: [{ system: 'other', id: '1', url: 'https://example.invalid/ticket/1' }],
    reason: 'Totals ignored inactive items and broke refunds.',
    reason_source: 'human',
    status: opts.status ?? 'approved',
    at: '2021-01-02T00:00:00.000Z',
  });
  if (!r.ok) throw new Error('fixture order did not build');
  writeOrder(repo, r.order);
  return { repo, C, R, order: r.order };
}

export function writeOrder(repo: Repo, order: Order): void {
  repo.write(`.dnr/orders/${order.id}.json`, `${JSON.stringify(order, null, 2)}\n`);
}

export function event(
  repo: Repo,
  tool: string,
  input: Record<string, unknown>,
  opts: { session?: string | null; hook?: string } = {},
): string {
  const ev: Record<string, unknown> = {
    hook_event_name: opts.hook ?? 'PreToolUse',
    cwd: repo.dir,
    tool_name: tool,
    tool_input: input,
  };
  if (opts.session !== null) ev.session_id = opts.session ?? 'sess-1';
  return JSON.stringify(ev);
}

export function writeEvent(repo: Repo, path: string, content: string, session?: string | null): string {
  return event(repo, 'fs_write', { path, content }, { session: session === undefined ? 'sess-1' : session });
}

export function envFor(repo: Repo, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(repo.dir, '.home'), ...extra };
  for (const k of [
    'DNR_MODE',
    'DNR_ORDERS',
    'DNR_STATE_DIR',
    'DNR_CONFIG',
    'DNR_THRESHOLD',
    'DNR_NOW',
    'DNR_RECORD_PATH',
  ])
    if (!(k in extra)) delete env[k];
  return env;
}

export function readEventsFile(repo: Repo, file = '.dnr/events.jsonl'): EventRecord[] {
  try {
    return readFileSync(join(repo.dir, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
