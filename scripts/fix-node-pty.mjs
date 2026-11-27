// node-pty 1.1.0 ships its macOS `spawn-helper` prebuilds, and pnpm can unpack them without the
// exec bit. The pty board tests (apps/playground/tests/board-pty.spec.ts) then fail with
// "posix_spawnp failed". Restore the bit after install. A no-op where node-pty is absent or not on macOS.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

if (process.platform === 'darwin') {
  let root;
  try {
    root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    process.exit(0);
  }
  const prebuilds = join(root, 'prebuilds');
  if (existsSync(prebuilds))
    for (const dir of readdirSync(prebuilds)) {
      const helper = join(prebuilds, dir, 'spawn-helper');
      if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) {
        chmodSync(helper, 0o755);
        console.log(`fix-node-pty: made ${dir}/spawn-helper executable`);
      }
    }
}
