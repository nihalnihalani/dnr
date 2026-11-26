import { git } from './exec';

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second `@@` (git's function-context heuristic), trimmed. */
  context: string;
  removed: string[];
  added: string[];
}

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  status: 'modified' | 'added' | 'deleted';
  binary: boolean;
  hunks: Hunk[];
}

function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    return p
      .slice(1, -1)
      .replace(/\\(["\\])/g, '$1')
      .replace(/\\t/g, '\t')
      .replace(/\\n/g, '\n');
  }
  return p;
}

function stripPrefix(p: string): string | null {
  const u = unquote(p.trim());
  if (u === '/dev/null') return null;
  return u.replace(/^[ab]\//, '');
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Parses unified diff text (any context size; built for `-U0`). */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let hunk: Hunk | null = null;
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (?:"?a\/)(.*?)"? (?:"?b\/)(.*?)"?$/.exec(line);
      cur = {
        oldPath: m?.[1] ?? null,
        newPath: m?.[2] ?? null,
        status: 'modified',
        binary: false,
        hunks: [],
      };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (hunk) {
      const c = line[0];
      if (c === '-') {
        hunk.removed.push(line.slice(1));
        continue;
      }
      if (c === '+') {
        hunk.added.push(line.slice(1));
        continue;
      }
      if (c === ' ') continue;
      if (c === '\\') continue; // "\ No newline at end of file"
    }
    const hm = HUNK.exec(line);
    if (hm) {
      hunk = {
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        context: (hm[5] ?? '').trim(),
        removed: [],
        added: [],
      };
      cur.hunks.push(hunk);
      continue;
    }
    hunk = null;
    if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('--- ')) cur.oldPath = stripPrefix(line.slice(4));
    else if (line.startsWith('+++ ')) cur.newPath = stripPrefix(line.slice(4));
    else if (line.startsWith('Binary files ')) cur.binary = true;
  }
  for (const f of files) {
    if (f.status === 'added') f.oldPath = null;
    if (f.status === 'deleted') f.newPath = null;
  }
  return files;
}

/** `git diff -U0 a b [-- paths]`, parsed. Rename detection is off so paths stay stable. */
export async function diffU0(repo: string, a: string, b: string, paths?: string[]): Promise<FileDiff[]> {
  const args = ['diff', '-U0', '--no-renames', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', a, b];
  if (paths && paths.length > 0) args.push('--', ...paths);
  return parseUnifiedDiff(await git(args, { cwd: repo }));
}

/** The -U0 diff a commit introduces relative to its first parent (root commits diff against the empty tree). */
export async function commitDiffU0(repo: string, sha: string, paths?: string[]): Promise<FileDiff[]> {
  const args = [
    'diff-tree',
    '-p',
    '-U0',
    '--root',
    '--no-commit-id',
    '--no-renames',
    '--no-ext-diff',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    sha,
  ];
  if (paths && paths.length > 0) args.push('--', ...paths);
  return parseUnifiedDiff(await git(args, { cwd: repo }));
}

export function filePath(f: FileDiff): string {
  return (f.newPath ?? f.oldPath) as string;
}
