#!/usr/bin/env node
/**
 * Hook latency benchmark (Phase 5, R8) without hyperfine: runs `dnr check --stdin --hook kiro`
 * as a fresh process for the match fixture and the fast-path fixture, R times each after warmup,
 * and writes hyperfine-shaped JSON (`results[].times` in seconds) for scripts/p95.mjs.
 *
 *   node scripts/bench-hook.mjs --cwd <demo checkout> [--runs 30] [--out perf.json]
 * Also times the first write of a fresh session (empty sessions dir: builds the temp-index baseline).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const USAGE =
  'usage: node scripts/bench-hook.mjs --cwd <demo checkout> [--runs 30] [--out perf.json] [--cli <path>]';
let v;
try {
  ({ values: v } = parseArgs({
    options: {
      cwd: { type: 'string' },
      runs: { type: 'string', default: '30' },
      out: { type: 'string', default: 'perf.json' },
      cli: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) {
  console.error(`${e.message}\n${USAGE}`);
  process.exit(64);
}
if (v.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!v.cwd) {
  console.error(USAGE);
  process.exit(64);
}
const cli = v.cli ?? join(root, 'packages/cli/dist/cli.js');
const runs = Number(v.runs);
const env = { ...process.env };
for (const k of ['DNR_MODE', 'DNR_NOW', 'DNR_DEBUG']) delete env[k];

function once(fixture) {
  const input = readFileSync(join(root, 'fixtures/hook-events', fixture));
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [cli, 'check', '--stdin', '--hook', 'kiro'], {
    cwd: v.cwd,
    input,
    env,
  });
  const s = Number(process.hrtime.bigint() - t0) / 1e9;
  return { s, code: r.status };
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

const results = [];
const sessions = join(v.cwd, process.env.DNR_STATE_DIR ? '' : '.dnr', 'sessions');
rmSync(sessions, { recursive: true, force: true });
const cold = once('uncovered.json');
for (const fixture of ['reapply-43933a1dca.json', 'uncovered.json']) {
  for (let i = 0; i < 3; i++) once(fixture);
  const times = [];
  const codes = new Set();
  for (let i = 0; i < runs; i++) {
    const r = once(fixture);
    times.push(r.s);
    codes.add(r.code);
  }
  const ms = times.map((t) => t * 1000);
  results.push({
    command: `dnr check --stdin --hook kiro < fixtures/hook-events/${fixture}`,
    times,
    exit_codes: [...codes],
    median: pct(times, 50),
    p95: pct(times, 95),
  });
  console.log(
    `${fixture}: n=${runs} p50=${pct(ms, 50).toFixed(1)} ms p95=${pct(ms, 95).toFixed(1)} ms exit=${[...codes].join(',')}`,
  );
}
console.log(`first write of a fresh session (baseline build): ${(cold.s * 1000).toFixed(0)} ms`);
writeFileSync(v.out, `${JSON.stringify({ results, cold_first_write_s: cold.s }, null, 2)}\n`);
