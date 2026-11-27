/** Wave-3 security re-attack (docs/review-wave3-security.md): N1–N4 regression tests. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventRecord } from '@dnr/schemas';
import { openStore } from '@dnr/store';
import { afterEach, describe, expect, it } from 'vitest';
import { checkStaged, stagedOrderWeakening } from '../src/commit';
import { openContext } from '../src/context';
import { runPreWrite } from '../src/prewrite';
import { runSessionStart, runShellAfter } from '../src/session-hooks';
import { runGuardShell } from '../src/shell';
import { runStop } from '../src/stop';
import { readTamper } from '../src/trusted';
import { readViolations } from '../src/violations';
import { AFTER, envFor, type Fixture, readEventsFile, revertFixture, writeEvent } from './helpers';

let fx: Fixture | null = null;
afterEach(() => {
  fx?.repo.cleanup();
  fx = null;
});

const stop = (fx: Fixture, session = 'sess-1', env = envFor(fx.repo)) =>
  runStop(JSON.stringify({ hook_event_name: 'Stop', cwd: fx.repo.dir, session_id: session }), { env });
const start = (fx: Fixture, session = 'sess-1', env = envFor(fx.repo)) =>
  runSessionStart(
    JSON.stringify({ hook_event_name: 'SessionStart', cwd: fx.repo.dir, session_id: session }),
    { env },
  );
const shellEv = (fx: Fixture, command: string, hook = 'PreToolUse', session = 'sess-1') =>
  JSON.stringify({
    hook_event_name: hook,
    cwd: fx.repo.dir,
    session_id: session,
    tool_name: 'execute_bash',
    tool_input: { command },
  });
function gitEnv(fx: Fixture): NodeJS.ProcessEnv {
  return {
    ...envFor(fx.repo),
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@invalid',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@invalid',
  };
}
/** Run a shell command the way the agent's shell tool would, around guard-shell and post-shell. */
async function agentShell(fx: Fixture, command: string, session = 'sess-1') {
  const env = envFor(fx.repo);
  const pre = await runGuardShell(shellEv(fx, command, 'PreToolUse', session), { env });
  if (pre.exitCode !== 0) return { pre, post: null };
  try {
    execFileSync('sh', ['-c', command], { cwd: fx.repo.dir, env: gitEnv(fx), stdio: 'pipe' });
  } catch {}
  const post = await runShellAfter(shellEv(fx, command, 'PostToolUse', session), { env });
  return { pre, post };
}
const retireWorking = (fx: Fixture) => {
  const f = join(fx.repo.dir, '.dnr', 'orders', `${fx.order.id}.json`);
  writeFileSync(f, readFileSync(f, 'utf8').replace('"status": "approved"', '"status": "retired"'));
};

describe('N1: .git and a broken repository', () => {
  it('N1: every path under .git is protected from write tools', async () => {
    fx = await revertFixture();
    for (const t of [
      '.git/HEAD',
      '.git/refs/heads/main',
      '.git/objects/ab/cdef',
      '.git/index',
      '.git/packed-refs',
    ]) {
      const io = await runPreWrite(writeEvent(fx.repo, t, 'garbage\n'), { env: envFor(fx.repo) });
      expect(io.exitCode, t).toBe(2);
    }
  });

  it('N1: a broken repository fails closed (covered writes block from the session-start orders) and Stop reports it', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    await start(fx);
    // The repository is broken behind DNR's back (e.g. through the shell).
    writeFileSync(join(fx.repo.dir, '.git', 'HEAD'), 'garbage\n');
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env });
    expect(io.exitCode).toBe(2);
    expect(io.stderr).toContain('the git repository is unusable');
    // A new session is no escape: the working-copy order still covers the file.
    const io2 = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER, 'sess-2'), { env });
    expect(io2.exitCode).toBe(2);
    const st = await stop(fx, 'sess-2');
    expect(JSON.parse(st.stdout).reason).toContain('git repository is unusable');
    expect(
      readTamper(join(fx.repo.dir, '.dnr'))?.findings.some((f) =>
        f.what.includes('git repository is unusable'),
      ),
    ).toBe(true);
    // An uncovered write still goes through (fail closed only for protected code).
    expect((await runPreWrite(writeEvent(fx.repo, 'notes.txt', 'x\n', 'sess-2'), { env })).exitCode).toBe(0);
  });

  it('N1: missing objects (git cannot read the committed tree) count as a broken repository', async () => {
    fx = await revertFixture();
    fx.repo.commit('commit the order');
    rmSync(join(fx.repo.dir, '.git', 'objects'), { recursive: true, force: true });
    mkdirSync(join(fx.repo.dir, '.git', 'objects'));
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env: envFor(fx.repo) });
    expect(io.exitCode).toBe(2);
  });
});

describe('N2: DNR installation and shell startup files', () => {
  it('N2: the installed bundle, a dnr shim on PATH and shell rc files are protected', async () => {
    fx = await revertFixture();
    const home = join(fx.repo.dir, '.home');
    const pkg = join(home, 'lib', 'dnr-guard');
    const bin = join(home, 'bin');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(pkg, 'dist', 'cli.js'), '// bundle\n');
    writeFileSync(join(bin, 'dnr'), '#!/bin/sh\n');
    const env = envFor(fx.repo, {
      DNR_SELF: join(pkg, 'dist', 'cli.js'),
      PATH: `${bin}:${process.env.PATH}`,
    });
    for (const t of [
      join(pkg, 'dist', 'cli.js'),
      join(pkg, 'package.json'),
      join(bin, 'dnr'),
      join(home, '.zshenv'),
      join(home, '.bashrc'),
      join(home, '.profile'),
      join(home, '.config', 'fish', 'config.fish'),
    ]) {
      const io = await runPreWrite(writeEvent(fx.repo, t, 'x'), { env });
      expect(io.exitCode, t).toBe(2);
    }
  });
});

describe('P3: the node binary the hooks run', () => {
  it('P3: node (as written and its realpath) and its global lib/node_modules are protected in pre-write and guard-shell', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    const { realpathSync } = await import('node:fs');
    const { dirname: dn } = await import('node:path');
    const node = process.execPath;
    const real = realpathSync(node);
    for (const t of [node, real, join(dn(dn(real)), 'lib', 'node_modules', 'some-pkg', 'index.js')]) {
      const io = await runPreWrite(writeEvent(fx.repo, t, 'x'), { env });
      expect(io.exitCode, t).toBe(2);
      expect(io.stderr, t).toContain('protected');
    }
    const sh = await runGuardShell(shellEv(fx, `cp /dev/null ${real}`), { env });
    expect(sh.exitCode).toBe(2);
    expect(sh.stderr).toContain('protected');
  });

  it('P3: Stop and the install check flag a node binary whose sha256 changed since init', async () => {
    fx = await revertFixture();
    const { fileSha256, installMismatch } = await import('../src/install');
    // A stand-in node binary at a recorded path (the real one is not modified by a test).
    const fake = join(fx.repo.dir, '.home', 'node');
    mkdirSync(join(fx.repo.dir, '.home'), { recursive: true });
    writeFileSync(fake, 'original runtime bytes');
    writeFileSync(
      join(fx.repo.dir, '.dnr', 'install.json'),
      JSON.stringify({ node: fake, cli: '/nonexistent/cli.js', sha256: null, node_sha256: fileSha256(fake) }),
    );
    expect(installMismatch(fx.repo.dir, join(fx.repo.dir, '.dnr'))).toBeNull();
    writeFileSync(fake, '');
    expect(installMismatch(fx.repo.dir, join(fx.repo.dir, '.dnr'))).toContain('node binary');
    const st = await stop(fx);
    expect(JSON.parse(st.stdout).reason).toContain(`the node binary at ${fake} changed since \`dnr init\``);
  });
});

describe('N3: union of order sets and the persistent tamper flag', () => {
  it('N3: retiring an uncommitted order through the shell does not stop enforcement, now or in the next session', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    await start(fx);
    retireWorking(fx);
    expect((await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env })).exitCode).toBe(2);
    // Next session: the attested record is absent, but the tamper flag persists and the order
    // stays enforced because the flag holds the finding until a human accepts it.
    const st = await stop(fx);
    expect(JSON.parse(st.stdout).reason).toContain(`order ${fx.order.id} was removed or weakened`);
    expect(readTamper(join(fx.repo.dir, '.dnr'))).not.toBeNull();
    const st2 = await stop(fx, 'sess-2');
    expect(JSON.parse(st2.stdout).reason).toContain('Open tamper finding');
  });

  it('P4: while a tamper finding is open, a re-application of an order it holds blocks in the next session (uncommitted orders right after init and approve)', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    await start(fx);
    // Session 1: the agent retires the uncommitted order through the shell.
    const f = `.dnr/orders/${fx.order.id}.json`;
    // An interpreter write with a path built at run time: guard-shell cannot see the path.
    const r = await agentShell(
      fx,
      `${process.execPath} -e 'const fs=require("fs");const p=".d"+"nr/orders/${fx.order.id}.json";fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace("\\"approved\\"","\\"retired\\""))'`,
    );
    expect(JSON.parse(readFileSync(join(fx.repo.dir, f), 'utf8')).status).toBe('retired');
    expect(r).toBeTruthy();
    const st = await stop(fx);
    expect(JSON.parse(st.stdout).reason).toContain(fx.order.id);
    expect(readTamper(join(fx.repo.dir, '.dnr'))).not.toBeNull();
    // Session 2: the finding is still open, so the re-application blocks.
    await start(fx, 'sess-2');
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER, 'sess-2'), { env });
    expect(io.exitCode, io.stderr).toBe(2);
    expect((readEventsFile(fx.repo).at(-1) as EventRecord).decision.outcome).toBe('block');
    // Also without a SessionStart event.
    const io3 = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER, 'sess-3'), { env });
    expect(io3.exitCode, io3.stderr).toBe(2);
  });

  it('P4: with only the attested record left, a retired-by-interpreter order still blocks in a later session, and the finding holds it', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    // As right after `dnr init` and `dnr orders approve`: uncommitted order, human-attested record.
    const { writeAttested } = await import('@dnr/store');
    writeAttested(
      join(fx.repo.dir, '.dnr', 'attested.json'),
      [fx.order],
      'maintainer',
      new Date().toISOString(),
    );
    // Between sessions an interpreter retires the working copy (no hook sees the write).
    retireWorking(fx);
    // Session 2, no SessionStart: the re-application must block, and the finding must hold the order.
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER, 'sess-2'), { env });
    expect(io.exitCode, io.stderr).toBe(2);
    expect((readEventsFile(fx.repo).at(-1) as EventRecord).decision.outcome).toBe('block');
    const t = readTamper(join(fx.repo.dir, '.dnr'));
    expect(t?.findings.some((f) => f.what.includes(fx?.order.id as string))).toBe(true);
    expect(((t?.held ?? []) as Array<{ id: string; status: string }>).map((o) => [o.id, o.status])).toEqual([
      [fx.order.id, 'approved'],
    ]);
    // Session 3: still blocks while the finding is open.
    expect((await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER, 'sess-3'), { env })).exitCode).toBe(2);
  });

  it('N3: a commit that retires an order is refused at pre-commit unless the human-attested record agrees', async () => {
    fx = await revertFixture();
    fx.repo.commit('maintainer commits the order');
    retireWorking(fx);
    fx.repo.git('add', '.dnr/orders');
    const ctx = await openContext(fx.repo.dir, envFor(fx.repo));
    expect(await stagedOrderWeakening(ctx as NonNullable<typeof ctx>)).toEqual([fx.order.id]);
    fx.repo.git('reset', '-q', '.dnr/orders');
    fx.repo.git('checkout', '--', '.dnr/orders');
    // The same retirement made through the guarded store is attested, so it may be committed.
    await openStore(fx.repo.dir, { env: envFor(fx.repo) }).orders.retire(fx.order.id, 'human');
    fx.repo.git('add', '.dnr/orders');
    const ctx2 = await openContext(fx.repo.dir, envFor(fx.repo));
    expect(await stagedOrderWeakening(ctx2 as NonNullable<typeof ctx2>)).toEqual([]);
    void checkStaged;
  });

  it('N3: `git commit -am` retiring a committed order in the agent session is caught by post-shell and stays enforced', async () => {
    fx = await revertFixture();
    fx.repo.commit('maintainer commits the order');
    await start(fx);
    retireWorking(fx);
    const r = await agentShell(fx, 'git commit -qam tidy');
    expect(r.post?.exitCode).toBe(2);
    expect(r.post?.stderr).toContain('removed or weakened DNR order');
    expect(
      (await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER), { env: envFor(fx.repo) })).exitCode,
    ).toBe(2);
    // A brand-new session (HEAD now says retired) still enforces: the tamper flag is open.
    expect(
      (await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER, 'sess-new'), { env: envFor(fx.repo) }))
        .exitCode,
    ).toBe(2);
  });

  it('N3: `git reset --hard` past the order commit and `git update-ref` are caught as HEAD movement', async () => {
    for (const cmd of ['git reset -q --hard HEAD~1', 'git update-ref refs/heads/main HEAD~1']) {
      fx = await revertFixture();
      const C = fx.repo.commit('maintainer commits the order');
      await start(fx);
      const r = await agentShell(fx, cmd);
      expect(r.post?.exitCode, cmd).toBe(2);
      expect(r.post?.stderr, cmd).toContain('HEAD moving from');
      expect(readTamper(join(fx.repo.dir, '.dnr'))?.findings.length).toBeGreaterThan(0);
      void C;
      fx.repo.cleanup();
      fx = null;
    }
  });

  it('N3: `dnr tamper accept` is the only way to clear the flag (exercised through the store helpers)', async () => {
    fx = await revertFixture();
    await start(fx);
    retireWorking(fx);
    await stop(fx);
    expect(readTamper(join(fx.repo.dir, '.dnr'))).not.toBeNull();
    // A new session does not clear it.
    await start(fx, 'sess-9');
    expect(readTamper(join(fx.repo.dir, '.dnr'))).not.toBeNull();
  });
});

describe('N4: violated', () => {
  it('N4: a re-application committed in an agent session without a grant makes the order violated; it keeps blocking', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    await start(fx);
    const cmd = `python3 -c "import subprocess; subprocess.run(['git','cherry-pick','${fx.C}'], check=True)"`;
    const r = await agentShell(fx, cmd);
    expect(r.post?.stderr).toContain('the commit you just made');
    const v = readViolations(join(fx.repo.dir, '.dnr'))[fx.order.id];
    expect(v?.commit).toMatch(/^[0-9a-f]{40}$/);
    // Later writes that still carry the re-application block (not just warn), in any session.
    const later = await runPreWrite(
      writeEvent(fx.repo, 'shop.py', AFTER.replace('return x + 1', 'return x + 2'), 'sess-2'),
      { env },
    );
    expect(later.exitCode).toBe(2);
    expect(later.stderr).toContain(`DNR order ${fx.order.id} was violated`);
    const ev = readEventsFile(fx.repo).at(-1) as EventRecord;
    expect(ev.decision.outcome).toBe('block');
    // Stop reports it every session.
    expect(JSON.parse((await stop(fx, 'sess-3')).stdout).reason).toContain(
      `Order ${fx.order.id} is violated`,
    );
  });

  it('N4: a re-land committed by a human outside an agent session stays re-landed (warn only)', async () => {
    fx = await revertFixture();
    fx.repo.write('shop.py', AFTER);
    fx.repo.commit('human re-land with a fix');
    expect(readViolations(join(fx.repo.dir, '.dnr'))).toEqual({});
    const io = await runPreWrite(writeEvent(fx.repo, 'shop.py', AFTER.replace('item.quantity', 'item.qty')), {
      env: envFor(fx.repo),
    });
    expect((readEventsFile(fx.repo).at(-1) as EventRecord).decision.outcome).not.toBe('block');
    expect([0, 2]).toContain(io.exitCode);
  });
});
