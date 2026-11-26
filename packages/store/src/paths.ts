/**
 * Where DNR keeps things (§7 "State location", §8 env vars).
 *
 * - `DNR_STATE_DIR` (default `<repo>/.dnr`): sessions, grants, cache, hook.log, events.jsonl.
 * - `DNR_ORDERS` (default `<repo>/.dnr/orders`): committed order files.
 * - `DNR_CONFIG` (default `<repo>/.dnr/config.json`): the config file.
 * - `DNR_RECORD_PATH`: where record mode writes events (default `<state>/events.jsonl`).
 */
import { isAbsolute, join, resolve } from 'node:path';

export interface DnrPaths {
  repoRoot: string;
  stateDir: string;
  ordersDir: string;
  /** The config file DNR reads (`DNR_CONFIG`, else `<repo>/.dnr/config.json`). It may not exist. */
  configFile: string;
  /** True when `DNR_CONFIG` set the path. */
  configFromEnv: boolean;
  eventsFile: string;
  recordFile: string;
  hookLog: string;
  sessionsDir: string;
  grantsDir: string;
  cacheDir: string;
  draftsDir: string;
  boardFile: string;
  candidatesFile: string;
}

function abs(p: string, base: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

export function resolvePaths(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  overrides: { ordersDir?: string; stateDir?: string; configFile?: string } = {},
): DnrPaths {
  const stateDir = abs(overrides.stateDir ?? env.DNR_STATE_DIR ?? join(repoRoot, '.dnr'), repoRoot);
  const ordersDir = abs(overrides.ordersDir ?? env.DNR_ORDERS ?? join(repoRoot, '.dnr', 'orders'), repoRoot);
  const cfgEnv = overrides.configFile ?? env.DNR_CONFIG;
  const configFile = abs(cfgEnv ?? join(repoRoot, '.dnr', 'config.json'), repoRoot);
  const eventsFile = join(stateDir, 'events.jsonl');
  return {
    repoRoot,
    stateDir,
    ordersDir,
    configFile,
    configFromEnv: !!cfgEnv,
    eventsFile,
    recordFile: env.DNR_RECORD_PATH ? abs(env.DNR_RECORD_PATH, repoRoot) : eventsFile,
    hookLog: join(stateDir, 'hook.log'),
    sessionsDir: join(stateDir, 'sessions'),
    grantsDir: join(stateDir, 'grants'),
    cacheDir: join(stateDir, 'cache'),
    draftsDir: join(stateDir, 'drafts'),
    boardFile: join(stateDir, 'board.json'),
    candidatesFile: join(stateDir, 'candidates.json'),
  };
}
