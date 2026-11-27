/**
 * WRITE-03, SUB-08, P14-02: the write-up generator, the link checker and the social-draft check.
 * Real git repositories in temp directories; trial numbers from the harness's own scoring code
 * on constructed TEST inputs (scripts/video/test/trial-data.ts).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNumbers } from '../video/numbers';
import { D2, D6, scoreScenario } from '../video/test/trial-data';
import {
  devpostMarkdown,
  generate,
  pitchMarkdown,
  readSources,
  rebaseLinks,
  section,
  spikeStatus,
} from './generate';
import { anchors, checkLinks, checkSocial, mdLinks, slug, TAG } from './verify';

const ROOT = join(import.meta.dirname, '../..');

function repo(files: Record<string, string>): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dnr-launch-test-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'test');
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'test');
  return { dir, sha: g('rev-parse', '--short', 'HEAD') };
}

describe('WRITE-03 generator', () => {
  it('WRITE-03: section() and spikeStatus() read the real docs', () => {
    const ku = readFileSync(join(ROOT, 'docs/kiro-usage.md'), 'utf8');
    expect(section(ku, /^### 3b\./)).toContain('Test hunks diluted the real order');
    const spikes = readFileSync(join(ROOT, 'docs/spikes.md'), 'utf8');
    expect(spikeStatus(spikes, 'S14')).toMatch(/^pending|\S/);
    expect(spikeStatus(spikes, 'S99')).toBeNull();
  });

  it('WRITE-03: links are rebased from docs/ to docs/submission/; commit links become absolute', () => {
    const md =
      '[a](../reports/x.md) [b](architecture.md#top) [c](../../../commit/b6f3a09) [d](https://e.org) [e](../vendor/grammars/)';
    expect(rebaseLinks(md, 'docs/kiro-usage.md', 'docs/submission/devpost.md')).toBe(
      '[a](../../reports/x.md) [b](../architecture.md#top) [c](https://github.com/nihalnihalani/dnr/commit/b6f3a09) [d](https://e.org) [e](../../vendor/grammars/)',
    );
  });

  it('WRITE-03: with no numbers.json the pitch, one-liner and results are pending, never numbers', () => {
    const s = { ...readSources(ROOT), numbers: null, trial: null };
    const p = pitchMarkdown(s);
    expect(p).toContain('[pending: reports/video/numbers.json');
    expect(p).not.toMatch(/\d+ of \d+/);
    const d = devpostMarkdown(s);
    expect(d).toContain('**Pending:** the results table');
    for (const h of [
      '## 1. Problem',
      '## 2. Audience',
      '## 3. How it works',
      '## 4. Trial',
      '## 5. How Kiro',
      '## 6. Try it',
      '## 7. Limits',
    ])
      expect(d).toContain(h);
    expect(d.indexOf('## 6. Try it')).toBeLessThan(d.indexOf('## 7. Limits'));
  });

  it('WRITE-03: D2 numbers fill the results table and Impact; D6 shows no rate', () => {
    const base = readSources(ROOT);
    const d2 = scoreScenario(D2);
    const s2 = {
      ...base,
      numbers: parseNumbers(d2.numbers),
      trial: d2.trial as unknown as Record<string, unknown>,
    };
    const d = devpostMarkdown(s2);
    expect(d).toContain('| No DNR (T) | 4 of 8 |');
    expect(d).toContain('| DNR live (L) | 0 of 8 |');
    expect(d).toContain('κ (builder vs outside labeler): 1.00');
    expect(pitchMarkdown(s2)).toContain('a Pre Tool Use hook stops it before the file changes.');
    const d6 = scoreScenario(D6);
    const s6 = {
      ...base,
      numbers: parseNumbers(d6.numbers),
      trial: d6.trial as unknown as Record<string, unknown>,
    };
    expect(devpostMarkdown(s6)).toContain('No re-application rate is claimed.');
    expect(pitchMarkdown(s6)).not.toMatch(/\d+ of \d+/);
  });

  it('WRITE-03: the committed docs/submission files are current', () => {
    for (const [p, text] of Object.entries(generate(readSources(ROOT))))
      expect(readFileSync(join(ROOT, p), 'utf8'), p).toBe(text);
  });
});

describe('SUB-08 link checker', () => {
  it('SUB-08: relative files, anchors and commits must exist in a real repo', () => {
    const { dir, sha } = repo({ 'reports/a.md': '# Known limits\n\ntext\n' });
    mkdirSync(join(dir, 'docs'));
    writeFileSync(
      join(dir, 'docs/x.md'),
      [
        `[ok](../reports/a.md) [anchor](../reports/a.md#known-limits) [commit](https://github.com/nihalnihalani/dnr/commit/${sha})`,
        '[missing](../reports/none.md) [bad-anchor](../reports/a.md#nope) [bad-commit](../../../commit/deadbee) [web](https://example.org)',
        '`[in code](nope.md)`',
        '```',
        '[fenced](nope.md)',
        '```',
      ].join('\n'),
    );
    const p = checkLinks(dir, 'docs/x.md');
    expect(p.map((x) => [x.href, x.problem])).toEqual([
      ['../reports/none.md', 'no such file'],
      ['../reports/a.md#nope', 'no heading #nope'],
      ['../../../commit/deadbee', 'commit not in this repo'],
    ]);
  });

  it('SUB-08: GitHub slugs and fence-aware parsing', () => {
    expect(slug('3b. What surprised us during the build')).toBe('3b-what-surprised-us-during-the-build');
    expect(anchors('# Testing\n```\n# not\n```\n')).toEqual(new Set(['testing']));
    expect(mdLinks('[a](b.md) `[c](d.md)`')).toEqual(['b.md']);
  });

  it('SUB-08: every link in the README and the write-up resolves today', () => {
    for (const f of [
      'README.md',
      'docs/kiro-usage.md',
      'docs/submission/devpost.md',
      'docs/submission/devto-draft.md',
    ])
      expect(checkLinks(ROOT, f), f).toEqual([]);
  });
});

describe('P14-02 social drafts', () => {
  it('P14-02: each post starts with the tag; X fits 280 characters', () => {
    expect(checkSocial(readFileSync(join(ROOT, 'docs/submission/social-drafts.md'), 'utf8'))).toEqual([]);
    const bad = `## X\n\n\`\`\`text\nhello ${TAG}\n\`\`\`\n\n## LinkedIn\n\n\`\`\`text\n${TAG} ${'x'.repeat(400)}\n\`\`\`\n`;
    expect(checkSocial(bad)).toEqual(['X post does not start with #KiroweenHackathon26']);
    expect(checkSocial(`## X\n\n\`\`\`text\n${TAG} ${'y'.repeat(300)}\n\`\`\`\n`)).toEqual([
      'no LinkedIn post (a `text` block under "## LinkedIn")',
      'X post is 321 characters (X allows 280)',
    ]);
  });
});
