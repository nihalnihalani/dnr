/** The DNR hook files (§6), exactly as `.kiro/hooks/` in this repo. */
export interface HookFile {
  name: string;
  trigger: 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionStart';
  matcher?: 'write' | 'shell';
  command: string;
  timeout: number;
}

export const DNR_HOOKS: HookFile[] = [
  {
    name: 'dnr-pre-write',
    trigger: 'PreToolUse',
    matcher: 'write',
    command: 'dnr check --stdin --hook kiro',
    timeout: 10,
  },
  {
    name: 'dnr-post-write',
    trigger: 'PostToolUse',
    matcher: 'write',
    command: 'dnr session confirm --stdin',
    timeout: 10,
  },
  {
    name: 'dnr-guard-shell',
    trigger: 'PreToolUse',
    matcher: 'shell',
    command: 'dnr guard-shell --stdin',
    timeout: 10,
  },
  {
    name: 'dnr-post-shell',
    trigger: 'PostToolUse',
    matcher: 'shell',
    command: 'dnr session shell-after --stdin',
    timeout: 10,
  },
  {
    name: 'dnr-stop-backstop',
    trigger: 'Stop',
    command: 'dnr check --worktree --hook stop --max-forced-turns 2',
    timeout: 30,
  },
  { name: 'dnr-session-start', trigger: 'SessionStart', command: 'dnr session start --stdin', timeout: 10 },
];

/** The JSON object for one hook file. `dnrPath` replaces the leading `dnr` (spike S8 absolute paths). */
export function hookJson(h: HookFile, dnrPath = 'dnr'): unknown {
  const command = dnrPath === 'dnr' ? h.command : `${dnrPath}${h.command.slice(3)}`;
  return {
    version: 'v1',
    hooks: [
      {
        name: h.name,
        trigger: h.trigger,
        ...(h.matcher ? { matcher: h.matcher } : {}),
        action: { type: 'command', command },
        timeout: h.timeout,
        enabled: true,
      },
    ],
  };
}

export function hookText(h: HookFile, dnrPath?: string): string {
  return `${JSON.stringify(hookJson(h, dnrPath), null, 2)}\n`;
}

/** The pre-commit shim, calling DNR by the given command (absolute node + cli.js, wave-3 N2). */
export function preCommitShim(dnrPath = 'dnr'): string {
  return `#!/bin/sh\n# Installed by dnr init: block commits that re-apply a reverted change (DNR §6).\nexec ${dnrPath} check --staged\n`;
}

export const PRE_COMMIT_SHIM =
  '#!/bin/sh\n# Installed by dnr init: block commits that re-apply a reverted change (DNR §6).\nexec dnr check --staged\n';

export const GITIGNORE_LINES = [
  '# DNR: only orders and config are committed',
  '.dnr/*',
  '!.dnr/orders/',
  '!.dnr/config.json',
];

export function crewWorkflow(crewRepo: string): string {
  return `# Installed by \`dnr init --crew\` (DNR §12.5): runs the DNR check on every pull request and
# handles \`/dnr allow <order_id>\` override comments. The reusable workflow never executes PR head code.
name: dnr
on:
  pull_request_target:
    types: [opened, synchronize, reopened, edited]
  issue_comment:
    types: [created]
# The dnr-bot App posts every check and comment; the caller's GITHUB_TOKEN only reads.
permissions:
  contents: read
jobs:
  dnr-scan:
    uses: ${crewRepo}/.github/workflows/dnr.yml@v1
    with:
      environment: dnr-grants
    secrets:
      DNR_BOT_APP_ID: \${{ secrets.DNR_BOT_APP_ID }}
      DNR_BOT_APP_KEY: \${{ secrets.DNR_BOT_APP_KEY }}
`;
}
