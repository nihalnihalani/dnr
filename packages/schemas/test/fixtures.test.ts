/**
 * `pnpm test:fixtures`: validate every committed fixture against its Zod schema (plan §7).
 *
 * Required fixtures FAIL when missing. A fixture is skipped only when the plan schedules it
 * later, and the test name says when it becomes required.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  Candidate,
  DiscussionFile,
  DjangoPython,
  EnvMatrix,
  Flaky,
  KnownReverts,
  KnownRevertsRejected,
  Pins,
} from '../src/index';

const root = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

function validate(file: string, schema: z.ZodType): void {
  const path = join(root, file);
  expect(existsSync(path), `required fixture fixtures/${file} is missing`).toBe(true);
  const r = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 5), null, 2)).toBe(true);
}

describe('fixtures (required)', () => {
  it('known-reverts.json validates (Phase 2 acceptance)', () => validate('known-reverts.json', KnownReverts));
  it('known-reverts-rejected.json validates', () =>
    validate('known-reverts-rejected.json', KnownRevertsRejected));
  it('django-python.json validates', () => validate('django-python.json', DjangoPython));
  it('candidates.jsonl: every line is a Candidate', () => {
    const path = join(root, 'candidates.jsonl');
    expect(existsSync(path), 'required fixture fixtures/candidates.jsonl is missing').toBe(true);
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    lines.forEach((line, i) => {
      const r = Candidate.safeParse(JSON.parse(line));
      expect(r.success, `line ${i + 1}: ${r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))}`).toBe(
        true,
      );
    });
  });
  it('discussion/*.json: every file is a DiscussionFile', () => {
    const dir = join(root, 'discussion');
    expect(existsSync(dir), 'required fixture directory fixtures/discussion is missing').toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) validate(`discussion/${f}`, DiscussionFile);
  });
});

describe('fixtures (Phase 0 and Phase 3)', () => {
  // P0-16: pins.json is required from Phase 0. Pins a person or Kiro still decides (model, npm name)
  // are null until then, never a placeholder string.
  it('P0-16 pins.json validates', () => validate('pins.json', Pins));
  // P3-14 / P3-15: written by `dnr trial envs`; required once that has run.
  for (const [file, schema] of [
    ['env-matrix.json', EnvMatrix],
    ['flaky.json', Flaky],
  ] as const) {
    it.skipIf(!existsSync(join(root, file)))(
      `${file} validates [skipped until dnr trial envs writes it]`,
      () => validate(file, schema),
    );
  }
});
