/** CI flake (Node 26): git exiting before it reads stdin raised an unhandled `write EPIPE`. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catBlobs, runGit } from '@dnr/git';
import { describe, expect, it } from 'vitest';

describe('child stdin EPIPE', () => {
  it('EPIPE: catBlobs and runGit report a git that exits before reading stdin as a rejection, never an unhandled error', async () => {
    const gone = mkdtempSync(join(tmpdir(), 'dnr-epipe-'));
    rmSync(gone, { recursive: true, force: true }); // git -C <missing dir> exits at once
    const specs = Array.from({ length: 20_000 }, (_, i) => `HEAD:file-${i}-${'x'.repeat(40)}`);
    await expect(catBlobs(gone, specs)).rejects.toBeDefined();
    await expect(
      runGit(['hash-object', '--stdin'], { cwd: gone, input: 'y'.repeat(2_000_000) }),
    ).rejects.toBeDefined();
  });
});
