// Copies the vendored grammars into the package (`vendor/grammars/`, shipped in `files`).
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../../vendor/grammars/', import.meta.url));
const to = fileURLToPath(new URL('./vendor/grammars/', import.meta.url));
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
