/**
 * Wave-2 review H3: the devil's advocate's guard-shell bypasses. guard-shell keeps the cheap
 * rules; anything it misses must be caught right after the call by post-shell (worktree scoring
 * and the post-commit crossing check). Each row names the layer that catches it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSessionStart, runShellAfter } from '../src/session-hooks';
import { runGuardShell } from '../src/shell';
import { runStop } from '../src/stop';
import { envFor, type Fixture, revertFixture } from './helpers';

let fx: Fixture | null = null;
afterEach(() => {
  fx?.repo.cleanup();
  fx = null;
});

type Layer = 'guard-shell' | 'post-shell';

// <O> = the original commit C, <O7> its 7-char prefix. F = shop.py, the covered file.
const ROWS: Array<[cmd: string, layer: Layer]> = [
  ['git -c alias.pp=cherry-pick pp <O>', 'guard-shell'],
  ['X=<O>; git cherry-pick $X', 'guard-shell'],
  ['g=git; $g cherry-pick <O>', 'guard-shell'],
  ['git cherry-pick $(git rev-parse <O7>)', 'guard-shell'],
  ['git cherry-pick `git rev-parse --verify <O7>`', 'guard-shell'],
  ["git cherry-pick ':/^Fixed'", 'guard-shell'],
  ["git cherry-pick ':/^Fixed #1'", 'guard-shell'],
  ['git show <O>:shop.py | tee shop.py', 'guard-shell'],
  ['git cat-file -p <O>:shop.py > shop.py', 'guard-shell'],
  ['git restore -s<O> shop.py', 'guard-shell'],
  ['git checkout <O> shop.py', 'guard-shell'],
  ['git archive <O> shop.py | tar -x', 'guard-shell'],
  ['eval "git cherry-pick <O>"', 'guard-shell'],
  ['echo "git cherry-pick <O>" | sh', 'guard-shell'],
  ["python3 -c \"import subprocess; subprocess.run(['git','cherry-pick','<O>'], check=True)\"", 'post-shell'],
  [
    "python3 -c \"import subprocess; open('shop.py','w').write(subprocess.check_output(['git','show','<O>:shop.py']).decode())\"",
    'post-shell',
  ],
  ['open evil.command', 'guard-shell'],
  ['rm -rf .kiro', 'guard-shell'],
  ['find .kiro -delete', 'guard-shell'],
  ['mv .dnr dnr-old', 'guard-shell'],
  ['GIT_CONFIG_PARAMETERS="\'core.hooksPath=/dev/null\'" git commit -m x', 'guard-shell'],
  [
    'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
    'guard-shell',
  ],
  ['export GIT_CONFIG_PARAMETERS="\'alias.x=!sh\'"', 'guard-shell'],
];

function gitEnv(fx: Fixture): NodeJS.ProcessEnv {
  return {
    ...envFor(fx.repo),
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@invalid',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@invalid',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

const ev = (fx: Fixture, command: string, hook = 'PreToolUse') =>
  JSON.stringify({
    hook_event_name: hook,
    cwd: fx.repo.dir,
    session_id: 'bypass',
    tool_name: 'execute_bash',
    tool_input: { command },
  });

describe('guard-shell bypasses (wave-2 H3)', () => {
  for (const [template, layer] of ROWS) {
    it(`H3: \`${template}\` is caught by ${layer}`, async () => {
      fx = await revertFixture();
      mkdirSync(join(fx.repo.dir, '.kiro', 'hooks'), { recursive: true });
      const env = envFor(fx.repo);
      const cmd = template.replaceAll('<O7>', fx.C.slice(0, 7)).replaceAll('<O>', fx.C);
      await runSessionStart(
        JSON.stringify({ hook_event_name: 'SessionStart', cwd: fx.repo.dir, session_id: 'bypass' }),
        { env },
      );
      const pre = await runGuardShell(ev(fx, cmd), { env });
      if (layer === 'guard-shell') {
        expect(pre.exitCode, pre.stderr).toBe(2);
        expect(pre.stderr).toMatch(/^DNR guard-shell \(R\d\)/);
        return;
      }
      expect(pre.exitCode, 'guard-shell lets it through; post-shell must catch it').toBe(0);
      try {
        execFileSync('sh', ['-c', cmd], { cwd: fx.repo.dir, env: gitEnv(fx), stdio: 'pipe' });
      } catch {}
      const post = await runShellAfter(ev(fx, cmd, 'PostToolUse'), { env });
      expect(post.exitCode).toBe(2);
      expect(post.stderr).toMatch(new RegExp(`re-applies ${fx.order.id}`));
      expect(post.stderr).toMatch(/Undo|undo/);
    });
  }

  it('H3: a cherry-pick commit (no pre-commit hook runs) is flagged by the post-commit check, once', async () => {
    fx = await revertFixture();
    const env = envFor(fx.repo);
    const cmd = `python3 -c "import subprocess; subprocess.run(['git','cherry-pick','${fx.C}'], check=True)"`;
    await runGuardShell(ev(fx, cmd), { env });
    execFileSync('sh', ['-c', cmd], { cwd: fx.repo.dir, env: gitEnv(fx), stdio: 'pipe' });
    const a = await runShellAfter(ev(fx, cmd, 'PostToolUse'), { env });
    expect(a.stderr).toContain('the commit you just made');
    await runGuardShell(ev(fx, 'ls'), { env });
    const b = await runShellAfter(ev(fx, 'ls', 'PostToolUse'), { env });
    expect(b.exitCode).toBe(0); // reported once
  });

  it('H2: deleting a DNR hook file through an interpreter is caught by the Stop tamper check', async () => {
    fx = await revertFixture();
    fx.repo.write('.kiro/hooks/dnr-pre-write.json', '{"version":"v1","hooks":[]}\n');
    const env = envFor(fx.repo);
    await runSessionStart(
      JSON.stringify({ hook_event_name: 'SessionStart', cwd: fx.repo.dir, session_id: 'bypass' }),
      { env },
    );
    const cmd = 'python3 -c "import os; os.remove(\'.kiro/hooks/dnr-pre-write.json\')"';
    expect((await runGuardShell(ev(fx, cmd), { env })).exitCode).toBe(0);
    execFileSync('sh', ['-c', cmd], { cwd: fx.repo.dir, env: gitEnv(fx) });
    await runShellAfter(ev(fx, cmd, 'PostToolUse'), { env });
    const st = await runStop(
      JSON.stringify({ hook_event_name: 'Stop', cwd: fx.repo.dir, session_id: 'bypass' }),
      { env },
    );
    expect(JSON.parse(st.stdout).reason).toContain(
      'changed during this session outside a guarded `dnr` command',
    );
  });

  it('H3: known limits stay documented, not silently passing: an interpreter that only talks to the board or osascript is not a write', () => {
    // These cannot be caught by parsing or by scoring the worktree (no write happens). They are
    // listed in docs/threat-model.md; the board's cookie + nonce and the suspect-grant flag
    // (C3) are the mitigations. This test pins the list so a change is deliberate.
    const knownLimits = [
      'python3 -c "urlopen(\'http://127.0.0.1:%d/\' % (4300+17))"',
      'python3 -c "import os; os.system(\'osascript …\')"',
      'cp $(which dnr) /tmp/d; /tmp/d allow <id>',
    ];
    expect(knownLimits).toHaveLength(3);
    writeFileSync('/dev/null', '');
  });
});
