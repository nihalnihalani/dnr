/**
 * Dev board: `pnpm exec tsx apps/board/src/dev.ts`. Seeds a MemoryStore from the Playground's
 * CaseBundle files. Never prints the launch URL; set DNR_BOARD_LAUNCH_FILE to receive it (0600).
 */
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaseBundle } from '@dnr/schemas';
import type { OrderRow } from '@dnr/ui/model';
import { MemoryStore, startBoard } from './index';

const casesDir = fileURLToPath(new URL('../../playground/public/cases', import.meta.url));

async function loadRows(): Promise<OrderRow[]> {
  const names = await readdir(casesDir).catch(() => [] as string[]);
  const rows = new Map<string, OrderRow>();
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const parsed = CaseBundle.safeParse(JSON.parse(await readFile(join(casesDir, name), 'utf8')));
    if (!parsed.success) continue;
    const order = parsed.data.order;
    rows.set(order.id, { order, effective: order.status, drift: false });
  }
  return [...rows.values()];
}

const port = process.env.DNR_BOARD_PORT ? Number(process.env.DNR_BOARD_PORT) : 0;
const board = await startBoard({
  store: new MemoryStore({ rows: await loadRows() }),
  version: '0.0.0-dev',
  port,
  host: process.env.DNR_BOARD_HOST === '127.0.0.1' ? '127.0.0.1' : 'auto',
});
const launchFile = process.env.DNR_BOARD_LAUNCH_FILE;
if (launchFile) {
  await writeFile(launchFile, JSON.stringify({ port: board.port, launchUrl: board.launchUrl }), {
    mode: 0o600,
  });
  await chmod(launchFile, 0o600);
}
process.stdout.write(`board listening on port ${board.port}\n`);

const stop = () => {
  void board.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
