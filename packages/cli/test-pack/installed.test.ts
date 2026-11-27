/**
 * The npm package as a stranger gets it: `pnpm -F dnr-guard pack`, then `npm i -g <tarball>` into
 * a fresh prefix. Every test runs the **installed** `dnr` (not the workspace build) on real git
 * repositories; human-only commands are typed into a real terminal (node-pty), as a human would.
 *
 * Needs `pnpm build` first (the package bundles the built board UI) and network for npm's
 * dependency install. Run with `pnpm test:pack`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AFTER, BEFORE, makeRepo, OTHER_EDIT, type Repo } from '../../hook/test/helpers';
import { runInTerminal, terminal } from './pty';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CLI_PKG = join(ROOT, 'packages', 'cli');
const UI_BUILD = join(ROOT, 'apps', 'playground', 'dist');
const VERSION = JSON.parse(readFileSync(join(CLI_PKG, 'package.json'), 'utf8')).version as string;

let work: string;
let tarball: string;
let DNR: string;
let PKG: string;
let HOME: string;
const repos: Repo[] = [];

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    PATH: `${join(work, 'prefix', 'bin')}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    HOME,
    USER: 'maintainer',
    LANG: 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@invalid',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@invalid',
    ...extra,
  };
  return e;
}

function dnr(cwd: string, args: string[]) {
  return spawnSync(DNR, args, { cwd, env: env(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** A real repo with a real `git revert`: C changes `total` in shop.py, R reverts it. */
function revertedRepo(): { repo: Repo; C: string; R: string } {
  const repo = makeRepo();
  repos.push(repo);
  repo.write('shop.py', BEFORE);
  repo.commit('base');
  repo.write('shop.py', AFTER);
  const C = repo.commit('Count only active items, with quantities (#1)');
  repo.git('revert', '--no-edit', 'HEAD');
  const R = repo.git('rev-parse', 'HEAD').trim();
  return { repo, C, R };
}

beforeAll(() => {
  if (!existsSync(join(CLI_PKG, 'dist', 'cli.js')) || !existsSync(join(CLI_PKG, 'dist', 'ui', 'index.html')))
    throw new Error('test:pack needs the built package: run `pnpm build` first');
  work = realpathSync(mkdtempSync(join(tmpdir(), 'dnr-pack-')));
  HOME = join(work, 'home');
  execFileSync('mkdir', ['-p', HOME]);
  execFileSync('pnpm', ['-F', 'dnr-guard', 'pack', '--pack-destination', work], { cwd: ROOT, stdio: 'pipe' });
  tarball = join(work, `dnr-guard-${VERSION}.tgz`);
  execFileSync('npm', ['i', '-g', tarball, '--prefix', join(work, 'prefix'), '--no-audit', '--no-fund'], {
    cwd: work,
    stdio: 'pipe',
    env: { ...process.env, npm_config_loglevel: 'error' },
  });
  DNR = join(work, 'prefix', 'bin', 'dnr');
  PKG = realpathSync(join(work, 'prefix', 'lib', 'node_modules', 'dnr-guard'));
}, 300_000);

afterAll(() => {
  for (const r of repos) r.cleanup();
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('installed dnr-guard package', () => {
  it('pkg: the tarball ships the bundle, grammars, templates and the whole built board UI', () => {
    const files = new Set(
      execFileSync('tar', ['tzf', tarball], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((f) => f.replace(/^package\//, '')),
    );
    for (const f of [
      'dist/cli.js',
      'vendor/grammars/tree-sitter-python.wasm',
      'vendor/grammars/tree-sitter-typescript.wasm',
      'vendor/grammars/tree-sitter-tsx.wasm',
      'templates/steering/dnr.md',
      'templates/mcp.json',
      'dist/ui/index.html',
    ])
      expect(files, f).toContain(f);
    const ui = execFileSync('find', ['.', '-type', 'f'], { cwd: UI_BUILD, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && !/(^|\/)(_headers|robots\.txt)$/.test(f))
      .map((f) => `dist/ui/${f.replace(/^\.\//, '')}`);
    expect(ui.length).toBeGreaterThan(5);
    for (const f of ui) expect(files, f).toContain(f);
  });

  it('pkg: installed `dnr --version` prints the package version', () => {
    const r = dnr(work, ['--version']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(VERSION);
  });

  it('R6 guard: installed `dnr init` without a TTY refuses with exit 64 and writes nothing', () => {
    const { repo } = revertedRepo();
    const r = dnr(repo.dir, ['init']);
    expect(r.status, r.stderr).toBe(64);
    expect(r.stderr).toContain('no TTY');
    expect(existsSync(join(repo.dir, '.kiro'))).toBe(false);
    expect(existsSync(join(repo.dir, '.dnr'))).toBe(false);
  });

  it('P13-09: installed `dnr init` in a terminal points every hook at the installed bundle; `dnr doctor` confirms they resolve', async () => {
    const { repo } = revertedRepo();
    const init = await runInTerminal([DNR, 'init'], {
      cwd: repo.dir,
      env: env(),
      answers: [[/Install these rules\? \[y\/N\]/, 'y\r']],
    });
    expect(init.code, init.output).toBe(0);
    const hooks = execFileSync('ls', [join(repo.dir, '.kiro', 'hooks')], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(hooks.length).toBeGreaterThanOrEqual(5);
    for (const h of hooks) {
      const j = JSON.parse(readFileSync(join(repo.dir, '.kiro', 'hooks', h), 'utf8'));
      expect(j.hooks[0].action.command, h).toContain(`${join(PKG, 'dist', 'cli.js')} `);
    }
    const doc = dnr(repo.dir, ['doctor']);
    const lines = doc.stdout.trim().split('\n');
    for (const l of lines.filter((x) => !/ kiro-cli/.test(x))) expect(l, doc.stdout).toMatch(/^ok /);
    for (const h of hooks)
      expect(doc.stdout).toMatch(
        new RegExp(
          `ok\\s+hook ${h.replace('.json', '')}\\s+\`\\S*node\` resolves to ${join(PKG, 'dist', 'cli.js')}`,
        ),
      );
    expect(doc.stdout).toMatch(/ok\s+bundle integrity/);
    expect(doc.stdout).toMatch(/ok\s+grammars/);
  }, 180_000);

  it('P6-11: installed `dnr doctor` reports kiro-cli and its login exactly as the real kiro-cli does', () => {
    const { repo } = revertedRepo();
    const doc = dnr(repo.dir, ['doctor']);
    const which = spawnSync('sh', ['-c', 'command -v kiro-cli'], { env: env(), encoding: 'utf8' });
    if (which.status !== 0) {
      expect(doc.stdout).toMatch(/FAIL kiro-cli\s+kiro-cli not found on PATH/);
      return;
    }
    const version = execFileSync('kiro-cli', ['--version'], { env: env(), encoding: 'utf8' }).trim();
    expect(doc.stdout).toContain(version);
    const who = spawnSync('kiro-cli', ['whoami'], { env: env(), encoding: 'utf8' });
    if (who.status === 0) expect(doc.stdout).toMatch(/ok\s+kiro-cli login/);
    else if (/not logged in/i.test(`${who.stdout}${who.stderr}`))
      expect(doc.stdout).toContain(
        `FAIL kiro-cli login           ${version} is installed but not logged in: run \`kiro-cli login\``,
      );
    else expect(doc.stdout).toMatch(/FAIL kiro-cli login\s+kiro-cli whoami exited/);
  });

  it('P12-11: installed product flow: init, scan, orders build and approve in a terminal; check --file blocks the re-application and allows a hard negative', async () => {
    const { repo, C, R } = revertedRepo();
    const t = { cwd: repo.dir, env: env(), answers: [[/\[y\/N\]/, 'n\r']] as Array<[RegExp, string]> };
    expect((await runInTerminal([DNR, 'init'], t)).code).toBe(0);
    const scan = dnr(repo.dir, ['scan']);
    expect(scan.status, scan.stderr + scan.stdout).toBe(0);
    const cands = JSON.parse(readFileSync(join(repo.dir, '.dnr', 'candidates.json'), 'utf8'));
    expect(cands).toEqual([
      expect.objectContaining({
        revert_sha: R,
        original_sha: C,
        units: [{ file: 'shop.py', qualname: 'total' }],
      }),
    ]);
    // orders build into the live directory is human-only, so it refuses here and runs in a terminal.
    expect(dnr(repo.dir, ['orders', 'build']).status).toBe(64);
    const build = await runInTerminal([DNR, 'orders', 'build'], t);
    expect(build.code, build.output).toBe(0);
    const id = `dnr-${R.slice(0, 10)}`;
    expect(build.output).toContain(`${id} created (draft)`);
    expect(dnr(repo.dir, ['orders', 'approve', id]).status).toBe(64);
    const approve = await runInTerminal([DNR, 'orders', 'approve', id], t);
    expect(approve.code, approve.output).toBe(0);
    expect(approve.output).toContain(`${id} approved by maintainer`);

    writeFileSync(join(repo.dir, '.proposed-reapply.py'), AFTER);
    const block = dnr(repo.dir, ['check', '--file', 'shop.py', '--proposed', '.proposed-reapply.py']);
    expect(block.status, block.stdout + block.stderr).toBe(1);
    const b = JSON.parse(block.stdout);
    expect(b.decision.outcome).toBe('block');
    expect(b.stderr).toContain(id);
    // Hard negative: a different edit to the covered function is not a re-application. It is never
    // blocked; it gets the once-per-session covered-unit warning (warn_block, exit 1).
    writeFileSync(join(repo.dir, '.proposed-other.py'), OTHER_EDIT);
    const other = dnr(repo.dir, ['check', '--file', 'shop.py', '--proposed', '.proposed-other.py']);
    const o = JSON.parse(other.stdout);
    expect(o.decision.outcome, other.stdout).toBe('warn_block');
    expect(o.stderr).toContain('not a re-application');
    // An edit outside the covered unit is allowed outright.
    writeFileSync(join(repo.dir, '.proposed-unrelated.py'), BEFORE.replace('return x + 1', 'return x + 2'));
    const allow = dnr(repo.dir, ['check', '--file', 'shop.py', '--proposed', '.proposed-unrelated.py']);
    expect(allow.status, allow.stdout + allow.stderr).toBe(0);
    expect(JSON.parse(allow.stdout).decision.outcome).toBe('allow');
  }, 240_000);

  it('pkg: installed `dnr board` serves the built UI over HTTP behind the launch nonce, cookie, Origin and CSRF checks', async () => {
    const { repo, R } = revertedRepo();
    const t = { cwd: repo.dir, env: env(), answers: [[/\[y\/N\]/, 'n\r']] as Array<[RegExp, string]> };
    expect((await runInTerminal([DNR, 'init'], t)).code).toBe(0);
    expect(dnr(repo.dir, ['scan']).status).toBe(0);
    expect((await runInTerminal([DNR, 'orders', 'build'], t)).code).toBe(0);
    const id = `dnr-${R.slice(0, 10)}`;
    // Refuses without a TTY.
    expect(dnr(repo.dir, ['board', '--no-open']).status).toBe(64);

    const term = terminal([DNR, 'board', '--port', '0', '--host', '127.0.0.1', '--no-open'], {
      cwd: repo.dir,
      env: env(),
    });
    try {
      const origin = (await term.waitFor(/DNR board on (http:\/\/127\.0\.0\.1:\d+)/))[1] as string;
      const file = (await term.waitFor(/sign in: (\S+open\.html)/))[1] as string;
      expect(term.output()).not.toContain('n=');
      // The real UI, not the stub, with the API adapter injected.
      const index = await fetch(`${origin}/graveyard`);
      expect(index.status).toBe(200);
      const html = await index.text();
      expect(html).toContain('<meta name="dnr-adapter" content="api">');
      expect(html).toBe(
        readFileSync(join(UI_BUILD, 'index.html'), 'utf8').replace(
          /<head(\s[^>]*)?>/i,
          (m) => `${m}<meta name="dnr-adapter" content="api">`,
        ),
      );
      const script = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] as string;
      expect(script).toBeTruthy();
      const js = await fetch(`${origin}${script}`);
      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toMatch(/javascript/);
      expect(Buffer.from(await js.arrayBuffer())).toEqual(readFileSync(join(UI_BUILD, script.slice(1))));
      const cases = await fetch(`${origin}/cases/index.json`);
      expect(cases.status).toBe(200);
      expect(await cases.json()).toEqual(
        JSON.parse(readFileSync(join(UI_BUILD, 'cases', 'index.json'), 'utf8')),
      );
      // Auth: no cookie → 401.
      expect((await fetch(`${origin}/api/orders`)).status).toBe(401);
      // Launch: file → one-shot URL → /launch?n= → ticket → /session sets the cookie.
      const go = /location\.replace\("([^"]+)"\)/.exec(readFileSync(file, 'utf8'))?.[1] as string;
      const r1 = await fetch(go, { redirect: 'manual' });
      expect(r1.status).toBe(302);
      const launch = r1.headers.get('location') as string;
      expect(launch).toMatch(/\/launch\?n=/);
      const page = await (await fetch(launch)).text();
      const ticket = /data-ticket="([^"]+)"/.exec(page)?.[1] as string;
      const s = await fetch(`${origin}/session?t=${ticket}`, { redirect: 'manual' });
      expect(s.status).toBe(302);
      const cookie = (s.headers.get('set-cookie') as string).split(';')[0] as string;
      expect((await fetch(launch)).status).toBe(403); // the nonce is single-use
      const list = await fetch(`${origin}/api/orders`, { headers: { cookie } });
      expect(list.status).toBe(200);
      const rows = (await list.json()).orders as Array<{ order: { id: string }; effective: string }>;
      expect(rows.map((r) => [r.order.id, r.effective])).toEqual([[id, 'draft']]);
      // A mutation without Origin / X-DNR-CSRF is refused; with both, it approves the real order.
      const body = JSON.stringify({ status: 'approved' });
      const patch = (headers: Record<string, string>) =>
        fetch(`${origin}/api/orders/${id}`, {
          method: 'PATCH',
          headers: { cookie, 'content-type': 'application/json', ...headers },
          body,
        });
      expect((await patch({})).status).toBe(403);
      expect((await patch({ origin })).status).toBe(403);
      expect((await patch({ origin: 'http://evil.example', 'x-dnr-csrf': '1' })).status).toBe(403);
      const ok = await patch({ origin, 'x-dnr-csrf': '1' });
      expect(ok.status, await ok.clone().text()).toBe(200);
      const order = JSON.parse(readFileSync(join(repo.dir, '.dnr', 'orders', `${id}.json`), 'utf8'));
      expect(order.status).toBe('approved');
      // DNS rebinding: a foreign Host is 421.
      const { request } = await import('node:http');
      const port = new URL(origin).port;
      const status = await new Promise<number>((res, rej) => {
        const q = request({ host: '127.0.0.1', port, path: '/', headers: { host: 'evil.example' } }, (r) => {
          r.resume();
          res(r.statusCode ?? 0);
        });
        q.on('error', rej);
        q.end();
      });
      expect(status).toBe(421);
    } finally {
      term.type('\x03');
    }
    expect(await term.exited).not.toBe(-1);
    expect(existsSync(join(repo.dir, '.dnr', 'board.json'))).toBe(false);
  }, 240_000);
});
