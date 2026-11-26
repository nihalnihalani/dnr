import { describe, expect, it } from 'vitest';
import { cohenKappa } from './label';
import {
  classifierVersions,
  djangoVersionOf,
  requiresMin,
  toxVersions,
  workflowVersions,
} from './python-version';
import { MIN_INTERVAL_MS, PoliteFetcher, parseCsv, parseTracRss } from './tickets';

describe('Trac parsing', () => {
  it('parses quoted CSV with newlines', () => {
    expect(parseCsv('﻿id,summary,description\r\n26434,"A ""q""","line1\nline2"\r\n')).toEqual([
      ['id', 'summary', 'description'],
      ['26434', 'A "q"', 'line1\nline2'],
    ]);
  });
  it('parses RSS comments', () => {
    const xml =
      '<rss><channel><item><dc:creator>alice</dc:creator><title>comment:1</title><description>&lt;p&gt;Looks &amp;amp; good&lt;/p&gt;</description></item></channel></rss>';
    expect(parseTracRss(xml)).toEqual(['alice: comment:1 Looks & good']);
  });
});

describe('PoliteFetcher', () => {
  it('waits between requests and backs off on 5xx', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const codes = [503, 200, 200];
    const seen: number[] = [];
    const f = new PoliteFetcher(
      async () => {
        seen.push(t);
        return { status: codes.shift() ?? 200, text: '' };
      },
      async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      () => t,
    );
    await f.get('u1');
    await f.get('u2');
    for (let i = 1; i < seen.length; i++)
      expect((seen[i] as number) - (seen[i - 1] as number)).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
    expect(sleeps).toContain(MIN_INTERVAL_MS * 2);
  });
});

describe('python version sources', () => {
  it('reads classifiers, requires, tox and workflows', () => {
    expect(
      classifierVersions(
        '"Programming Language :: Python :: 3.12",\n"Programming Language :: Python :: 3.10"',
      ),
    ).toEqual(['3.10', '3.12']);
    expect(requiresMin('requires-python = ">= 3.12"', /requires-python\s*=\s*["']([^"']+)["']/)).toBe('3.12');
    expect(toxVersions('[tox]\nenvlist =\n    py3\n    py3{8,9}\n[testenv]\n')).toEqual(['3.8', '3.9']);
    expect(workflowVersions("python-version: ['3.10', '3.11']\n        python-version: 3.12")).toEqual([
      '3.10',
      '3.11',
      '3.12',
    ]);
    expect(djangoVersionOf('VERSION = (5, 2, 0, "alpha", 0)')).toBe('5.2');
  });
});

describe('cohenKappa', () => {
  it('computes agreement beyond chance', () => {
    const s = (i: number) => i.toString(16).padStart(40, '0');
    const cats = [
      ['CRASH', 'CRASH'],
      ['CRASH', 'OTHER'],
      ['OTHER', 'OTHER'],
      ['OTHER', 'OTHER'],
    ] as const;
    const labels = cats.flatMap(([a, b], i) => [
      { revert_sha: s(i), labeler: 'a', category: a, adjudicated: false },
      { revert_sha: s(i), labeler: 'b', category: b, adjudicated: false },
    ]);
    const k = cohenKappa(labels, 'a', 'b');
    expect(k.n).toBe(4);
    expect(k.kappa).toBeCloseTo(0.5, 5);
  });
});
