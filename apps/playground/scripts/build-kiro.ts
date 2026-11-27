/**
 * Builds public/data/kiro.json for /kiro from the files that actually exist in .kiro/ and powers/.
 * "What it changed" comes from the file itself (hook command, steering scope, spec progress) and
 * its git history, never from hand-written claims.
 *
 * The output is generated, not tracked (gitignored): it is a function of the checked-out commit.
 * Only tracked files are listed (`git ls-files`), so local scratch files never appear. History
 * needs the full git log, so CI checks out with fetch-depth 0; a shallow clone fails loudly here
 * instead of publishing truncated history.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const out = resolve(here, '../public/data/kiro.json');

interface Row {
  surface: string;
  file: string;
  what: string;
  history: string[];
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
function hist(file: string): string[] {
  try {
    return execFileSync('git', ['-C', root, 'log', '--format=%h %s', '-n', '3', '--', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}
const h1 = (t: string) => t.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
const front = (t: string, k: string) => t.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1]?.trim();

function describe(abs: string): Row | null {
  const file = relative(root, abs);
  const text = readFileSync(abs, 'utf8');
  const parts = file.split('/');
  if (file.startsWith('.kiro/hooks/') && file.endsWith('.json')) {
    try {
      const j = JSON.parse(text) as {
        hooks?: Array<{ name: string; trigger: string; matcher?: string; action?: { command?: string } }>;
      };
      const hk = j.hooks?.[0];
      return {
        surface: 'CLI hook',
        file,
        what: hk
          ? `${hk.trigger}${hk.matcher ? ` (${hk.matcher})` : ''} runs \`${hk.action?.command ?? ''}\``
          : 'hook file',
        history: hist(file),
      };
    } catch {
      return null;
    }
  }
  if (file.startsWith('.kiro/steering/'))
    return {
      surface: 'Steering',
      file,
      what: `${h1(text)} (inclusion: ${front(text, 'inclusion') ?? 'always'}${front(text, 'fileMatchPattern') ? `, ${front(text, 'fileMatchPattern')}` : ''})`,
      history: hist(file),
    };
  if (file.startsWith('.kiro/specs/')) {
    const done = (text.match(/^\s*- \[x\]/gm) ?? []).length;
    const all = (text.match(/^\s*- \[[ x]\]/gm) ?? []).length;
    return {
      surface: `Spec: ${parts[2]}`,
      file,
      what: `${h1(text)}${all ? ` (${done} of ${all} tasks ticked)` : ''}`,
      history: hist(file),
    };
  }
  if (file.startsWith('.kiro/agents/')) {
    let what = 'custom agent';
    try {
      const j = JSON.parse(text) as { name?: string; description?: string };
      what = `${j.name ?? ''}${j.description ? `: ${j.description}` : ''}`;
    } catch {}
    return { surface: 'Custom agent', file, what, history: hist(file) };
  }
  if (file.startsWith('.kiro/prompts/'))
    return { surface: 'Prompt', file, what: h1(text) || 'prompt', history: hist(file) };
  if (file.startsWith('.kiro/settings/'))
    return { surface: 'MCP settings', file, what: 'MCP server configuration', history: hist(file) };
  if (file.startsWith('powers/'))
    return {
      surface: 'Power',
      file,
      what: h1(text) || front(text, 'name') || 'power file',
      history: hist(file),
    };
  return null;
}

const tracked = new Set(
  execFileSync('git', ['-C', root, 'ls-files', '-z', '--', '.kiro', 'powers'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean),
);
const shallow =
  execFileSync('git', ['-C', root, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() ===
  'true';
if (shallow) {
  console.error(
    'build-kiro: this is a shallow clone, so file history would be truncated. Fetch full history.',
  );
  process.exit(1);
}

const rows = [...walk(join(root, '.kiro')), ...walk(join(root, 'powers'))]
  .filter((abs) => tracked.has(relative(root, abs)))
  .sort()
  .map(describe)
  .filter((r): r is Row => r !== null);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ generated_from: ['.kiro/', 'powers/'], rows }, null, 2)}\n`);
console.log(`kiro.json: ${rows.length} files`);

// /trial names the pre-registration tag once it exists (written only when the tag is present).
const prereg = resolve(here, '../public/data/prereg.json');
try {
  const sha = execFileSync('git', ['-C', root, 'rev-parse', '--verify', '-q', 'prereg-v1^{commit}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  writeFileSync(prereg, `${JSON.stringify({ tag: 'prereg-v1', sha })}\n`);
  console.log(`prereg.json: prereg-v1 ${sha}`);
} catch {
  if (existsSync(prereg)) rmSync(prereg);
}
