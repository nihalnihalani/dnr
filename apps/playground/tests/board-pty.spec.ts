/**
 * The Phase 12 board flow through a real `dnr board` (plan §10, Phase 12 acceptance):
 *
 * - the **built** CLI (`packages/cli/dist/cli.js`) is started by an interactive shell inside a
 *   `node-pty` terminal, so the real R6 human guard (TTY, Kiro variables, process ancestry)
 *   decides, as it does for a maintainer;
 * - the repository is a real git repo with a real revert and a real order (RealRepo);
 * - agent writes are real PreToolUse events piped into the built `dnr check --stdin --hook kiro`,
 *   the exact command `.kiro/hooks/` registers, with no TTY (as Kiro runs hooks);
 * - the browser is driven only through the board UI.
 *
 * The one thing replaced is the OS "open in browser" helper (`open` / `xdg-open`): a script on
 * PATH records the file `dnr board` asks it to open, and Playwright's browser opens that file
 * instead of the desktop browser. Everything after that is the real launch: one-shot file →
 * single-use nonce → session ticket → cookie.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import type { IPty } from 'node-pty';
import { RealRepo } from '../../board/src/real-repo';
import { expectNoAxeViolations, isRemote } from './helpers';

test.skip(isRemote, 'board tests need the local build');

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const CLI = join(ROOT, 'packages/cli/dist/cli.js');

interface Launched {
  repo: RealRepo;
  pty: IPty;
  port: number;
  /** Everything the terminal printed so far. */
  screen: () => string;
}

let live: Launched | null = null;
let shim: string | null = null;

test.afterEach(async () => {
  if (live) {
    const { pty, repo } = live;
    pty.write('\x03'); // Ctrl-C: dnr board shuts down and removes board.json
    await new Promise((r) => setTimeout(r, 300));
    pty.write('exit\r');
    await new Promise((r) => setTimeout(r, 200));
    try {
      pty.kill();
    } catch {}
    repo.dispose();
  }
  if (shim) rmSync(shim, { recursive: true, force: true });
  live = null;
  shim = null;
});

async function waitFor<T>(what: string, fn: () => T | undefined | null | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Start an interactive shell in a pty and type `dnr board` into it, as a maintainer would. */
async function launchInPty(
  page: Page,
  args: string[] = [],
  prepare?: (repo: RealRepo) => Promise<void>,
): Promise<Launched> {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run pnpm -F dnr-guard build first`);
  const { spawn: ptySpawn } = await import('node-pty');
  const repo = await RealRepo.create();
  await prepare?.(repo);
  shim = mkdtempSync(join(tmpdir(), 'dnr-opener-'));
  const opened = join(shim, 'opened.txt');
  for (const name of ['open', 'xdg-open']) {
    const f = join(shim, name);
    writeFileSync(f, `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`);
    chmodSync(f, 0o755);
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(repo.env)) if (v !== undefined) env[k] = v;
  env.PATH = `${shim}:${process.env.PATH ?? ''}`;
  env.PS1 = '$ ';
  env.TERM = 'xterm-256color';
  const pty = ptySpawn('bash', ['--noprofile', '--norc', '-i'], {
    name: 'xterm-256color',
    cols: 160,
    rows: 40,
    cwd: repo.dir,
    env,
  });
  let out = '';
  pty.onData((d) => {
    out += d;
  });
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  pty.write(`${q(process.execPath)} ${q(CLI)} board --port 0 ${args.map(q).join(' ')}\r`);
  const port = await waitFor('the board to start', () => {
    if (/Only a human maintainer|DNR: /.test(out) && !/DNR board on/.test(out))
      throw new Error(`dnr board refused or failed:\n${out}`);
    const m = out.match(/DNR board on http:\/\/[^:\s]+:(\d+)/);
    return m ? Number(m[1]) : null;
  });
  const file = await waitFor('dnr board to open the browser', () =>
    existsSync(opened) ? readFileSync(opened, 'utf8') : null,
  );
  await page.goto(pathToFileURL(file).href);
  live = { repo, pty, port, screen: () => out };
  return live;
}

/** Run a built hook command (as `.kiro/hooks/` registers it) with `stdin`, no TTY. */
function hook(repo: RealRepo, args: string[], stdin: string): Promise<{ code: number; stderr: string }> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      cwd: repo.dir,
      env: repo.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr += String(d);
    });
    p.stdout.resume();
    p.on('error', rej);
    p.on('close', (code) => res({ code: code ?? -1, stderr }));
    p.stdin.end(stdin);
  });
}

/** A real agent write: a PreToolUse event into the built hook command, no TTY. */
function agentWrite(
  repo: RealRepo,
  session: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stderr: string }> {
  const text = readFileSync(join(ROOT, 'packages/cli/templates/demo/43933a1dca.case.json'), 'utf8');
  const change = (JSON.parse(text) as { files: Array<{ change_text: string }> }).files[0]?.change_text;
  const ev = {
    hook_event_name: 'PreToolUse',
    cwd: repo.dir,
    session_id: session,
    tool_name: 'fs_write',
    tool_input: { command: 'create', path: join(repo.dir, repo.file), file_text: change },
  };
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [CLI, 'check', '--stdin', '--hook', 'kiro'], {
      cwd: repo.dir,
      env: { ...repo.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr += String(d);
    });
    p.stdout.resume();
    p.on('error', rej);
    p.on('close', (code) => res({ code: code ?? -1, stderr }));
    p.stdin.end(JSON.stringify(ev));
  });
}

const stone = (page: Page, id: string) => page.locator(`article.stone[aria-label^="Order ${id}"]`);

/** Press Tab (Option-Tab in WebKit, where plain Tab skips buttons as in Safari) until `el` has focus. */
async function tabTo(page: Page, browserName: string, selector: string) {
  const key = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  const el = page.locator(selector).first();
  for (let i = 0; i < 120; i++) {
    if (await el.evaluate((n) => n === document.activeElement).catch(() => false)) break;
    await page.keyboard.press(key);
  }
  await expect(el).toBeFocused();
}

test('P12-01, P12-02: real dnr board in a pty: approve → block → allow once → allowed → TTL expires in a new session → blocked', {
  tag: ['@board-pty', '@board-flow', '@P12-01', '@P12-02'],
}, async ({ page }) => {
  test.setTimeout(180_000);
  const { repo, port, screen } = await launchInPty(page);
  const id = repo.order.id;
  await expect(page.getByRole('heading', { name: 'The graveyard' })).toBeVisible();
  await expect(page.locator('.mode-pill')).toHaveText('Local board');
  expect([`127.0.0.1:${port}`]).toContain(`127.0.0.1:${new URL(page.url()).port}`);
  // AUTH-08: the launch nonce never reaches the terminal.
  expect(screen()).not.toMatch(/[?&]n=/);

  // Draft: not enforced, so the agent's re-application is allowed.
  expect((await agentWrite(repo, 'sess-draft')).code).toBe(0);

  // Approve on the board (the maintainer).
  const plot = page.locator('li.plot', { has: stone(page, id) });
  await plot.locator('[data-action="approve"]').click();
  await expect(stone(page, id)).toHaveAttribute('data-state', 'approved');

  // Block: the same write in a new agent session now exits 2 and names the recovery command.
  const blocked = await agentWrite(repo, 'sess-1');
  expect(blocked.code).toBe(2);
  expect(blocked.stderr).toContain(id);
  expect(blocked.stderr).toContain(`dnr board --open ${id}`);

  // Allow once on the order page (TTL 1 h by default).
  await page.goto(`${new URL(page.url()).origin}/orders/${id}`);
  await page.locator('[data-action="allow-once"]').first().click();
  await expect(page.getByTestId('grants')).toContainText('allow_once');
  await expect(page.getByTestId('grants')).toContainText('pending (next session)');

  // Allowed: the next agent session claims the grant.
  const allowed = await agentWrite(repo, 'sess-2');
  expect(allowed.code, allowed.stderr).toBe(0);
  await page.reload();
  await expect(page.getByTestId('grants')).not.toContainText('pending (next session)');
  await expect(page.locator('table').last()).toContainText('allow_grant');

  // The TTL passes (DNR_NOW two hours on) and a new session tries again: blocked.
  const later = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const expired = await agentWrite(repo, 'sess-3', { DNR_NOW: later });
  expect(expired.code).toBe(2);
  await page.reload();
  const outcomes = page.locator('table').last();
  for (const o of ['allow', 'block', 'allow_grant']) await expect(outcomes).toContainText(o);
});

test('P12-03: keyboard only on the real dnr board: approve and allow once; axe 0 on each page', {
  tag: ['@board-pty', '@a11y-board', '@P12-03'],
}, async ({ page, browserName }) => {
  test.setTimeout(180_000);
  const { repo } = await launchInPty(page);
  const id = repo.order.id;
  await expect(page.getByRole('heading', { name: 'The graveyard' })).toBeVisible();
  await expectNoAxeViolations(page);
  await tabTo(page, browserName, '[data-action="approve"]');
  await page.keyboard.press('Enter');
  await expect(stone(page, id)).toHaveAttribute('data-state', 'approved');
  // axe on a fresh load of the same state: Playwright's Firefox crashes when axe runs right after
  // in-place re-renders (see N5 in board.spec.ts).
  await page.reload();
  await expect(stone(page, id)).toHaveAttribute('data-state', 'approved');
  await expectNoAxeViolations(page);
  // Follow the headstone's own link to the order page by keyboard.
  await tabTo(page, browserName, `a[href$="/orders/${id}"]`);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: `Order ${id}` })).toBeVisible();
  await expectNoAxeViolations(page);
  // Fresh load before the next re-render, for the same Firefox crash.
  await page.reload();
  await expect(page.getByRole('heading', { name: `Order ${id}` })).toBeVisible();
  await tabTo(page, browserName, '[data-action="allow-once"]');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('grants')).toContainText('allow_once');
  await page.reload();
  await expect(page.getByTestId('grants')).toContainText('allow_once');
  await expectNoAxeViolations(page);
});

test('P12-02: the real R6 guard refuses dnr board without a TTY (piped, as an agent would run it)', {
  tag: ['@board-pty', '@P12-02'],
}, async () => {
  const repo = await RealRepo.create();
  try {
    const r = await new Promise<{ code: number; stderr: string }>((res) => {
      const p = spawn(process.execPath, [CLI, 'board', '--port', '0'], {
        cwd: repo.dir,
        env: repo.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      p.stderr.on('data', (d) => {
        stderr += String(d);
      });
      p.on('close', (code) => res({ code: code ?? -1, stderr }));
      p.stdin.end();
    });
    expect(r.code).toBe(64);
    expect(r.stderr).toContain('Only a human maintainer');
    expect(existsSync(join(repo.dir, '.dnr', 'board.json'))).toBe(false);
  } finally {
    repo.dispose();
  }
});

test('board error banners: a real error_open and a real tamper finding from the built hook', {
  tag: ['@board-pty', '@STATE-08', '@board-banners'],
}, async ({ page }) => {
  test.setTimeout(180_000);
  const { repo } = await launchInPty(page, [], async (r) => {
    await r.approve();
    r.commitOrders('Approve the order');
  });
  await expect(page.getByRole('heading', { name: 'The graveyard' })).toBeVisible();
  await expect(page.getByTestId('banner-tamper')).toHaveCount(0);
  await expect(page.getByTestId('banner-error-open')).toHaveCount(0);

  // error_open: the hook gets stdin it cannot parse, fails open (exit 0) and records it.
  const bad = await hook(repo, ['check', '--stdin', '--hook', 'kiro'], '{not json');
  expect(bad.code).toBe(0);

  // Tamper: in an agent session, a shell command moves HEAD back past the order's commit.
  const ev = (hook_event_name: string, extra: object = {}) =>
    JSON.stringify({ hook_event_name, cwd: repo.dir, session_id: 'sess-t', ...extra });
  const cmd = 'git reset -q --hard HEAD~1';
  const shell = { tool_name: 'execute_bash', tool_input: { command: cmd } };
  expect((await hook(repo, ['session', 'start', '--stdin'], ev('SessionStart'))).code).toBe(0);
  expect((await hook(repo, ['guard-shell', '--stdin'], ev('PreToolUse', shell))).code).toBe(0);
  repo.git('reset', '-q', '--hard', 'HEAD~1');
  const post = await hook(repo, ['session', 'shell-after', '--stdin'], ev('PostToolUse', shell));
  expect(post.code, post.stderr).toBe(2);
  expect(post.stderr).toContain('HEAD moving from');

  await page.reload();
  const tamper = page.getByTestId('banner-tamper');
  await expect(tamper).toContainText('Tamper detected');
  await expect(tamper).toContainText('HEAD moving from');
  await expect(tamper).toContainText('dnr tamper show');
  const open = page.getByTestId('banner-error-open');
  await expect(open).toContainText('The hook failed open once');
  await expect(open).toContainText('pre-write');
  await expectNoAxeViolations(page);
});
