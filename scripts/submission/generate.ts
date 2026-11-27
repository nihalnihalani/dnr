/**
 * Generates the submission text (plan §11, §15) from real sources only:
 * - docs/submission/pitch.md: the §15 pitch, the Devpost tagline, the README one-liner and the
 *   Impact paragraph, for the §9.8 row in reports/video/numbers.json;
 * - docs/submission/devpost.md: the Devpost write-up in the §11 order, assembled from
 *   numbers.json, reports/trial.json, the tracked `.kiro/` and `powers/` files and their latest
 *   commits, docs/spikes.md statuses, and the build findings already written in docs/kiro-usage.md.
 *
 * Anything without a source is an explicit "pending: <source>" line, never a number. Output is
 * deterministic, so `--check` fails when the committed files are stale.
 *
 *   pnpm tsx scripts/submission/generate.ts [--check]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { parseArgs } from 'node:util';
import { kiroSurfaces, REPO_URL } from '../video/context';
import { loadNumbers, PENDING_RE, pending, type VideoNumbers } from '../video/numbers';
import { HEADLINE, impact, pitch, readmeOneLiner, tagline } from './pitch';

export interface Sources {
  root: string;
  numbers: VideoNumbers | null;
  trial: Record<string, unknown> | null;
  pilot: string | null;
  links: Links;
}

export interface Links {
  playground_url: string | null;
  video_url: string | null;
  devto_url: string | null;
  x_url: string | null;
  linkedin_url: string | null;
  crew_repo: string | null;
}

export const LINKS_FILE = 'docs/submission/links.json';
const OUT_DIR = 'docs/submission';
const P = (s: string) => `**Pending:** ${s.replace(/^\[pending: |\]$/g, '')}.`;

const read = (root: string, p: string) =>
  existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null;

export function readLinks(root: string): Links {
  const raw = read(root, LINKS_FILE);
  const j = raw ? (JSON.parse(raw) as Partial<Links>) : {};
  return {
    playground_url: j.playground_url ?? null,
    video_url: j.video_url ?? null,
    devto_url: j.devto_url ?? null,
    x_url: j.x_url ?? null,
    linkedin_url: j.linkedin_url ?? null,
    crew_repo: j.crew_repo ?? null,
  };
}

export function readSources(root: string): Sources {
  const np = join(root, 'reports/video/numbers.json');
  const tj = read(root, 'reports/trial.json');
  return {
    root,
    numbers: existsSync(np) ? loadNumbers(np) : null,
    trial: tj ? (JSON.parse(tj) as Record<string, unknown>) : null,
    pilot: read(root, 'reports/pilot.json'),
    links: readLinks(root),
  };
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

const lastCommit = (root: string, paths: string[]) => git(root, ['log', '-1', '--format=%h', '--', ...paths]);
const commitLink = (sha: string) => `[${sha}](${REPO_URL}/commit/${sha})`;

/** `## Heading` section body of a Markdown file, up to the next heading of the same or higher level. */
export function section(md: string, heading: RegExp): string | null {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => heading.test(l));
  if (i < 0) return null;
  const level = /^#+/.exec(lines[i] ?? '')?.[0].length ?? 2;
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    const m = /^(#+)\s/.exec(l);
    if (m && (m[1]?.length ?? 9) <= level) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

/**
 * Rewrites relative Markdown links written in `fromFile` so they resolve from `toFile`. GitHub
 * commit links written relative to the blob view become absolute commit URLs.
 */
export function rebaseLinks(md: string, fromFile: string, toFile: string): string {
  return md.replace(/\]\(([^)\s]+)\)/g, (all, href: string) => {
    if (/^[a-z]+:|^#/.test(href)) return all;
    const commit = /(?:\.\.\/)+commit\/([0-9a-f]{7,40})$/.exec(href);
    if (commit) return `](${REPO_URL}/commit/${commit[1]})`;
    const [path, anchor] = href.split('#');
    const abs = posix.normalize(posix.join(posix.dirname(fromFile), path ?? ''));
    let rel = posix.relative(posix.dirname(toFile), abs) || '.';
    if (href.endsWith('/') && !rel.endsWith('/')) rel += '/';
    return `](${rel}${anchor !== undefined ? `#${anchor}` : ''})`;
  });
}

/** Last column of a docs/spikes.md row (`| S14 | … | result |`). */
export function spikeStatus(spikesMd: string | null, id: string): string | null {
  if (!spikesMd) return null;
  const row = spikesMd.split('\n').find((l) => l.startsWith(`| ${id} |`));
  if (!row) return null;
  const cells = row.split('|').map((c) => c.trim());
  return cells[cells.length - 2] ?? null;
}

export function npmPackage(root: string): string | null {
  const pins = read(root, 'fixtures/pins.json');
  return pins ? ((JSON.parse(pins) as { npm_package?: string | null }).npm_package ?? null) : null;
}

const isPending = (s: string | null) => s === null || /^pending\b/i.test(s);

function surfaceSentences(s: Sources): string[] {
  const root = s.root;
  const spikes = read(root, 'docs/spikes.md');
  const surfaces = new Map(kiroSurfaces(root).map((x) => [x.key, x]));
  const out: string[] = [];
  const spike = (id: string, what: string) => {
    const st = spikeStatus(spikes, id);
    if (st === null) return P(`spike ${id} has no row in docs/spikes.md`);
    return isPending(st)
      ? P(`spike ${id}, ${what} (${st.replace(/^pending\s*/i, '').replace(/^\((.*)\)$/, '$1')})`)
      : `Spike ${id}: ${st}`;
  };
  const files = (key: string) => surfaces.get(key)?.files ?? [];
  const link = (f: string) => `[${f.split('/').pop()}](../../${f})`;

  const specs = [...new Set(files('specs').map((f) => f.split('/')[2]))];
  out.push(
    specs.length
      ? `- **Specs and tasks:** ${specs.length} specs with requirements, design and tasks, ${specs.map((d) => `[${d}](../../.kiro/specs/${d}/)`).join(' and ')} (last change ${commitLink(lastCommit(root, ['.kiro/specs']))}). Running them in Kiro IDE spec mode: ${spike('S14', 'the IDE')}`
      : `- **Specs and tasks:** ${P('.kiro/specs/ has no tracked spec')}`,
  );
  const hooks = files('hooks');
  out.push(
    hooks.length
      ? `- **CLI hooks and headless runs:** ${hooks.length} DNR hook files, ${hooks.map(link).join(', ')} (last change ${commitLink(lastCommit(root, ['.kiro/hooks']))}). A live headless Kiro block: ${spike('S1', 'an always-block hook under kiro-cli')}`
      : `- **CLI hooks:** ${P('.kiro/hooks/ has no tracked DNR hook')}`,
  );
  out.push(`- **Kiro Web and IDE:** ${spike('S14', 'whether hooks run on Kiro Web and in the IDE')}`);
  out.push(
    `- **Crew bot:** ${s.links.crew_repo ? `[${s.links.crew_repo}](${s.links.crew_repo}).` : P(`a public \`dnr-crew\` repo (\`crew_repo\` in ${LINKS_FILE}, Phase 12)`)} ${spike('S16', 'how Crew exposes a session to a bot')}`,
  );
  const agents = files('agents');
  out.push(
    agents.length
      ? `- **Custom agents:** ${agents.length} agent configs, ${agents.map(link).join(', ')} (last change ${commitLink(lastCommit(root, ['.kiro/agents', 'trial/agents']))}). Agent-config hooks: ${spike('S10', 'the agent-config hook shape')}`
      : `- **Custom agents:** ${P('no tracked agent config')}`,
  );
  const steering = files('steering');
  out.push(
    steering.length
      ? `- **Steering:** ${steering.map(link).join(', ')} (last change ${commitLink(lastCommit(root, ['.kiro/steering']))}).`
      : `- **Steering:** ${P('.kiro/steering/ is empty')}`,
  );
  const mcp = files('mcp');
  const power = files('power');
  out.push(
    `- **MCP and the power:** ${mcp.length ? `${mcp.map(link).join(', ')} registers the read-only server in [packages/mcp/](../../packages/mcp/)` : P('.kiro/settings/mcp.json')}; ${power.length ? `the power is ${power.map(link).join(', ')} (last change ${commitLink(lastCommit(root, ['powers']))})` : P('powers/')}. Which power format loads: ${spike('S9', 'plugin.json or POWER.md')}`,
  );
  const pf = read(root, 'reports/property-failures.md');
  out.push(
    pf
      ? `- **Property tests:** P1–P17 in [properties.test.ts](../../packages/testkit/src/properties.test.ts), with the first failures, their fixes and the re-runs recorded in [reports/property-failures.md](../../reports/property-failures.md) (last change ${commitLink(lastCommit(root, ['reports/property-failures.md']))}).`
      : `- **Property tests:** ${P('reports/property-failures.md')}`,
  );
  const dev = files('dev-hooks');
  out.push(
    dev.length
      ? `- **Dev hooks:** ${dev.map(link).join(', ')}. Firing in the IDE: ${spike('S14', 'the IDE')}`
      : `- **Dev hooks:** ${P('no tracked dev hook')}`,
  );
  return out;
}

function resultsTable(n: VideoNumbers | null, trial: Record<string, unknown> | null): string[] {
  if (!n) return [P('the results table, from reports/video/numbers.json and reports/trial.json (Phase 11)')];
  if (n.via_d6 || n.row === 'D5') return [`> ${n.wording ?? pending('numbers.json wording')}`];
  const r = (k: 'X_eff' | 'S_eff' | 'W_L') =>
    n[k] === undefined ? pending(`numbers.json ${k}`) : `${n[k]} of ${n.K_eff}`;
  const L = [
    '| Arm | Landed a reverted change (lower is better) |',
    '|---|---|',
    `| No DNR (T) | ${r('X_eff')} |`,
  ];
  L.push(`| Steering file from history (S) | ${r('S_eff')} |`);
  if (n.mode !== 'commit-enforce')
    L.push(
      `| DNR live (L)${n.mode === 'warn-only' ? ', both tiers (trial configuration, not shipped)' : ''} | ${r('W_L')} |`,
    );
  const kappa = (trial?.kappa as { builder_vs_outside?: number | null } | undefined)?.builder_vs_outside;
  L.push(
    '',
    `κ (builder vs outside labeler): ${kappa === undefined || kappa === null ? P('reports/trial.json kappa') : kappa.toFixed(2)}`,
  );
  return L;
}

export function pitchMarkdown(s: Sources): string {
  const n = s.numbers;
  return `${[
    '# Pitch, tagline and one-liner',
    '',
    'Generated by `scripts/submission/generate.ts` from `reports/video/numbers.json` (plan 02 §15, 09 §11). Do not edit by hand.',
    '',
    `Row: ${n ? `${n.row}${n.via_d6 ? ' (via D6)' : ''}, mode ${n.mode ?? 'null'}` : P('reports/video/numbers.json (`dnr trial report`, Phase 11)')}`,
    '',
    '## Pitch (§15)',
    '',
    pitch(n),
    '',
    '## Devpost tagline',
    '',
    tagline(),
    '',
    '## README one-liner',
    '',
    readmeOneLiner(n),
    '',
    '## Impact paragraph',
    '',
    impact(n, s.pilot),
  ].join('\n')}\n`;
}

export function devpostMarkdown(s: Sources): string {
  const root = s.root;
  const ku = read(root, 'docs/kiro-usage.md') ?? '';
  const from = 'docs/kiro-usage.md';
  const to = `${OUT_DIR}/devpost.md`;
  const fromKu = (re: RegExp, what: string) => {
    const b = section(ku, re);
    return b ? rebaseLinks(b, from, to) : P(`${what} in docs/kiro-usage.md`);
  };
  const firstPara = (md: string) =>
    md.split(/\n\s*\n/).find((p) => !p.startsWith('>') && !p.startsWith('-') && !p.startsWith('**Pending')) ??
    '';
  const n = s.numbers;
  const preregTag = (() => {
    try {
      return git(root, ['rev-parse', '-q', '--verify', 'prereg-v1^{commit}']);
    } catch {
      return null;
    }
  })();
  const limits = section(read(root, 'docs/threat-model.md') ?? '', /^## Known limits/);
  const url = s.links.playground_url;
  const L = [
    '# DNR (Do Not Resurrect): Devpost write-up',
    '',
    `Generated by \`scripts/submission/generate.ts\` in the plan §11 order. Build findings come from [docs/kiro-usage.md](../kiro-usage.md); surfaces from the tracked \`.kiro/\` and \`powers/\` files; results from \`reports/video/numbers.json\` and \`reports/trial.json\`. Anything without a source is marked pending. Do not edit by hand.`,
    '',
    '## 1. Problem',
    '',
    `> **${HEADLINE}**`,
    '',
    rebaseLinks(firstPara(section(ku, /^## 1\. Problem/) ?? ''), from, to) ||
      P('the problem paragraph in docs/kiro-usage.md'),
    '',
    existsSync(join(root, 'reports/video/block.gif'))
      ? '![A live DNR block](../../reports/video/block.gif)'
      : P('the GIF of a live block, `reports/video/block.gif`, cut from the filmed `demo/L` run (Phase 14)'),
    '',
    '## 2. Audience and evidence',
    '',
    rebaseLinks(firstPara(section(ku, /^## 2\. Audience/) ?? ''), from, to) || P('the audience paragraph'),
    '',
    `**Impact.** ${impact(n, s.pilot).replace(PENDING_RE, (m) => `*${m}*`)}`,
    '',
    '## 3. How it works',
    '',
    fromKu(/^## 3\. How it works/, 'section 3'),
    '',
    '## 4. Trial',
    '',
    `Method: the pre-registration in [reports/preregistration.md](../../reports/preregistration.md), the protocol in [.kiro/specs/trial-harness/](../../.kiro/specs/trial-harness/), and the §9.8 decision table in [packages/trial/src/decision.ts](../../packages/trial/src/decision.ts).`,
    '',
    `Pre-registration tag: ${preregTag ? `\`prereg-v1\` at ${commitLink(preregTag.slice(0, 10))}` : P('the `prereg-v1` tag (end of Phase 10)')}`,
    '',
    ...resultsTable(n, s.trial),
    '',
    `Limits: ${existsSync(join(root, 'reports/trial.md')) ? 'the exclusions, κ intervals and secondary cohorts are in [reports/trial.md](../../reports/trial.md).' : P('reports/trial.md (`dnr trial report`, Phase 11)')}`,
    '',
    '## 5. How Kiro built it',
    '',
    ...surfaceSentences(s),
    '',
    '## 6. Try it',
    '',
    url
      ? `- **Playground (no login):** ${url}`
      : `- ${P(`the Playground URL (\`playground_url\` in ${LINKS_FILE})`)}`,
    '- **The real hook offline:** `dnr demo --live` ([docs/testing.md](../testing.md)).',
    `- **Your repository:** ${npmPackage(root) ? `\`npm i -g ${npmPackage(root)} && dnr init\`` : `build from source as in the [README](../../README.md#quick-start). ${P('the npm package name (`npm_package` in fixtures/pins.json, P0-29)')}`}`,
    '',
    '## 7. Limits',
    '',
    `From [docs/threat-model.md](../threat-model.md#known-limits):`,
    '',
    limits
      ? rebaseLinks(limits, 'docs/threat-model.md', to)
      : P('the Known limits section of docs/threat-model.md'),
  ];
  return `${L.join('\n')}\n`;
}

export function generate(s: Sources): Record<string, string> {
  return { [`${OUT_DIR}/pitch.md`]: pitchMarkdown(s), [`${OUT_DIR}/devpost.md`]: devpostMarkdown(s) };
}

export function main(argv: string[], root = process.cwd()): number {
  const { values: v } = parseArgs({ args: argv, options: { check: { type: 'boolean', default: false } } });
  const out = generate(readSources(root));
  let stale = 0;
  for (const [p, text] of Object.entries(out)) {
    const f = join(root, p);
    if (v.check) {
      if (!existsSync(f) || readFileSync(f, 'utf8') !== text) {
        process.stderr.write(
          `submission generate --check: ${p} is stale; re-run scripts/submission/generate.ts\n`,
        );
        stale++;
      }
      continue;
    }
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
    const pend = text.match(/\*\*Pending:\*\*|\[pending: /g)?.length ?? 0;
    process.stdout.write(`submission generate: wrote ${p} (${pend} pending item(s))\n`);
  }
  return stale ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
