/**
 * Repository facts the script needs besides numbers.json: the Kiro chain variant (keyed on
 * reports/property-failures.md) and the Kiro surfaces actually present in `.kiro/` and `powers/`.
 * Everything is read from tracked files (`git ls-files`), so an untracked local file never shows up.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScriptContext } from './script';

export const REPO_URL = 'https://github.com/nihalnihalani/dnr';

export function gitLsFiles(root: string, ...paths: string[]): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: root, encoding: 'utf8' });
  return out.split('\0').filter(Boolean).sort();
}

/**
 * §11 2:05: "Property failed" when reports/property-failures.md records an engine failure,
 * "None failed" (the spike fallback) when its "Engine properties" heading says none failed.
 */
export function chainVariant(propertyFailuresMd: string | null): ScriptContext['chain'] {
  if (propertyFailuresMd === null) return 'pending';
  const h = /^##\s+Engine properties\b(.*)$/im.exec(propertyFailuresMd);
  if (!h) return 'pending';
  return /none failed/i.test(h[1] ?? '') ? 'fallback' : 'property';
}

export interface Surface {
  key: string;
  label: string;
  files: string[];
}

/** One entry per §11 write-up item-5 surface that has tracked files. */
export function kiroSurfaces(root: string): Surface[] {
  const tracked = gitLsFiles(root, '.kiro', 'powers', 'trial/agents');
  const under = (p: string) => tracked.filter((f) => f.startsWith(p));
  const hooks = under('.kiro/hooks/');
  const all: Surface[] = [
    { key: 'specs', label: 'Specs', files: under('.kiro/specs/') },
    { key: 'hooks', label: 'Hooks', files: hooks.filter((f) => !/\/dev-[^/]+$/.test(f)) },
    { key: 'steering', label: 'Steering', files: under('.kiro/steering/') },
    { key: 'agents', label: 'Custom agents', files: [...under('.kiro/agents/'), ...under('trial/agents/')] },
    { key: 'mcp', label: 'MCP', files: under('.kiro/settings/mcp.json') },
    { key: 'power', label: 'Power', files: under('powers/') },
    { key: 'dev-hooks', label: 'Dev hooks', files: hooks.filter((f) => /\/dev-[^/]+$/.test(f)) },
  ];
  return all.filter((s) => s.files.length > 0);
}

export function readContext(root: string): ScriptContext {
  const pf = join(root, 'reports/property-failures.md');
  return {
    chain: chainVariant(existsSync(pf) ? readFileSync(pf, 'utf8') : null),
    surfaces: kiroSurfaces(root).map((s) => s.label),
    repo_url: REPO_URL,
  };
}
