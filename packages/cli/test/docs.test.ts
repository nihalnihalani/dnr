/**
 * Production audit P1 and P11: what a stranger runs first. CI also runs the README install block
 * exactly as written (scripts/check-readme-install.sh, job pack-install).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('first-run docs', () => {
  it('P1: the README install block is the verified tarball path, needs no `pnpm setup`, and CI runs it from the README', () => {
    const readme = read('README.md');
    const m = /<!-- readme-install -->\n```bash\n([\s\S]*?)```\n<!-- \/readme-install -->/.exec(readme);
    expect(m, 'README.md has a <!-- readme-install --> block').not.toBeNull();
    const block = (m?.[1] ?? '').trim();
    expect(block).toBe(
      'pnpm install --frozen-lockfile && pnpm build && pnpm -F dnr-guard pack && npm install -g ./dnr-guard-*.tgz',
    );
    expect(readme).not.toMatch(/pnpm (-C \S+ )?link --global/);
    expect(readme).toContain('npm i -g dnr-guard');
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('bash scripts/check-readme-install.sh');
    expect(read('scripts/check-readme-install.sh')).toContain('<!-- readme-install -->');
  });

  it('P11: the devcontainer installs dnr the README way and no longer prints the Phase 2 note', () => {
    const dc = JSON.parse(read('.devcontainer/devcontainer.json')) as { postCreateCommand: string };
    expect(dc.postCreateCommand).not.toMatch(/Phase 2|no bin/);
    expect(dc.postCreateCommand).toContain('pnpm -F dnr-guard pack && npm install -g ./dnr-guard-*.tgz');
    expect(dc.postCreateCommand).toContain('dnr --version');
  });
});
