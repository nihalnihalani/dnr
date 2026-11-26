/** One handle over every store of a repo: paths, config, orders, sessions, grants, events. */
import { join } from 'node:path';
import type { EventRecord } from '@dnr/schemas';
import { writeAttested } from './attested';
import { nowIso } from './clock';
import { type LoadedConfig, loadConfig } from './config';
import { appendEvent, readEvents } from './events';
import { GrantStore } from './grants';
import { hookLog } from './log';
import { computeOrdersHash, OrderStore } from './orders';
import { type DnrPaths, resolvePaths } from './paths';
import { SessionStore } from './sessions';

export interface Store {
  paths: DnrPaths;
  orders: OrderStore;
  sessions: SessionStore;
  grants: GrantStore;
  loadConfig(): Promise<LoadedConfig>;
  ordersHash(): string;
  appendEvent(record: EventRecord, opts?: { record?: boolean }): Promise<void>;
  readEvents(filter?: { order?: string; hook?: EventRecord['hook'] }): Promise<EventRecord[]>;
  log(line: string): void;
}

export function openStore(
  repoRoot: string,
  opts: { env?: NodeJS.ProcessEnv; ordersDir?: string; stateDir?: string; configFile?: string } = {},
): Store {
  const env = opts.env ?? process.env;
  const paths = resolvePaths(repoRoot, env, opts);
  const sessions = new SessionStore(paths.sessionsDir);
  const ordersHash = () =>
    computeOrdersHash({
      ordersDir: paths.ordersDir,
      configFile: paths.configFile,
      hooksDir: join(repoRoot, '.kiro', 'hooks'),
    });
  const orders: OrderStore = new OrderStore(paths.ordersDir, null, async () => {
    // Every mutation through the store is a human decision (guarded CLI, board): attest it.
    writeAttested(paths.attestedFile, await orders.list(), env.USER ?? 'human', nowIso(env));
    await sessions.refreshOrdersHash(ordersHash());
  });
  return {
    paths,
    orders,
    sessions,
    grants: new GrantStore(paths.grantsDir),
    loadConfig: () => loadConfig(paths, env),
    ordersHash,
    appendEvent: (record, o = {}) => appendEvent(o.record ? paths.recordFile : paths.eventsFile, record),
    readEvents: (filter = {}) => readEvents(paths.eventsFile, filter),
    log: (line) => hookLog(paths.hookLog, line),
  };
}
