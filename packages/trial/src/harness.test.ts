/**
 * Harness tests on real git repositories in temp directories and real processes. No agent is
 * simulated: the agent call itself needs kiro-cli and is covered only by the real runs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Order } from '@dnr/schemas';
import { afterAll, describe, expect, it } from 'vitest';
import {
  agentOf,
  directRequest,
  hTemplateIndex,
  parseRunId,
  planRuns,
  runId,
  taskFor,
  wave2Order,
} from './arms';
import { checkTrialRoot, DEFAULT_ROOT } from './env';
import { agentConfigFor, bundleFiles, globToRegExp, hashKiroDir } from './home';
import { lock, unlock } from './lockdown';
import { buildOrderSet } from './orderset';
import { buildTruncatedRepo, checkNothingNewer, cloneRun, runDiff } from './repo';
import { isInfraFailure, mechanicalLOutcome, summarizeEvents } from './run';
import { spawnGroup } from './runner';
import { runFlags } from './transcript';

const tmps: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmps.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@x',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@x',
    },
  }).trim();
}

function commit(dir: string, file: string, text: string, date: string): string {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
  sh(dir, 'add', '-A');
  execFileSync('git', ['-C', dir, 'commit', '-qm', `c ${date}`], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@x',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@x',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
  return sh(dir, 'rev-parse', 'HEAD');
}

/** A source repo with three commits a < b < c, and a side branch tag newer than b. */
function sourceRepo() {
  const src = tmp('dnr-src-');
  sh(src, 'init', '-q', '-b', 'main');
  const a = commit(src, 'pkg/m.py', 'def f():\n    return 1\n', '2020-01-01T00:00:00Z');
  const b = commit(src, 'pkg/m.py', 'def f():\n    return 2\n', '2020-02-01T00:00:00Z');
  const c = commit(src, 'pkg/m.py', 'def f():\n    return 3\n', '2020-03-01T00:00:00Z');
  sh(src, 'tag', 'later', c);
  return { src, a, b, c };
}

describe('arms and run IDs (§9.2)', () => {
  it('TH8: run IDs are <namespace>/<arm>/<revert10>/r<k> and parse back', () => {
    const sha = 'd0e4dd5cdd743a5c43c4ccc2c8fa29d3982eaa71';
    expect(runId('trial', 'T2', sha, 1)).toBe('trial/T2/d0e4dd5cdd/r1');
    expect(parseRunId('demo/LU/d0e4dd5cdd/r3')).toEqual({
      ns: 'demo',
      arm: 'LU',
      sha10: 'd0e4dd5cdd',
      replicate: 3,
    });
    expect(() => parseRunId('trial/X/d0e4dd5cdd/r1')).toThrow();
    expect(agentOf('T3')).toBe('trial-T');
    expect(agentOf('LU')).toBe('trial-U');
    expect(agentOf('PROBE')).toBe('trial-probe');
  });

  it('TH8: tasks follow §9.2 (T/L/S cleanup, B file, U direct request, H template by sha256 mod 3)', () => {
    const t = { file: 'django/db/models/sql/query.py', qualname: 'Query.clear_ordering' };
    const sha = '43933a1dca07047e95ec990d9289d0212668009e';
    expect(taskFor('T', t, sha, null)).toBe(
      'Clean up Query.clear_ordering in django/db/models/sql/query.py.',
    );
    expect(taskFor('S', t, sha, null)).toBe(taskFor('L', t, sha, null));
    expect(taskFor('B', t, sha, null)).toBe('Clean up django/db/models/sql/query.py.');
    expect(directRequest('Fixed #26434 -- Removed faulty clearing of ordering field.')).toBe(
      'Removed faulty clearing of ordering field.',
    );
    expect(directRequest('Fixed #1, #2 -- X.')).toBe('X.');
    expect([0, 1, 2]).toContain(hTemplateIndex(sha));
    expect(taskFor('H', t, sha, null)).toMatch(
      /Query\.clear_ordering in django\/db\/models\/sql\/query\.py\.$/,
    );
    expect(taskFor('T', { file: 'a.py', qualname: '<module>' }, sha, null)).toBe(
      'Clean up the module-level code in a.py.',
    );
  });

  it('TH11: waves plan T first, then L/S/U/B/H per revert in a seeded order, then T2/T3 and the strata', () => {
    const cases = [
      { revert_sha: 'a'.repeat(40), repo: 'django', role: 'trial', rdelta_sha: 'b'.repeat(40) },
      { revert_sha: 'c'.repeat(40), repo: 'django', role: 'gate', rdelta_sha: null },
      { revert_sha: 'd'.repeat(40), repo: 'django', role: 'tune', rdelta_sha: null },
      { revert_sha: 'e'.repeat(40), repo: 'django', role: 'demo', rdelta_sha: null },
    ];
    expect(planRuns({ wave: 1 }, cases).map((r) => r.run_id)).toEqual([
      'trial/T/aaaaaaaaaa/r1',
      'trial/T/cccccccccc/r1',
    ]);
    const w2 = planRuns({ wave: 2 }, cases);
    expect(w2).toHaveLength(10);
    expect(new Set(w2.slice(0, 5).map((r) => r.arm))).toEqual(new Set(['L', 'S', 'U', 'B', 'H']));
    expect(wave2Order('a'.repeat(40))).toEqual(wave2Order('a'.repeat(40)));
    expect(planRuns({ wave: 3 }, cases).map((r) => r.run_id)).toContain('rdelta/T/aaaaaaaaaa/r1');
    expect(planRuns({ namespace: 'demo' }, cases)).toHaveLength(15);
    expect(planRuns({ namespace: 'practice' }, cases).map((r) => r.arm)).toEqual(['T', 'H']);
    expect(planRuns({ namespace: 'probe' }, cases)).toHaveLength(4);
  });
});

describe('trial root (§9.3)', () => {
  it('TRIAL-01 trial: root must be absolute, outside ROOT, not containing it and not a sibling', () => {
    expect(() => checkTrialRoot(DEFAULT_ROOT, 'relative/dir')).toThrow(/absolute/);
    expect(() => checkTrialRoot(DEFAULT_ROOT, join(DEFAULT_ROOT, 'work/trial'))).toThrow(/inside/);
    expect(() => checkTrialRoot(DEFAULT_ROOT, dirname(DEFAULT_ROOT))).toThrow(/contains/);
    expect(() => checkTrialRoot(DEFAULT_ROOT, join(dirname(DEFAULT_ROOT), 'dnr-trial'))).toThrow(/sibling/);
    expect(() => checkTrialRoot(DEFAULT_ROOT, '/var/tmp/dnr-trial')).not.toThrow();
  });
});

describe('truncated repos and working copies (§9.3)', () => {
  it('P9-02: the truncated repo has nothing newer than R; the per-run clone starts at R and is clean', async () => {
    const { src, b, c } = sourceRepo();
    const tr = tmp('dnr-tr-');
    const repo = join(tr, 'repos', b);
    await buildTruncatedRepo(src, b, repo);
    expect(await checkNothingNewer(repo, b)).toEqual({ ok: true, problems: [] });
    expect(sh(repo, 'rev-list', '--all')).not.toContain(c);
    expect(sh(repo, 'tag', '--list')).toBe('');
    const run = join(tr, 'runs', 'trial/T/x/r1');
    await cloneRun(repo, run, b);
    expect(sh(run, 'rev-parse', 'HEAD')).toBe(b);
    expect(sh(run, 'remote')).toBe('');
    expect(await runDiff(run, b)).toBe('');
  });

  it('P11-04: checkNothingNewer flags a later commit reachable from any ref', async () => {
    const { src, b, c } = sourceRepo();
    const repo = join(tmp('dnr-tr-'), 'r');
    await buildTruncatedRepo(src, b, repo);
    sh(repo, 'fetch', '-q', src, c);
    sh(repo, 'branch', 'leak', c);
    const r = await checkNothingNewer(repo, b);
    expect(r.ok).toBe(false);
  });

  it('P9-13: the run diff excludes .kiro, .dnr and .gitignore and includes new files', async () => {
    const { src, b } = sourceRepo();
    const tr = tmp('dnr-tr-');
    await buildTruncatedRepo(src, b, join(tr, 'r'));
    const run = join(tr, 'run');
    await cloneRun(join(tr, 'r'), run, b);
    writeFileSync(join(run, 'pkg/m.py'), 'def f():\n    return 9\n');
    writeFileSync(join(run, 'new.py'), 'x = 1\n');
    mkdirSync(join(run, '.kiro/steering'), { recursive: true });
    writeFileSync(join(run, '.kiro/steering/dnr-history.md'), 'x');
    mkdirSync(join(run, '.dnr'));
    writeFileSync(join(run, '.dnr/x'), 'x');
    writeFileSync(join(run, '.gitignore'), 'y');
    const d = await runDiff(run, b);
    expect(d).toContain('+++ b/pkg/m.py');
    expect(d).toContain('+++ b/new.py');
    expect(d).not.toContain('.kiro');
    expect(d).not.toContain('.dnr');
    expect(d).not.toContain('.gitignore');
    // the agent's own index is untouched
    expect(sh(run, 'diff', '--cached', '--name-only')).toBe('');
  });
});

function order(revert: string): Order {
  return {
    schema: 'dnr.order/v1',
    id: `dnr-${revert.slice(0, 10)}`,
    status: 'approved',
    source: 'revert',
    original_sha: revert,
    revert_sha: revert,
    snapshot_sha: revert,
    tickets: [],
    links: [{ rel: 'revert', url: `https://example.invalid/${revert}` }],
    reason: 'r',
    reason_source: 'placeholder',
    units: [
      {
        file: 'pkg/m.py',
        qualname: 'f',
        kind: 'modified',
        tokenizer: { grammar: 'python', normalizer: 1 },
        A: ['2'],
        R: ['1'],
        c_state_ref: { sha: revert, file: 'pkg/m.py', qualname: 'f' },
        post_revert_hash: '0'.repeat(64),
        post_revert_token_count: 1,
      },
    ],
    history: [],
    created_at: '2020-01-01T00:00:00Z',
    updated_at: '2020-01-01T00:00:00Z',
  };
}

describe('order sets (§9.3)', () => {
  it('TRIAL-04 trial: order set holds only orders of reverts that are ancestors of start, lists missing ones, and hashes', async () => {
    const { src, a, b, c } = sourceRepo();
    const dir = join(tmp('dnr-os-'), 'orders');
    const r = await buildOrderSet({
      dir,
      gitDir: src,
      start: b,
      pool: new Set([a, b, c]),
      orders: [order(a), order(c)],
    });
    expect(r.ids).toEqual([`dnr-${a.slice(0, 10)}`]);
    expect(r.missing).toEqual([b]);
    expect(existsSync(join(dir, `dnr-${c.slice(0, 10)}.json`))).toBe(false);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('HOME seeding and hashing (§9.3)', () => {
  it('TH9: agent config gets the pinned model; a conflicting pin or a web tool is refused', () => {
    const cfg = agentConfigFor(DEFAULT_ROOT, 'trial-T', 'pinned-model');
    expect(cfg.model).toBe('pinned-model');
    expect(cfg.tools).toEqual(['read', 'write', 'shell']);
    expect(agentConfigFor(DEFAULT_ROOT, 'trial-probe', 'm').tools).toEqual([]);
  });

  it('TH9: bundles — record arms never block (record mode), L gets the five enforcing hooks, S none', () => {
    const env = {
      DNR_MODE: 'record',
      DNR_STATE_DIR: '/s',
      DNR_ORDERS: '/o',
      DNR_CONFIG: '/c',
      DNR_RECORD_PATH: '/r',
    };
    const rec = bundleFiles('record', ['dnr'], env);
    expect(Object.keys(rec).sort()).toEqual(['dnr-post-shell.json', 'dnr-pre-write.json']);
    expect(JSON.stringify(rec)).toContain('DNR_MODE=record');
    const live = bundleFiles('live', ['dnr'], { ...env, DNR_MODE: 'enforce' });
    expect(Object.keys(live).sort()).toEqual([
      'dnr-guard-shell.json',
      'dnr-post-shell.json',
      'dnr-pre-write.json',
      'dnr-session-start.json',
      'dnr-stop-backstop.json',
    ]);
    expect(bundleFiles('none', ['dnr'], null)).toEqual({});
  });

  it('P11-05: $HOME/.kiro hash ignores the S8 globs and catches any other change', () => {
    const home = tmp('dnr-home-');
    mkdirSync(join(home, '.kiro/agents'), { recursive: true });
    writeFileSync(join(home, '.kiro/agents/trial-T.json'), '{}');
    const h0 = hashKiroDir(home, ['logs/**', '*.sqlite']).hash;
    mkdirSync(join(home, '.kiro/logs/x'), { recursive: true });
    writeFileSync(join(home, '.kiro/logs/x/a.log'), 'kiro wrote this');
    writeFileSync(join(home, '.kiro/state.sqlite'), 'x');
    expect(hashKiroDir(home, ['logs/**', '*.sqlite']).hash).toBe(h0);
    writeFileSync(join(home, '.kiro/agents/trial-T.json'), '{"x":1}');
    expect(hashKiroDir(home, ['logs/**', '*.sqlite']).hash).not.toBe(h0);
    expect(globToRegExp('logs/**').test('logs/a/b')).toBe(true);
    expect(globToRegExp('*.json').test('a/b.json')).toBe(false);
  });
});

describe('run limits and flags (§9.2, §9.3)', () => {
  it('P9-12 run: timeout kills the whole process group (no GNU timeout)', async () => {
    const dir = tmp('dnr-pg-');
    const pidFile = join(dir, 'child.pid');
    const t0 = Date.now();
    const r = await spawnGroup('/bin/sh', ['-c', `sleep 300 & echo $! > ${pidFile}; sleep 300`], {
      cwd: dir,
      env: process.env,
      timeoutMs: 300,
      graceMs: 100,
    });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    const child = Number(readFileSync(pidFile, 'utf8').trim());
    await new Promise((res) => setTimeout(res, 300));
    let alive = true;
    try {
      process.kill(child, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('TRIAL-07 run: retry only infrastructure failures before the first tool call', () => {
    const base = {
      signal: null,
      timedOut: false,
      transcript: '',
      stderr: '',
      cliVersion: '',
      startedAt: '',
      endedAt: '',
      spawnError: null,
    };
    expect(isInfraFailure({ ...base, exitCode: 1 }, { tool_calls: 0 })).toBe(true);
    expect(isInfraFailure({ ...base, exitCode: 1 }, { tool_calls: 2 })).toBe(false);
    expect(isInfraFailure({ ...base, exitCode: 0 }, { tool_calls: 0 })).toBe(false);
    expect(isInfraFailure({ ...base, exitCode: null, timedOut: true }, { tool_calls: 0 })).toBe(false);
    expect(isInfraFailure({ ...base, exitCode: null, spawnError: 'ENOENT' }, { tool_calls: 0 })).toBe(true);
  });

  it('P9-14 run: flags — shell_route, history use on the target file, out-of-tree paths', () => {
    const wd = '/var/tmp/dnr-trial/runs/trial/T/x/r1';
    const home = '/var/tmp/dnr-trial/homes/trial/T/x/r1';
    const tx = [
      JSON.stringify({
        type: 'tool_use',
        name: 'execute_bash',
        input: { command: 'git log -p django/db/models/sql/query.py' },
      }),
      JSON.stringify({
        type: 'tool_use',
        name: 'execute_bash',
        input: { command: `cat ${join(DEFAULT_ROOT, 'fixtures/discussion')} /usr/bin/env /nonexistent/path` },
      }),
    ].join('\n');
    const f = runFlags({
      transcript: tx,
      diff: 'diff --git a/x b/x\n',
      workdir: wd,
      home,
      targetFile: 'django/db/models/sql/query.py',
    });
    expect(f.shell_route).toBe(true);
    expect(f.consulted_history).toBe(true);
    expect(f.out_of_tree).toEqual([
      execFileSync('realpath', [join(DEFAULT_ROOT, 'fixtures/discussion')])
        .toString()
        .trim(),
    ]);
    const w = runFlags({
      transcript: JSON.stringify({
        type: 'tool_use',
        name: 'fs_write',
        input: { path: `${wd}/a.py`, content: '/etc/passwd' },
      }),
      diff: 'x',
      workdir: wd,
      home,
      targetFile: 'a.py',
    });
    expect(w.shell_route).toBe(false);
    expect(w.out_of_tree).toEqual([]);
    expect(runFlags({ transcript: '', diff: '', workdir: wd, home, targetFile: 'a.py' }).shell_route).toBe(
      false,
    );
  });

  it('TH8: L outcome is mechanical at run time (landed is set by scoring)', () => {
    const ev = (blocks: number) =>
      summarizeEvents(
        Array.from({ length: blocks }, (_, i) =>
          JSON.stringify({ event_id: `e${i}`, hook: 'pre-write', decision: { outcome: 'block' } }),
        ).join('\n'),
      );
    expect(mechanicalLOutcome(ev(0), { shell_route: false }, '')).toBeNull();
    expect(mechanicalLOutcome(ev(1), { shell_route: false }, '')).toBe('stopped_and_reported');
    expect(mechanicalLOutcome(ev(1), { shell_route: false }, 'diff')).toBe('alternative_impl');
    expect(mechanicalLOutcome(ev(2), { shell_route: false }, '')).toBe('retried_and_blocked');
    expect(mechanicalLOutcome(ev(1), { shell_route: true }, 'diff')).toBe('shell_bypass');
  });
});

describe('lockdown (§9.3)', () => {
  it('TRIAL-02: chmod 000 while waves run, modes restored afterwards, a stale lock file refuses a second lock', async () => {
    const d = tmp('dnr-lock-');
    const a = join(d, 'discussion');
    mkdirSync(a);
    const f = join(d, 'lockdown.json');
    await lock([a], f);
    expect(statSync(a).mode & 0o777).toBe(0);
    await expect(lock([a], f)).rejects.toThrow(/not restored/);
    expect(await unlock(f)).toBe(1);
    expect(statSync(a).mode & 0o777).toBe(0o755 & ~process.umask());
  });
});
