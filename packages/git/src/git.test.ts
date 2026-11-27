import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBlob } from './blob';
import { commitDiffU0 } from './diff';
import { classifyMessage, type DiscoveredRevert, discoverReverts, extractQuotedSubject } from './discovery';
import { inversePatchId, patchId, patchIdIndex } from './patchid';
import { isAncestor, resolveCommit } from './refs';
import { revertReproduces } from './revert-check';
import { lines, makeRepo, revertCommit, type TestRepo } from './test-repo';

describe('classifyMessage', () => {
  it('P3-03 mine: regex: matches the three forms, incl. Fixed #N -- Reverted "…", and tags backport and partial', () => {
    expect(classifyMessage('Fixed #1 -- Reverted "Fixed #2 -- Foo."', '').forms).toEqual(['subject']);
    expect(classifyMessage('Revert "x"', 'This reverts commit abcdef1234.').forms).toEqual([
      'subject',
      'body-this-reverts',
    ]);
    expect(classifyMessage('Fixed #3 -- Made X.', 'This partially reverts abcdef1234.').forms).toEqual([
      'body-reverts',
    ]);
    expect(classifyMessage('Fixed #3 -- Made X.', 'Revert commit abcdef1234 because.').bodyShas).toEqual([
      'abcdef1234',
    ]);
    expect(classifyMessage('Partially reverted "x"', '').partialWord).toBe(true);
    expect(classifyMessage('Fixed #3 -- Made X.', 'This mostly reverts abcdef1234.').partialWord).toBe(true);
    expect(classifyMessage('Reverting is hard', '').forms).toEqual(['subject']);
    expect(classifyMessage('Added revertible thing', 'no revert here').forms).toEqual([]);
    expect(classifyMessage('[4.2.x] Reverted "x"', 'Backport of abcdef1234 from main').backport).toBe(true);
  });
  it('P3-05 mine: original: extracts the quoted subject', () => {
    expect(extractQuotedSubject('Fixed #1 -- Reverted "Fixed #2 -- Said "hi"."')).toBe(
      'Fixed #2 -- Said "hi".',
    );
    expect(extractQuotedSubject('Reverted AlterIndexTogether deprecation.')).toBeNull();
  });
});

describe('synthetic history', () => {
  let r: TestRepo;
  const s: Record<string, string> = {};
  let found: DiscoveredRevert[];
  const byR = (k: string) => found.find((d) => d.revert_sha === s[k]);

  beforeAll(async () => {
    r = makeRepo();
    r.write(
      'pkg/a.py',
      lines(30, (i) => `x${i} = ${i}`),
    );
    r.write(
      'pkg/b.py',
      lines(30, (i) => `y${i} = ${i}`),
    );
    s.base = r.commit('Initial');
    // 1. exact revert via `git revert`, body sha.
    r.write(
      'pkg/a.py',
      lines(30, (i) => (i === 5 ? 'x5 = 500' : `x${i} = ${i}`)),
    );
    s.c1 = r.commit('Fixed #101 -- Changed x5.');
    s.r1 = revertCommit(r, s.c1, `Revert "Fixed #101 -- Changed x5."\n\nThis reverts commit ${s.c1}.`);
    // 2. subject-only revert (no sha in body).
    r.write(
      'pkg/b.py',
      lines(30, (i) => (i === 3 ? 'y3 = 300' : `y${i} = ${i}`)),
    );
    s.c2 = r.commit('Fixed #102 -- Changed y3.');
    s.r2 = revertCommit(r, s.c2, 'Fixed #103 -- Reverted "Fixed #102 -- Changed y3."');
    // 3. full (not exact): a later change inside C's context makes the patch-ids differ.
    r.write(
      'pkg/a.py',
      lines(30, (i) => (i === 20 ? 'x20 = 2000' : `x${i} = ${i}`)),
    );
    s.c3 = r.commit('Fixed #104 -- Changed x20.');
    r.write(
      'pkg/a.py',
      lines(30, (i) => (i === 20 ? 'x20 = 2000' : i === 22 ? 'x22 = 2200' : `x${i} = ${i}`)),
    );
    s.mid = r.commit('Changed x22.');
    s.r3 = revertCommit(r, s.c3, `Reverted "Fixed #104 -- Changed x20."\n\nThis reverts commit ${s.c3}.`);
    // 4. partial: C changes two lines, R undoes one.
    r.write(
      'pkg/b.py',
      lines(30, (i) => (i === 10 ? 'y10 = 1' : i === 25 ? 'y25 = 1' : `y${i} = ${i}`)),
    );
    s.c4 = r.commit('Fixed #105 -- Changed y10 and y25.');
    r.write(
      'pkg/b.py',
      lines(30, (i) => (i === 25 ? 'y25 = 1' : `y${i} = ${i}`)),
    );
    s.r4 = r.commit(
      `Refs #105 -- Partially reverted "Fixed #105 -- Changed y10 and y25."\n\nThis reverts commit ${s.c4.slice(0, 12)}.`,
    );
    // 5. silent revert: inverse change, message never says revert.
    r.write(
      'pkg/a.py',
      lines(30, (i) => (i === 22 ? 'x22 = 2200' : i === 28 ? 'x28 = 0' : `x${i} = ${i}`)),
    );
    s.c5 = r.commit('Changed x28.');
    r.write(
      'pkg/a.py',
      lines(30, (i) => (i === 22 ? 'x22 = 2200' : `x${i} = ${i}`)),
    );
    s.r5 = r.commit('Restored x28.');
    // 6. reverted twice: re-land then revert again (latest pair wins).
    r.write(
      'pkg/b.py',
      lines(30, (i) => (i === 25 ? 'y25 = 1' : i === 15 ? 'y15 = 9' : `y${i} = ${i}`)),
    );
    s.c6 = r.commit('Fixed #106 -- Changed y15.');
    s.r6a = revertCommit(r, s.c6, `Revert "Fixed #106 -- Changed y15."\n\nThis reverts commit ${s.c6}.`);
    s.reland = revertCommit(
      r,
      s.r6a,
      `Reverted "Revert "Fixed #106 -- Changed y15.""\n\nThis reverts commit ${s.r6a}.`,
    );
    // 7. message points at a missing sha.
    s.r7 = r.commit('Reverted "Something that never existed."\n\nThis reverts commit 0123456789abcdef.');
    // 8. revert that also adds a release note (full only when extra paths are allowed).
    r.write(
      'pkg/b.py',
      lines(30, (i) => (i === 25 ? 'y25 = 1' : i === 15 ? 'y15 = 9' : i === 2 ? 'y2 = 0' : `y${i} = ${i}`)),
    );
    s.c8 = r.commit('Fixed #108 -- Changed y2.');
    r.git('revert', '--no-commit', s.c8);
    r.write('docs/releases/1.0.txt', 'Reverted y2.\n');
    s.r8 = r.commit(`Fixed #109 -- Reverted "Fixed #108 -- Changed y2."\n\nThis reverts commit ${s.c8}.`);
    found = await discoverReverts(r.dir, { ref: 'main', extraPathAllowed: (p) => p.startsWith('docs/') });
  }, 60_000);
  afterAll(() => r.cleanup());

  it('reads blobs and ancestry', async () => {
    expect(await readBlob(r.dir, s.c1 as string, 'pkg/a.py')).toContain('x5 = 500');
    expect(await readBlob(r.dir, s.c1 as string, 'missing.py')).toBeNull();
    expect(await isAncestor(r.dir, s.c1 as string, s.r1 as string)).toBe(true);
    expect(await isAncestor(r.dir, s.r1 as string, s.c1 as string)).toBe(false);
    expect(await resolveCommit(r.dir, (s.c1 as string).slice(0, 8))).toBe(s.c1);
    expect(await resolveCommit(r.dir, 'deadbeefdeadbeef')).toBeNull();
  });

  it('P3-04 mine: patch-id: computes forward and inverse patch-ids consistently', async () => {
    expect(await patchId(r.dir, s.c1 as string)).toBe(await inversePatchId(r.dir, s.r1 as string));
    expect(await patchId(r.dir, s.c3 as string)).not.toBe(await inversePatchId(r.dir, s.r3 as string));
    const idx = await patchIdIndex(r.dir, 'main');
    expect(idx.forward.get(s.c1 as string)).toBe(await patchId(r.dir, s.c1 as string));
    expect(idx.inverse.get(s.r1 as string)).toBe(await inversePatchId(r.dir, s.r1 as string));
  });

  it('P3-06 mine: kind: full = git revert --no-commit C on R^ reproduces R', async () => {
    expect(await revertReproduces(r.dir, s.c3 as string, s.r3 as string)).toBe(true);
    expect(await revertReproduces(r.dir, s.c4 as string, s.r4 as string)).toBe(false);
    expect(r.git('worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('parses a commit diff at -U0', async () => {
    const d = await commitDiffU0(r.dir, s.c1 as string);
    expect(d).toHaveLength(1);
    expect(d[0]?.hunks[0]).toMatchObject({ oldStart: 5, removed: ['x5 = 5'], added: ['x5 = 500'] });
  });

  it('P3-04 P3-05 P3-06 mine: patch-id, original and kind: body SHA, quoted subject, silent patch-id, exact/full/partial', async () => {
    expect(byR('r1')).toMatchObject({
      original_sha: s.c1,
      match_method: 'body-sha',
      revert_kind: 'exact',
      tags: [],
    });
    expect(byR('r2')).toMatchObject({ original_sha: s.c2, match_method: 'subject', revert_kind: 'exact' });
    expect(byR('r3')).toMatchObject({ original_sha: s.c3, revert_kind: 'full', kind_evidence: 'git-revert' });
    expect(byR('r4')).toMatchObject({ original_sha: s.c4, revert_kind: 'partial' });
    expect(byR('r4')?.tags).toContain('partial');
    expect(byR('r5')).toMatchObject({
      original_sha: s.c5,
      match_method: 'patch-id-silent',
      revert_kind: 'exact',
      matched_forms: [],
    });
    expect(byR('r7')).toMatchObject({ original_sha: null, revert_kind: null });
    expect(byR('r7')?.original_note).toMatch(/do not resolve/);
  });

  it('P3-06 mine: kind: allowed extra paths in R for full, strict by default', async () => {
    expect(byR('r8')).toMatchObject({
      original_sha: s.c8,
      revert_kind: 'full',
      kind_evidence: 'git-revert+extra:docs/releases/1.0.txt',
    });
    const strict = await discoverReverts(r.dir, { ref: 'main', silent: false });
    expect(strict.find((d) => d.revert_sha === s.r8)?.revert_kind).toBe('unclear');
  });

  it('P3-03 P3-05 mine: original: tags revert_of_revert and keeps the latest pair', () => {
    const reland = byR('reland');
    expect(reland?.original_sha).toBe(s.r6a);
    expect(reland?.tags).toContain('revert_of_revert');
    expect(byR('r6a')?.superseded_by).toBeNull();
    // The re-land is itself silently inverse to r6a's revert; it is not double-counted as silent.
    expect(found.filter((d) => d.revert_sha === s.reland)).toHaveLength(1);
  });

  it('P3-02 mine: discovery is sorted and deterministic', async () => {
    const again = await discoverReverts(r.dir, {
      ref: 'main',
      extraPathAllowed: (p) => p.startsWith('docs/'),
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(found));
    const dates = found.map((d) => Date.parse(d.committed_at));
    expect([...dates].sort((a, b) => a - b)).toEqual(dates);
  });
});

describe('scan language globs', async () => {
  const { matchesLang } = await import('./scan');
  it('matches py and ts but not .d.ts', () => {
    expect(matchesLang('a/b.py', ['py'])).toBe(true);
    expect(matchesLang('a/b.tsx', ['ts'])).toBe(true);
    expect(matchesLang('a/b.d.ts', ['ts'])).toBe(false);
    expect(matchesLang('a/b.txt', ['py', 'ts'])).toBe(false);
  });
});
