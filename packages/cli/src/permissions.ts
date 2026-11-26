/**
 * Kiro's own capability permissions (verified by the lead on kiro.dev/docs/permissions, wave-3 N2):
 * `~/.kiro/settings/permissions.yaml` holds `rules: [{capability, match, effect}]`. Deny overrides
 * everything, `--trust-all-tools` cannot override it, and the agent is hard-denied writes to
 * `~/.kiro/settings/`, so a broken or bypassed DNR cannot switch these rules off.
 *
 * `dnr init` merges DNR's rules into that user-level file inside a marked block, never touching
 * anything outside the block. Open questions for spike S17: whether `match` globs resolve relative
 * to the workspace (so both `x/**` and `**\/x/**` forms are written), the capability name and
 * matching for shell commands, and the workspace-roots `<hash>` algorithm (not written).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BEGIN = '# dnr-guard: begin (managed by `dnr init`; edit outside this block)';
export const END = '# dnr-guard: end';

export function permissionsFile(env: NodeJS.ProcessEnv): string {
  return join(env.HOME ?? homedir(), '.kiro', 'settings', 'permissions.yaml');
}

const q = (s: string) => JSON.stringify(s);

/** DNR's rules as YAML list items (two-space indent under `rules:`). */
export function dnrRules(installPaths: readonly string[]): string {
  const rel = ['.dnr/**', '.git/**', '.kiro/hooks/**', '.kiro/agents/**', '.kiro/steering/dnr.md'];
  const write = [...rel.flatMap((p) => [p, `**/${p}`]), ...installPaths];
  const shell = ['git commit --no-verify*', 'git commit -n*', 'git -c *', 'git config core.hooksPath*'];
  return [
    BEGIN,
    '  - capability: fs_write',
    `    match: [${write.map(q).join(', ')}]`,
    '    effect: deny',
    '  # S17: the shell capability name and command matching are unverified.',
    '  - capability: execute_bash',
    `    match: [${shell.map(q).join(', ')}]`,
    '    effect: deny',
    END,
  ].join('\n');
}

/** Merge DNR's block into an existing permissions.yaml text (or create one). */
export function mergePermissions(current: string | null, block: string): string {
  if (current === null || current.trim() === '') return `rules:\n${block}\n`;
  const b = current.indexOf(BEGIN);
  const e = current.indexOf(END);
  if (b >= 0 && e > b) return `${current.slice(0, b)}${block}${current.slice(e + END.length)}`;
  const lines = current.split('\n');
  const i = lines.findIndex((l) => /^rules:\s*(\[\])?\s*$/.test(l));
  if (i >= 0) {
    lines[i] = 'rules:'; // an empty inline list becomes a block list
    lines.splice(i + 1, 0, block);
    return lines.join('\n');
  }
  return `${current.replace(/\n*$/, '\n')}rules:\n${block}\n`;
}

/** True when the file holds DNR's block with the given rules. */
export function hasDnrRules(text: string | null, block: string): boolean {
  return !!text && text.includes(block);
}
