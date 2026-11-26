import { loadGrammarsNode } from '@dnr/grammar/node';
import type { ParserProvider } from '../syntax';

export function grammars(): Promise<ParserProvider> {
  return loadGrammarsNode();
}

export const SHA_C = 'c'.repeat(40);
export const SHA_R = 'a1b2c3d4e5'.padEnd(40, '0');
export const SHA_S = 'e'.repeat(40);
export const LINKS = [
  { rel: 'original' as const, url: 'https://example.test/synthetic/commit/cccc' },
  { rel: 'revert' as const, url: 'https://example.test/synthetic/commit/a1b2' },
];
