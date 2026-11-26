import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkHuman, type Proc } from '../src/ancestry';

const p = (command: string, pid = 10): Proc => ({ pid, ppid: pid - 1, command });
const human = { env: {}, isTTY: true };

describe('R6 guard', () => {
  it('R6 guard: a human login shell passes', () => {
    expect(
      checkHuman({
        ...human,
        chain: [
          p('-zsh'),
          p('/usr/bin/login -pfl me'),
          p('/Applications/Terminal.app/Contents/MacOS/Terminal'),
        ],
      }),
    ).toEqual({ ok: true });
  });

  it('R6 guard: a shell under node-pty (Playwright in CI) passes', () => {
    expect(
      checkHuman({ ...human, chain: [p('/bin/bash'), p('node /repo/node_modules/.bin/playwright test')] }),
    ).toEqual({ ok: true });
  });

  it('R6 guard: no TTY is refused', () => {
    const r = checkHuman({ env: {}, isTTY: false, chain: [p('-zsh')] });
    expect(r.ok).toBe(false);
  });

  it('R6 guard: a Kiro agent-context variable is refused', () => {
    const r = checkHuman({ env: { KIRO_SESSION_ID: 'x' }, isTTY: true, chain: [p('-zsh')] });
    expect(r).toMatchObject({ ok: false });
  });

  it('R6 guard: any kiro-cli ancestor is refused, however deep and however wrapped', () => {
    for (const chain of [
      [p('-zsh'), p('kiro-cli chat --v3')],
      [p('/bin/zsh -i'), p('script -q /dev/null zsh'), p('/usr/local/bin/kiro-cli chat --no-interactive')],
    ]) {
      expect(checkHuman({ ...human, chain }).ok).toBe(false);
    }
  });

  it('R6 guard: wrappers between dnr and the shell are refused (script, sh -c, bash -c, npx, env, node)', () => {
    for (const w of [
      'script -q /dev/null dnr allow x',
      'sh -c dnr allow x',
      'bash -c "dnr allow x"',
      'npx dnr-guard allow x',
      'env -i dnr',
      'node /x/dnr-guard/dist/cli.js',
    ]) {
      const r = checkHuman({ ...human, chain: [p(w), p('-zsh')] });
      expect(r.ok, w).toBe(false);
    }
  });

  it('R6 guard: a process launched by a non-shell is refused', () => {
    expect(checkHuman({ ...human, chain: [p('/usr/bin/python3 run.py'), p('-zsh')] }).ok).toBe(false);
  });

  it('R6 guard: the real check refuses under `sh -c` with no TTY', () => {
    const script = fileURLToPath(new URL('./ancestry-probe.ts', import.meta.url));
    const out = execFileSync('sh', ['-c', `node --import tsx ${script}`], {
      encoding: 'utf8',
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    });
    expect(JSON.parse(out).ok).toBe(false);
  });
});
