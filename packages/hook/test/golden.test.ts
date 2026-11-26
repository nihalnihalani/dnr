/**
 * Golden hook fixtures (fixtures/hook-events/). The Django demo cases run on a small repo that
 * holds the post-revert `query.py` from the bundled demo case, so they need no Django clone;
 * the full-checkout end-to-end case runs only when the Django clone is present.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaseBundle, type EventRecord, Order } from '@dnr/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPreWrite } from '../src/prewrite';
import { runGuardShell } from '../src/shell';
import { runStop } from '../src/stop';
import { envFor, makeRepo, type Repo, readEventsFile, writeOrder } from './helpers';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const EVENTS = join(ROOT, 'fixtures', 'hook-events');
const fixture = (n: string) => readFileSync(join(EVENTS, n), 'utf8');
const bundle = CaseBundle.parse(
  JSON.parse(readFileSync(join(ROOT, 'packages/cli/templates/demo/43933a1dca.case.json'), 'utf8')),
);

let repo: Repo;
beforeAll(() => {
  repo = makeRepo();
  for (const f of bundle.files) repo.write(f.path, f.baseline_text);
  repo.write(
    'django/utils/text.py',
    'def capfirst(x):\n    """Capitalize the first letter of a string."""\n    if not x:\n        return x\n    return x[0].upper() + x[1:]\n',
  );
  repo.commit('post-revert snapshot');
  writeOrder(repo, { ...bundle.order, status: 'approved' });
});
afterAll(() => repo.cleanup());

/** Run a PreToolUse fixture in its own session from the repo as the hook's cwd. */
async function pre(name: string, session: string, env = envFor(repo)) {
  const ev = JSON.parse(fixture(name));
  ev.session_id = session;
  const io = await runPreWrite(JSON.stringify(ev), { env, cwd: repo.dir });
  const last = readEventsFile(repo).at(-1) as EventRecord;
  return { io, decision: last.decision, event: last };
}

describe('golden hook fixtures', () => {
  it('golden: reapply-43933a1dca.json blocks with exit 2 and the §6 stderr', async () => {
    const { io, decision } = await pre('reapply-43933a1dca.json', 'g1');
    expect(io.exitCode).toBe(2);
    expect(decision).toMatchObject({
      outcome: 'block',
      tier: 'match',
      order_id: 'dnr-43933a1dca',
      edit_score: 1,
      fired_by: 'edit',
    });
    const lines = io.stderr.trimEnd().split('\n');
    expect(lines[0]).toBe(
      `DNR: ${bundle.order.reason} https://github.com/django/django/commit/43933a1dca07047e95ec990d9289d0212668009e`,
    );
    expect(lines[1]).toBe(
      'DNR order dnr-43933a1dca matched (edit 1.00 ≥ 0.60) in Query.clear_ordering. Original: https://github.com/django/django/commit/ea3a71c2d09f8281d8a50ed20e40e1fb13db5cd9. Ticket: https://code.djangoproject.com/ticket/26434.',
    );
    expect(lines[2]).toContain('`dnr board --open dnr-43933a1dca` or `dnr allow dnr-43933a1dca`');
    expect(io.stderr.trimEnd().length).toBeLessThanOrEqual(1200);
  });

  it('golden: hardneg-typehints.json warns once (changes a covered unit, does not re-apply it)', async () => {
    const a = await pre('hardneg-typehints.json', 'g2');
    expect(a.decision.outcome).toBe('warn_block');
    expect(a.decision.edit_score).toBe(0);
    const b = await pre('hardneg-typehints.json', 'g2');
    expect(b.decision.outcome).toBe('warn_pass');
    expect(b.io.exitCode).toBe(0);
  });

  it('P5-15: hardneg-43933a1dca.json replays to a warn, never a block', async () => {
    const { decision } = await pre('hardneg-43933a1dca.json', 'g3');
    expect(decision.outcome).toMatch(/^(allow|warn_block|warn_pass)$/);
  });

  it('golden: uncovered.json takes the fast path', async () => {
    const { io, decision } = await pre('uncovered.json', 'g4');
    expect(io.exitCode).toBe(0);
    expect(decision).toMatchObject({ outcome: 'allow', fast_path: true });
  });

  it('golden: one fixture per tool gives the documented outcome', async () => {
    const want: Record<string, [string, number]> = {
      'tool-fs_write-create.json': ['allow', 0],
      'tool-fs_write-overwrite.json': ['allow', 0],
      'tool-fs_write-legacy-str_replace.json': ['block', 2],
      'tool-str_replace.json': ['block', 2],
      'tool-str_replace-several.json': ['allow', 0],
      'tool-fs_append.json': ['allow', 0],
      'tool-delete_file.json': ['warn_block', 2],
      'tool-unknown.json': ['warn_block', 2],
      'tool-protected.json': ['deny_protected', 2],
    };
    for (const [name, [outcome, code]] of Object.entries(want)) {
      const { io, decision } = await pre(name, `tool-${name}`);
      expect([decision.outcome, io.exitCode], name).toEqual([outcome, code]);
    }
  });

  it('golden: shell fixtures (cherry-pick and allow denied, pytest allowed)', async () => {
    for (const [name, code] of [
      ['shell-cherry-pick.json', 2], // the full original SHA matches even when the commit is not in this repo
      ['shell-allow.json', 2],
      ['shell-ok.json', 0],
    ] as const) {
      const io = await runGuardShell(fixture(name), { env: envFor(repo), cwd: repo.dir });
      expect(io.exitCode, name).toBe(code);
    }
  });

  it('golden: stop.json always exits 0', async () => {
    const io = await runStop(fixture('stop.json'), { env: envFor(repo), cwd: repo.dir });
    expect(io.exitCode).toBe(0);
  });

  it('P5-13: two-file-order.json is a valid two-file order; the first half does not block, the second does', async () => {
    const f = JSON.parse(fixture('two-file-order.json'));
    const order = Order.parse(f.order);
    expect(new Set(order.units.map((u) => u.file)).size).toBe(2);
    const r = makeRepo();
    try {
      for (const x of f.files) r.write(x.path, x.baseline_text);
      r.commit('base');
      writeOrder(r, order);
      const env = envFor(r);
      const [e1, e2] = f.events;
      const a = await runPreWrite(JSON.stringify(e1), { env, cwd: r.dir });
      expect(a.stderr).not.toContain('matched');
      r.write(e1.tool_input.path, e1.tool_input.content);
      const b = await runPreWrite(JSON.stringify(e2), { env, cwd: r.dir });
      expect(b.exitCode).toBe(2);
      expect(b.stderr).toContain(`DNR order ${order.id} matched`);
      const ev = readEventsFile(r).at(-1) as EventRecord;
      expect(ev.session_patch).toContain('+++ shop/cart.py');
      expect(ev.session_patch).toContain('+++ shop/pricing.py');
    } finally {
      r.cleanup();
    }
  });

  it('golden: every PreToolUse fixture is marked provisional until spike S2', () => {
    for (const n of [
      'reapply-43933a1dca.json',
      'hardneg-typehints.json',
      'uncovered.json',
      'tool-unknown.json',
    ]) {
      expect(JSON.parse(fixture(n))._fixture.provisional).toContain('S2');
    }
  });
});

const DJANGO = process.env.DJANGO_SRC ?? resolve(ROOT, '../dnr-work/django');
const haveDjango = existsSync(join(DJANGO, '.git'));

describe.skipIf(!haveDjango)('end-to-end on a Django checkout at the revert', () => {
  let demo: Repo;
  beforeAll(() => {
    demo = makeRepo();
    execFileSync('git', [
      '-C',
      demo.dir,
      'fetch',
      '-q',
      '--no-tags',
      DJANGO,
      '43933a1dca07047e95ec990d9289d0212668009e',
    ]);
    execFileSync('git', ['-C', demo.dir, 'checkout', '-q', 'FETCH_HEAD']);
    const o = Order.parse(JSON.parse(readFileSync(join(ROOT, 'reports/orders/dnr-43933a1dca.json'), 'utf8')));
    writeOrder(demo, { ...o, status: 'approved' });
  }, 120_000);
  afterAll(() => demo?.cleanup());

  it('R1: a stdin event that re-applies 43933a1dca on a checkout at the revert exits 2 with the §6 stderr', async () => {
    const t0 = performance.now();
    const io = await runPreWrite(fixture('reapply-43933a1dca.json'), { env: envFor(demo), cwd: demo.dir });
    const ms = performance.now() - t0;
    expect(io.exitCode).toBe(2);
    expect(io.stderr.split('\n')[0]).toMatch(
      /^DNR: .+ https:\/\/github\.com\/django\/django\/commit\/43933a1dca07047e95ec990d9289d0212668009e$/,
    );
    expect(io.stderr).toContain('in Query.clear_ordering');
    expect(ms).toBeLessThan(2000); // P5-08: the first write of a fresh Django session builds the baseline
  });

  it('P5-15: hardneg-d0e4dd5cdd.json replays to allow or a warn on the d0e4dd5cdd order', async () => {
    const d = makeRepo();
    try {
      execFileSync('git', [
        '-C',
        d.dir,
        'fetch',
        '-q',
        '--no-tags',
        DJANGO,
        'd0e4dd5cdd743a5c43c4ccc2c8fa29d3982eaa71',
      ]);
      execFileSync('git', ['-C', d.dir, 'checkout', '-q', 'FETCH_HEAD']);
      const o = Order.parse(
        JSON.parse(readFileSync(join(ROOT, 'reports/orders/dnr-d0e4dd5cdd.json'), 'utf8')),
      );
      writeOrder(d, { ...o, status: 'approved' });
      const io = await runPreWrite(fixture('hardneg-d0e4dd5cdd.json'), { env: envFor(d), cwd: d.dir });
      const ev = readEventsFile(d).at(-1) as EventRecord;
      expect(ev.decision.outcome).toMatch(/^(allow|warn_block|warn_pass)$/);
      expect([0, 2]).toContain(io.exitCode);
    } finally {
      d.cleanup();
    }
  }, 120_000);
});
