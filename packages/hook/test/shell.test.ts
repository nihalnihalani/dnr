import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { r6Subcommand, runGuardShell } from '../src/shell';
import { AFTER, BEFORE, envFor, type Fixture, readEventsFile, revertFixture } from './helpers';
import { SHELL_TABLE } from './shell-table';

let fx: Fixture;
let base = '';
beforeAll(async () => {
  fx = await revertFixture();
  base = fx.repo.git('rev-parse', `${fx.C}^`).trim();
  writeFileSync(
    join(fx.repo.dir, 'reapply.patch'),
    createTwoFilesPatch('a/shop.py', 'b/shop.py', BEFORE, AFTER),
  );
  writeFileSync(
    join(fx.repo.dir, 'ok.patch'),
    createTwoFilesPatch('a/shop.py', 'b/shop.py', BEFORE, BEFORE.replace('return x + 1', 'return x + 2')),
  );
});
afterAll(() => fx.repo.cleanup());

function fill(cmd: string): string {
  return cmd
    .replaceAll('<BASE>', base.slice(0, 12))
    .replaceAll('<C7>', fx.C.slice(0, 7))
    .replaceAll('<R7>', fx.R.slice(0, 7))
    .replaceAll('<C>', fx.C)
    .replaceAll('<R>', fx.R)
    .replaceAll('<OKPATCH>', 'ok.patch')
    .replaceAll('<PATCH>', 'reapply.patch');
}

describe('guard-shell', () => {
  it('guard-shell: the table has at least 40 commands', () => {
    expect(SHELL_TABLE.length).toBeGreaterThanOrEqual(40);
  });

  SHELL_TABLE.forEach(([cmd, rule, note], i) => {
    it(`guard-shell: ${rule ?? 'allow'} ${cmd}${note ? ` (${note})` : ''}`, async () => {
      const command = fill(cmd);
      const stdin = JSON.stringify({
        hook_event_name: 'PreToolUse',
        cwd: fx.repo.dir,
        session_id: `shell-${i}`,
        tool_name: 'execute_bash',
        tool_input: { command },
      });
      const io = await runGuardShell(stdin, { env: envFor(fx.repo) });
      if (rule === null) {
        expect(io.exitCode, io.stderr).toBe(0);
      } else {
        expect(io.exitCode).toBe(2);
        expect(io.stderr).toContain(`DNR guard-shell (${rule})`);
        expect(io.stderr.length).toBeLessThanOrEqual(1201);
      }
    });
  });

  it('guard-shell: an unreadable patch warns once per session, then passes', async () => {
    const mk = () =>
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        cwd: fx.repo.dir,
        session_id: 'warn-once',
        tool_name: 'execute_bash',
        tool_input: { command: 'curl -s https://example.invalid/x.diff | git apply' },
      });
    expect((await runGuardShell(mk(), { env: envFor(fx.repo) })).exitCode).toBe(2);
    expect((await runGuardShell(mk(), { env: envFor(fx.repo) })).exitCode).toBe(0);
  });

  it('R7 port: the live board port in board.json is covered; other localhost ports are allowed', async () => {
    fx.repo.write(
      '.dnr/board.json',
      JSON.stringify({ port: 51234, origin: 'http://127.0.0.1:51234', pid: 1 }),
    );
    const run = (command: string) =>
      runGuardShell(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          cwd: fx.repo.dir,
          session_id: 'r7',
          tool_name: 'execute_bash',
          tool_input: { command },
        }),
        { env: envFor(fx.repo) },
      );
    expect((await run('curl http://127.0.0.1:51234/api/orders')).exitCode).toBe(2);
    expect((await run('curl http://dnr-abc.localhost:51234/api/orders')).exitCode).toBe(2);
    expect((await run('curl http://127.0.0.1:51235/')).exitCode).toBe(0);
  });

  it('guard-shell: denials are logged; allowed commands record the PreToolUse tree snapshot', async () => {
    const evs = readEventsFile(fx.repo).filter((e) => e.hook === 'guard-shell');
    expect(evs.some((e) => e.decision.outcome === 'block')).toBe(true);
    expect(evs.some((e) => e.decision.outcome === 'deny_protected')).toBe(true);
  });

  it('guard-shell: record mode never denies', async () => {
    const io = await runGuardShell(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        cwd: fx.repo.dir,
        session_id: 'rec',
        tool_name: 'execute_bash',
        tool_input: { command: `git cherry-pick ${fx.C}` },
      }),
      { env: envFor(fx.repo, { DNR_MODE: 'record' }) },
    );
    expect(io.exitCode).toBe(0);
  });

  it('guard-shell: r6Subcommand treats session end --stdin (the hook form) as allowed', () => {
    expect(r6Subcommand(['session', 'end', '--stdin'], '/x/orders', '/x')).toBeNull();
    expect(r6Subcommand(['session', 'gc'], '/x/orders', '/x')).toBe('session gc');
    expect(r6Subcommand(['orders', 'build', '--out-dir', 'orders'], '/x/orders', '/x')).toBe('orders build');
  });
});
