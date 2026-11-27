/**
 * The CLI unit tests inject the human guard. This test runs the **built** `dnr` binary
 * (packages/cli/dist/cli.js) with no TTY, so the real R6 guard (TTY, Kiro variables, process
 * ancestry) decides: every human-only command must refuse with exit 64 and change nothing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envFor, type Fixture, revertFixture } from '../../hook/test/helpers';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'cli.js');
let fx: Fixture;

beforeAll(async () => {
  // `dnr-guard...` also builds what the package bundles (the board UI from @dnr/playground).
  if (!existsSync(CLI))
    execFileSync('pnpm', ['--filter', 'dnr-guard...', 'build'], { cwd: ROOT, stdio: 'pipe' });
  fx = await revertFixture({ status: 'draft' });
}, 120_000);
afterAll(() => fx?.repo.cleanup());

describe('R6 guard in the built binary', () => {
  for (const argv of [['allow', 'ID'], ['orders', 'approve', 'ID'], ['tamper', 'accept'], ['init']]) {
    it(`R6 guard: built \`dnr ${argv.join(' ')}\` without a TTY refuses with exit 64`, () => {
      const args = argv.map((a) => (a === 'ID' ? fx.order.id : a));
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: fx.repo.dir,
        env: { ...envFor(fx.repo), TERM: 'xterm-256color' },
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      expect(r.status, r.stderr).toBe(64);
      expect(r.stderr).toContain('Only a human maintainer');
      expect(r.stderr).toContain('no TTY');
      expect(existsSync(join(fx.repo.dir, '.dnr', 'grants'))).toBe(false);
      expect(existsSync(join(fx.repo.dir, '.kiro'))).toBe(false);
    });
  }
});
