/**
 * Regression tests for the wave-3 trial audit (docs/review-wave3-trial-crew.md), T1–T5. Real
 * files, real FIFOs, real processes and the built `dnr`; no agent is simulated.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { aclCommand, aclListing, aclMechanism } from './acl';
import { runHarness } from './commands';
import { DEFAULT_ROOT, type TrialPaths } from './env';
import { bundleFiles } from './home';
import { grantRunDirs, osUserPreflight, requireIsolation } from './isolation';
import { lock, lockdownTargets, unlock } from './lockdown';
import { preregHashes } from './prereg';
import { clientScript, makeRelayDir } from './relay';
import { agentEnv, KiroRunner } from './runner';
import { isSealedLocked, lockSeal, runOutDir, sealedKeyFile, sealOutputs, unseal } from './seal';
import { runFlags, touchedPaths } from './transcript';

const tmps: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmps.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});
const dnrBin = join(DEFAULT_ROOT, 'packages/cli/dist/cli.js');
const DJ = process.env.DJANGO_SRC ?? join(DEFAULT_ROOT, '../dnr-work/django');

function io(env: Record<string, string>) {
  const err: string[] = [];
  return {
    err,
    io: {
      env: { ...process.env, ...env },
      cwd: DEFAULT_ROOT,
      out: () => {},
      err: (s: string) => err.push(s),
      deps: { renderSteering: () => '' },
    },
  };
}

describe('T1 run isolation (§9.3 isolation amendment)', () => {
  it('T1a: no DNR path reaches the agent environment, even if the harness has them set', () => {
    const env = agentEnv(
      {
        PATH: '/usr/bin',
        DNR_ORDERS: '/o',
        DNR_STATE_DIR: '/s',
        DNR_CONFIG: '/c',
        DNR_MODE: 'record',
        KIRO_API_KEY: 'k',
      },
      '/h',
      {},
    );
    expect(Object.keys(env).filter((k) => k.startsWith('DNR_'))).toEqual([]);
    expect(env.HOME).toBe('/h');
  });

  it('T1a: DNR paths appear only on the hook command line; with the relay (os-user) not even there', () => {
    const env = {
      DNR_MODE: 'record',
      DNR_STATE_DIR: '/tr/state/x',
      DNR_ORDERS: '/tr/orders/x',
      DNR_CONFIG: '/tr/config.json',
      DNR_RECORD_PATH: '/tr/state/x/e',
    };
    const direct = JSON.stringify(bundleFiles('record', ['dnr'], env));
    expect(direct).toContain('DNR_ORDERS=/tr/orders/x');
    const relay = JSON.stringify(bundleFiles('live', ['dnr'], env, '/tr/homes/x'));
    expect(relay).not.toMatch(/DNR_|\/tr\/orders|\/tr\/state|config\.json/);
    expect(relay).toContain('/bin/sh /tr/homes/x/.kiro/dnr-relay.sh check --stdin --hook kiro');
  });

  it.skipIf(!existsSync(dnrBin))(
    'T1b: the FIFO relay runs the real hook as the harness user, returns its exit code, and refuses non-bundle commands',
    async () => {
      const fx = JSON.parse(
        readFileSync(join(DEFAULT_ROOT, 'fixtures/hook-events/two-file-order.json'), 'utf8'),
      );
      const d = tmp('dnr-relay-');
      const repo = join(d, 'repo');
      mkdirSync(repo);
      const g = (...a: string[]) =>
        execFileSync('git', ['-C', repo, ...a], {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 't',
            GIT_AUTHOR_EMAIL: 't@x',
            GIT_COMMITTER_NAME: 't',
            GIT_COMMITTER_EMAIL: 't@x',
          },
        });
      g('init', '-q', '-b', 'main');
      for (const f of fx.files) {
        mkdirSync(dirname(join(repo, f.path)), { recursive: true });
        writeFileSync(join(repo, f.path), f.baseline_text);
      }
      g('add', '-A');
      g('commit', '-qm', 'b');
      mkdirSync(join(d, 'orders'));
      writeFileSync(join(d, 'orders', `${fx.order.id}.json`), JSON.stringify(fx.order));
      const relayDir = join(d, 'relay');
      await makeRelayDir(relayDir, null);
      const cfg = join(d, 'relay.json');
      const log = join(d, 'relay.log');
      writeFileSync(
        cfg,
        JSON.stringify({
          relayDir,
          workdir: repo,
          dnr: [process.execPath, dnrBin],
          env: {
            DNR_MODE: 'enforce',
            DNR_ORDERS: join(d, 'orders'),
            DNR_STATE_DIR: join(d, 'state'),
            DNR_CONFIG: join(d, 'none.json'),
            DNR_RECORD_PATH: join(d, 'state/events.jsonl'),
          },
          log,
        }),
      );
      writeFileSync(join(d, 'none.json'), '{}');
      const server = spawn(process.execPath, [dnrBin, 'trial', '__relay', cfg], { stdio: 'ignore' });
      writeFileSync(join(d, 'client.sh'), clientScript(relayDir));
      const client = (args: string[], input: string) => {
        try {
          return {
            code: 0,
            out: execFileSync('/bin/sh', [join(d, 'client.sh'), ...args], {
              cwd: repo,
              input,
              env: { PATH: '/usr/bin:/bin' },
              timeout: 20_000,
            }).toString(),
          };
        } catch (e) {
          return { code: (e as { status: number }).status, out: String((e as { stderr: Buffer }).stderr) };
        }
      };
      try {
        // First half through the relay: a warn (exit 2) that opens the session at the baseline.
        const warned = client(['check', '--stdin', '--hook', 'kiro'], JSON.stringify(fx.events[0]));
        expect(warned.code).toBe(2);
        expect(warned.out).not.toContain('matched');
        writeFileSync(join(repo, fx.events[0].tool_input.path), fx.events[0].tool_input.content);
        const blocked = client(['check', '--stdin', '--hook', 'kiro'], JSON.stringify(fx.events[1]));
        expect(blocked.code).toBe(2);
        expect(blocked.out).toContain(`DNR order ${fx.order.id} matched`);
        const refused = client(['orders', 'approve', '--all'], '');
        expect(refused.code).toBe(64);
        expect(refused.out).toContain('refused');
        const lines = readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
        expect(lines.map((l) => [l.args, l.code])).toEqual([
          ['check --stdin --hook kiro', 2],
          ['check --stdin --hook kiro', 2],
          ['orders approve --all', 64],
        ]);
        // the client script names no DNR path
        expect(readFileSync(join(d, 'client.sh'), 'utf8')).not.toMatch(/orders|state|DNR_/);
      } finally {
        server.kill('SIGKILL');
      }
    },
    60_000,
  );

  it('T1b: os-user preflight fails loudly when the agent user or the launcher does not exist', async () => {
    const p = await osUserPreflight(
      { user: 'dnrtrial-not-created', launcher: '/nonexistent/dnr-trial-agent' },
      { workdir: '/tmp', home: '/tmp' },
      [],
    );
    expect(p.join()).toMatch(/does not exist/);
    expect(statSync(join(DEFAULT_ROOT, 'scripts/trial/dnr-trial-agent.sh')).mode & 0o111).not.toBe(0);
  });

  const acl = aclMechanism();
  it.skipIf(acl === null)(
    `T1b: grantRunDirs gives the named users an inherited ACL and removes other access (owner-only, no root) via ${acl ?? 'no ACL mechanism (neither macOS chmod +a nor setfacl): skipped'}`,
    async () => {
      const tr = tmp('dnr-acl-');
      const wd = join(tr, 'runs/trial/T/x/r1');
      mkdirSync(wd, { recursive: true });
      writeFileSync(join(wd, 'a.py'), 'x');
      const me = execFileSync('id', ['-un']).toString().trim();
      await grantRunDirs({ trialRoot: tr, dirs: [wd], agentUser: me, harnessUser: me });
      expect(statSync(join(wd, 'a.py')).mode & 0o007).toBe(0);
      expect(statSync(join(tr, 'runs')).mode & 0o777).toBe(0o711);
      const listing = aclListing(wd);
      if (acl === 'macos-chmod') expect(listing).toMatch(new RegExp(`${me} allow .*inherit`));
      else {
        expect(listing).toMatch(new RegExp(`^user:${me}:rwx`, 'm'));
        expect(listing).toMatch(new RegExp(`^default:user:${me}:rwx`, 'm'));
      }
    },
  );

  it('T1b: os-user is refused (exit 69 path) where no ACL mechanism exists', () => {
    expect(() => requireIsolation('os-user', { dryRun: false, s1: null, acl: null })).toThrow(/ACL/);
    expect(aclCommand('posix-setfacl', 'dnrtrial', 'full', '/w')).toEqual({
      cmd: 'setfacl',
      args: ['-R', '-m', 'u:dnrtrial:rwX,d:u:dnrtrial:rwX', '/w'],
    });
    expect(aclCommand('macos-chmod', 'dnrtrial', 'read', '/f').args).toEqual([
      '+a',
      'dnrtrial allow read',
      '/f',
    ]);
  });

  it('T1c: sandbox mode adds --sandbox and stays refused until S1 records that it confines', () => {
    expect(
      new KiroRunner('kiro-cli', {}, { kind: 'sandbox' }).args({ model: 'm', agent: 'trial-T', prompt: 'p' }),
    ).toContain('--sandbox');
    expect(() => requireIsolation('sandbox', { dryRun: false, s1: null })).toThrow(/unverified/);
    const s1 = { recorded_by: 'k', recorded_at: 'd', evidence: 'e' };
    expect(() =>
      requireIsolation('sandbox', { dryRun: false, s1: { ...s1, sandbox_confines_file_and_shell: false } }),
    ).toThrow(/does not confine/);
    expect(() =>
      requireIsolation('sandbox', { dryRun: false, s1: { ...s1, sandbox_confines_file_and_shell: true } }),
    ).not.toThrow();
  });

  it('T1d: real runs need os-user or verified sandbox; none only with --dry-run; prereg refuses none (exit 69)', async () => {
    expect(() => requireIsolation('none', { dryRun: false, s1: null })).toThrow(/os-user/);
    expect(() => requireIsolation('none', { dryRun: true, s1: null })).not.toThrow();
    expect(() =>
      requireIsolation('os-user', { dryRun: false, s1: null, acl: 'posix-setfacl' }),
    ).not.toThrow();
    const tr = tmp('dnr-tr-');
    const a = io({ TRIAL_ROOT: tr });
    expect(await runHarness('run', ['--wave', '1', '--only', '1674c70525'], a.io)).toBe(69);
    expect(a.err.join('')).toMatch(/isolation/);
    const b = io({ TRIAL_ROOT: tr });
    expect(await runHarness('prereg', ['--out', join(tr, 'p.md')], b.io)).toBe(69);
    expect(existsSync(join(tr, 'p.md'))).toBe(false);
    expect(existsSync(join(tr, 'manifest.jsonl'))).toBe(false);
  });

  it('T1e: leak detection resolves relative paths, `..`, `cd`, variables and symlinks', () => {
    const tr = tmp('dnr-leak-');
    const wd = join(tr, 'runs/trial/T/x/r1');
    const home = join(tr, 'homes/trial/T/x/r1');
    mkdirSync(wd, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(join(tr, 'repos/later'), { recursive: true });
    mkdirSync(join(tr, 'out/trial/L/x/r1'), { recursive: true });
    mkdirSync(join(tr, 'orders/trial/T/x/r1'), { recursive: true });
    symlinkSync(join(tr, 'repos/later'), join(wd, 'innocent'));
    const sh = (command: string) =>
      JSON.stringify({ type: 'tool_use', name: 'execute_bash', input: { command } });
    const tx = [
      sh('cat ../../../../../repos/later'),
      sh('cd ../../../../.. && ls out'),
      sh('ls innocent/'),
      sh(`ls $SECRET_DIR`),
      sh('cat $MYORDERS/a.json'),
      JSON.stringify({
        type: 'tool_use',
        name: 'fs_read',
        input: { path: '../../../../../orders/trial/T/x/r1' },
      }),
      sh('cat django/db/models/query.py ./x ~/notes'),
    ].join('\n');
    const f = runFlags({
      transcript: tx,
      diff: '',
      workdir: wd,
      home,
      targetFile: 'a.py',
      env: { SECRET_DIR: join(tr, 'orders') },
    });
    const real = (p: string) => execFileSync('realpath', [p]).toString().trim();
    expect(f.out_of_tree).toEqual(
      [
        real(join(tr, 'orders')),
        real(join(tr, 'orders/trial/T/x/r1')),
        real(join(tr, 'out')),
        real(join(tr, 'repos/later')),
        real(tr),
      ].sort(),
    );
    expect(f.unresolved).toEqual(['$MYORDERS/a.json']);
    // paths inside the worktree and HOME are fine
    expect(
      touchedPaths([{ name: 'execute_bash', input: { command: 'cat ./a.py ~/x' }, line: 1 }], {
        workdir: wd,
        home,
      }).every((p) => p.startsWith(real(tr)) || p.startsWith(tr)),
    ).toBe(true);
  });

  it('T1f: the lockdown covers reports/, fixtures/, every truncated repo and other runs, deepest first', async () => {
    const root = tmp('dnr-root-');
    const tr = tmp('dnr-tr-');
    for (const d of ['reports/sealed', 'reports/labeling', 'fixtures/discussion'])
      mkdirSync(join(root, d), { recursive: true });
    for (const d of [
      'repos/a',
      'out/trial/T/x/r1',
      'out/trial/L/x/r1',
      'orders/trial/L/x/r1',
      'runs/trial/L/x/r1',
      'homes/trial/L/x/r1',
      'state/trial/L/x/r1',
    ])
      mkdirSync(join(tr, d), { recursive: true });
    const live = { run_id: 'trial/T/x/r1' };
    const other = { run_id: 'trial/L/x/r1' };
    const t = lockdownTargets(
      { root, djangoSrc: null, secondSrc: null, trialRoot: tr },
      [live],
      new Map([
        [live.run_id, live],
        [other.run_id, other],
      ]),
    );
    for (const p of [
      join(root, 'reports'),
      join(root, 'fixtures'),
      join(root, 'reports/sealed'),
      join(tr, 'repos'),
      join(tr, 'out/trial/L/x/r1'),
      join(tr, 'orders/trial/L/x/r1'),
      join(tr, 'homes/trial/L/x/r1'),
    ])
      expect(t).toContain(p);
    expect(t).not.toContain(join(tr, 'out/trial/T/x/r1'));
    const f = join(tr, 'lock.json');
    await lock(t, f);
    expect(statSync(join(root, 'reports')).mode & 0o777).toBe(0);
    await unlock(f);
    expect(statSync(join(root, 'reports/sealed')).mode & 0o700).toBe(0o700);
  });
});

describe('T3 sealed outputs before labeling', () => {
  it('T3: generate moves run outputs and state into reports/sealed, records the archive hash, and locks it until freeze', async () => {
    const tr = tmp('dnr-seal-');
    const rep = tmp('dnr-rep-');
    mkdirSync(join(tr, 'out/trial/T/x/r1'), { recursive: true });
    writeFileSync(join(tr, 'out/trial/T/x/r1/diff.patch'), 'd');
    mkdirSync(join(tr, 'state/trial/T/x/r1'), { recursive: true });
    mkdirSync(join(tr, 'runs'), { recursive: true });
    const P = {
      root: DEFAULT_ROOT,
      trialRoot: tr,
      reportsDir: rep,
      djangoSrc: null,
      secondSrc: null,
      labelingDir: join(tr, 'lab'),
      dryRun: false,
    } as TrialPaths;
    const h = await sealOutputs(P);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(tr, 'out'))).toBe(false);
    expect(runOutDir(P, 'trial/T/x/r1')).toBe(join(rep, 'sealed/runs/trial/T/x/r1'));
    expect(sealedKeyFile(P)).toBe(join(rep, 'sealed/packet-key.json'));
    await lockSeal(P);
    expect(isSealedLocked(P)).toBe(true);
    expect(statSync(join(rep, 'sealed')).mode & 0o777).toBe(0);
    expect(statSync(join(tr, 'runs')).mode & 0o777).toBe(0);
    await unseal(P);
    expect(isSealedLocked(P)).toBe(false);
    expect(readFileSync(join(rep, 'sealed/runs/trial/T/x/r1/diff.patch'), 'utf8')).toBe('d');
    await expect(sealOutputs({ ...P })).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('T3: labeling refuses while run outputs are not sealed', async () => {
    const tr = tmp('dnr-tr-');
    const a = io({ TRIAL_ROOT: tr });
    expect(await runHarness('label', ['--labeler', 'b'], a.io)).toBe(69);
    expect(a.err.join('')).toMatch(/not sealed/);
  });
});

describe('T4 S8 record required', () => {
  it.skipIf(aclMechanism() === null)(
    'T4: a real trial run and probe exit 69 until fixtures/s8.json exists (os-user needs an ACL mechanism to get that far)',
    async () => {
      if (existsSync(join(DEFAULT_ROOT, 'fixtures/s8.json'))) return;
      const tr = tmp('dnr-tr-');
      for (const [cmd, args] of [
        ['run', ['--wave', '1', '--isolation', 'os-user', '--only', '1674c70525']],
        ['probe', ['--isolation', 'os-user', '--only', '1674c70525']],
      ] as const) {
        const a = io({ TRIAL_ROOT: tr, DJANGO_SRC: DJ });
        expect(await runHarness(cmd, [...args], a.io)).toBe(69);
        expect(a.err.join('')).toMatch(/spike S8 not recorded \(fixtures\/s8\.json\)/);
      }
      expect(existsSync(join(tr, 'manifest.jsonl'))).toBe(false);
    },
  );
});

describe('T5 frozen config compared by hash', () => {
  it('T5: only the exact `.dnr/config.json` row of the hashed-inputs table counts', () => {
    const h = 'a'.repeat(64);
    const other = 'b'.repeat(64);
    const doc = [
      '# Pre-registration',
      `Some prose that mentions ${other} in passing.`,
      '## Hashed inputs (sha256)',
      '',
      '| File | sha256 |',
      '|---|---|',
      `| \`.dnr/config.json\` | \`${h}\` |`,
      `| \`fixtures/pins.json\` | \`${other}\` |`,
      '',
      '## Missing before the tag',
      `| \`.dnr/config.json\` | \`${other}\` |`,
    ].join('\n');
    const m = preregHashes(doc);
    expect(m.get('.dnr/config.json')).toBe(h);
    expect(m.size).toBe(2);
    expect(preregHashes(`text ${h}`).get('.dnr/config.json')).toBeUndefined();
  });
});
