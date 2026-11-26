/**
 * Config lookup (§7): `DNR_CONFIG` → `<repo>/.dnr/config.json` → defaults. `DNR_MODE` overrides
 * `mode` and `DNR_THRESHOLD` overrides `threshold`.
 */
import { readFile } from 'node:fs/promises';
import { DnrConfig } from '@dnr/schemas';
import type { DnrPaths } from './paths';

export type ConfigSource = 'env' | 'repo' | 'defaults';

export interface LoadedConfig {
  config: DnrConfig;
  source: ConfigSource;
  path: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export async function loadConfig(
  paths: Pick<DnrPaths, 'configFile' | 'configFromEnv'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig> {
  let raw: unknown = {};
  let source: ConfigSource = 'defaults';
  let path: string | null = null;
  try {
    raw = JSON.parse(await readFile(paths.configFile, 'utf8'));
    source = paths.configFromEnv ? 'env' : 'repo';
    path = paths.configFile;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw new ConfigError(`DNR: cannot read config ${paths.configFile}: ${String(e)}`);
    if (paths.configFromEnv)
      throw new ConfigError(`DNR: DNR_CONFIG points at a missing file: ${paths.configFile}`);
  }
  const merged = { ...(raw as Record<string, unknown>) };
  if (env.DNR_MODE) merged.mode = env.DNR_MODE;
  if (env.DNR_THRESHOLD) merged.threshold = Number(env.DNR_THRESHOLD);
  const r = DnrConfig.safeParse(merged);
  if (!r.success)
    throw new ConfigError(
      `DNR: invalid config: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return { config: r.data, source, path };
}
