/**
 * Records the home page's terminal: a real run of the built `dnr` CLI on a Django checkout at the
 * demo revert, with a human-approved order. Writes public/data/cli-capture.json.
 *
 *   pnpm -F @dnr/playground capture [-- --order <approved order json>]
 *
 * It refuses to run, and leaves no capture, unless the order file is approved by a human (a
 * history entry `approved` whose `by` is not `dnr`). The approval is never made here: it comes
 * from `dnr orders approve` run by a maintainer (Phase 8: fixtures/demo-orders/).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Order } from '@dnr/schemas';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const CLI = join(root, 'packages/cli/dist/cli.js');
const OUT = resolve(here, '../public/data/cli-capture.json');
const REVERT = '43933a1dca';
const EVENT = join(root, `fixtures/hook-events/reapply-${REVERT}.json`);

function fail(msg: string): never {
  console.error(`capture-cli: ${msg}`);
  process.exit(1);
}

const arg = process.argv.indexOf('--order');
const orderPath = resolve(
  arg > 0 ? (process.argv[arg + 1] as string) : join(root, `fixtures/demo-orders/dnr-${REVERT}.json`),
);
if (!existsSync(orderPath))
  fail(`no approved demo order at ${orderPath} (a maintainer approves it in Phase 8)`);
const order = Order.parse(JSON.parse(readFileSync(orderPath, 'utf8')));
const approval = order.history.find((h) => h.action === 'approved' && h.by !== 'dnr');
if (order.status !== 'approved' || !approval) fail(`${order.id} is ${order.status}, not approved by a human`);
if (!existsSync(CLI)) fail(`the built CLI is missing (${CLI}): run pnpm -F dnr-guard build`);
const django = process.env.DJANGO_SRC ?? resolve(root, '../dnr-work/django');
if (!existsSync(join(django, '.git'))) fail(`Django clone not found at ${django} (set DJANGO_SRC)`);

const dir = mkdtempSync(join(tmpdir(), 'dnr-capture-'));
const checkout = join(dir, 'django');
execFileSync('git', ['-C', django, 'worktree', 'add', '--detach', checkout, REVERT], { stdio: 'ignore' });
try {
  mkdirSync(join(checkout, '.dnr/orders'), { recursive: true });
  copyFileSync(orderPath, join(checkout, `.dnr/orders/${order.id}.json`));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('DNR_')) delete env[k];
  const stdin = readFileSync(EVENT, 'utf8');
  const command = `dnr check --stdin --hook kiro < fixtures/hook-events/reapply-${REVERT}.json`;
  const r = spawnSync('node', [CLI, 'check', '--stdin', '--hook', 'kiro'], {
    cwd: checkout,
    input: stdin,
    env,
    encoding: 'utf8',
  });
  if (r.status === null) fail(`the CLI did not exit (${r.signal})`);
  const version = execFileSync('node', [CLI, '--version'], { encoding: 'utf8' }).trim();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        command,
        checkout: `a Django checkout at ${REVERT} with ${order.id} approved by ${approval.by}`,
        exit_code: r.status,
        stderr: r.stderr,
        stdout: r.stdout,
        captured_at: new Date().toISOString(),
        dnr_version: version,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`capture-cli: exit ${r.status}, ${r.stderr.length} chars of stderr → ${OUT}`);
} finally {
  execFileSync('git', ['-C', django, 'worktree', 'remove', '--force', checkout], { stdio: 'ignore' });
  rmSync(dir, { recursive: true, force: true });
}
