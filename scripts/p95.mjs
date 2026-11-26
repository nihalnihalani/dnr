#!/usr/bin/env node
// Reads a hyperfine --export-json file (or bench-hook.mjs output, same shape) and prints p50/p95 per command.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/p95.mjs perf.json');
  process.exit(64);
}
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
for (const r of JSON.parse(readFileSync(file, 'utf8')).results) {
  const ms = r.times.map((t) => t * 1000);
  console.log(
    `${r.command}\n  n=${ms.length} p50=${pct(ms, 50).toFixed(1)} ms p95=${pct(ms, 95).toFixed(1)} ms`,
  );
}
