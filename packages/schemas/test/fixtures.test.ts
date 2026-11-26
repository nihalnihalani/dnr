/**
 * `pnpm test:fixtures`: validate every committed fixture against its Zod schema (plan §7).
 * A fixture that does not exist yet is skipped; once committed it must validate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { Candidate, DjangoPython, KnownReverts, KnownRevertsRejected, Pins } from '../src/index';

const root = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

const JSON_FIXTURES: Array<[string, z.ZodType]> = [
  ['known-reverts.json', KnownReverts],
  ['known-reverts-rejected.json', KnownRevertsRejected],
  ['django-python.json', DjangoPython],
  ['pins.json', Pins],
];

describe('fixtures', () => {
  for (const [file, schema] of JSON_FIXTURES) {
    const path = join(root, file);
    it.skipIf(!existsSync(path))(`${file} validates`, () => {
      const r = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      expect(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 5), null, 2)).toBe(true);
    });
  }

  const jsonl = join(root, 'candidates.jsonl');
  it.skipIf(!existsSync(jsonl))('candidates.jsonl: every line is a Candidate', () => {
    const lines = readFileSync(jsonl, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    lines.forEach((line, i) => {
      const r = Candidate.safeParse(JSON.parse(line));
      expect(r.success, `line ${i + 1}: ${r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))}`).toBe(
        true,
      );
    });
  });
});
