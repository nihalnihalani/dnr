/**
 * Local checks used by scripts/submission/check.sh:
 *
 *   pnpm tsx scripts/submission/verify.ts links README.md docs/submission/devpost.md …
 *     Every relative link in each file resolves to a file or directory that exists in the
 *     repo (and its #anchor to a heading), and every commit link names a commit in this repo.
 *   pnpm tsx scripts/submission/verify.ts social docs/submission/social-drafts.md
 *     Each post (a fenced `text` block under a `## X` or `## LinkedIn` heading) starts with
 *     #KiroweenHackathon26; X posts fit in 280 characters.
 *
 * Prints one line per problem and exits 1 if there is any.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export interface LinkProblem {
  file: string;
  href: string;
  problem: string;
}

/** GitHub's heading anchor slug. */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

export function anchors(md: string): Set<string> {
  const out = new Set<string>();
  let fence = false;
  for (const l of md.split('\n')) {
    if (/^```/.test(l)) fence = !fence;
    const m = !fence && /^#{1,6}\s+(.*)$/.exec(l);
    if (m) out.add(slug(m[1] ?? ''));
  }
  return out;
}

/** Markdown inline links outside code fences and code spans. */
export function mdLinks(md: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const l of md.split('\n')) {
    if (/^```/.test(l)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    for (const m of l.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)\)/g)) out.push(m[1] as string);
  }
  return out;
}

const commitExists = (root: string, sha: string) =>
  spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root }).status === 0;

export function checkLinks(
  root: string,
  file: string,
  repoUrl = 'https://github.com/nihalnihalani/dnr',
): LinkProblem[] {
  const abs = resolve(root, file);
  const md = readFileSync(abs, 'utf8');
  const problems: LinkProblem[] = [];
  for (const href of mdLinks(md)) {
    const commit = new RegExp(
      `^(?:${repoUrl.replace(/[.]/g, '\\.')}/|(?:\\.\\./)+)commit/([0-9a-f]{7,40})$`,
    ).exec(href);
    if (commit) {
      if (!commitExists(root, commit[1] as string))
        problems.push({ file, href, problem: 'commit not in this repo' });
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // external: not a repo-file claim
    const [path, anchor] = href.split('#');
    const target = path ? resolve(dirname(abs), path) : abs;
    if (relative(root, target).startsWith('..')) {
      problems.push({ file, href, problem: 'points outside the repo' });
      continue;
    }
    if (!existsSync(target)) {
      problems.push({ file, href, problem: 'no such file' });
      continue;
    }
    if (anchor && statSync(target).isFile() && target.endsWith('.md'))
      if (!anchors(readFileSync(target, 'utf8')).has(anchor))
        problems.push({ file, href, problem: `no heading #${anchor}` });
  }
  return problems;
}

export const TAG = '#KiroweenHackathon26';

export interface Post {
  network: string;
  text: string;
}

export function socialPosts(md: string): Post[] {
  const posts: Post[] = [];
  let network: string | null = null;
  let buf: string[] | null = null;
  for (const l of md.split('\n')) {
    const h = /^##\s+(.*)$/.exec(l);
    if (h && !buf) network = (h[1] ?? '').trim();
    else if (/^```text\s*$/.test(l) && !buf) buf = [];
    else if (/^```\s*$/.test(l) && buf) {
      posts.push({ network: network ?? '?', text: buf.join('\n') });
      buf = null;
    } else if (buf) buf.push(l);
  }
  return posts;
}

export function checkSocial(md: string): string[] {
  const posts = socialPosts(md);
  const p: string[] = [];
  for (const n of ['X', 'LinkedIn'])
    if (!posts.some((x) => x.network.startsWith(n)))
      p.push(`no ${n} post (a \`text\` block under "## ${n}")`);
  for (const x of posts) {
    if (!x.text.startsWith(TAG)) p.push(`${x.network} post does not start with ${TAG}`);
    if (x.network.startsWith('X') && [...x.text].length > 280)
      p.push(`${x.network} post is ${[...x.text].length} characters (X allows 280)`);
  }
  return p;
}

export function main(argv: string[], root = process.cwd()): number {
  const [cmd, ...files] = argv;
  const lines: string[] = [];
  if (cmd === 'links') {
    let n = 0;
    for (const f of files) {
      if (!existsSync(join(root, f))) {
        lines.push(`${f}: file does not exist`);
        continue;
      }
      n += mdLinks(readFileSync(join(root, f), 'utf8')).length;
      for (const x of checkLinks(root, f)) lines.push(`${x.file}: ${x.href}: ${x.problem}`);
    }
    if (!lines.length) process.stdout.write(`${n} link(s) in ${files.length} file(s) resolve\n`);
  } else if (cmd === 'social') {
    for (const f of files)
      for (const x of checkSocial(readFileSync(join(root, f), 'utf8'))) lines.push(`${f}: ${x}`);
    if (!lines.length) process.stdout.write(`every post starts with ${TAG}\n`);
  } else {
    process.stderr.write('usage: verify.ts links|social <file>…\n');
    return 2;
  }
  for (const l of lines) process.stdout.write(`${l}\n`);
  return lines.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
