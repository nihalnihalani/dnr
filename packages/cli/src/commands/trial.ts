/**
 * `dnr trial <sub>`: mine, tickets, assign and known-reverts delegate to the mining code in
 * @dnr/trial; falsealarm is a CLI command; the harness (prepare, run, envs, label, replay, score,
 * rescore, report, probe, baseline, prereg) is `runHarness` in @dnr/trial.
 */
import { createInterface } from 'node:readline/promises';
import { EXIT } from '../errors';
import type { CliIO } from '../io';
import { renderSteering } from './steering';

const MINING = new Set([
  'mine',
  'tickets',
  'assign',
  'known-reverts',
  'python-table',
  'python',
  'packets',
  'merge-reasons',
  'reproposals',
]);
const HARNESS = new Set([
  'envs',
  'probe',
  'baseline',
  'prepare',
  'run',
  'label',
  'replay',
  'score',
  'rescore',
  'report',
  'prereg',
]);

/** Line prompt on the real terminal (labeling is interactive and human-only). */
async function ask(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function cmdTrial(argv: string[], io: CliIO): Promise<number> {
  const [sub] = argv;
  if (!sub || sub === '--help' || sub === '-h') {
    io.out(`dnr trial <${[...MINING, 'falsealarm', ...HARNESS].join('|')}> …\n`);
    return sub ? EXIT.OK : EXIT.USAGE;
  }
  if (sub === 'falsealarm') return (await import('./falsealarm')).cmdFalsealarm(argv, io);
  if (MINING.has(sub)) {
    // L1 (wave-2): print usage instead of handing --help to the mining entry, which throws on it.
    if (argv.includes('--help') || argv.includes('-h')) {
      io.out(`dnr trial ${sub} …  (mining; see packages/trial/src/mine/cli.ts for flags)\n`);
      return EXIT.OK;
    }
    try {
      const { runMineCli } = await import('@dnr/trial');
      const code = await runMineCli(argv);
      return code === 2 ? EXIT.DEPENDENCY : code;
    } catch (e) {
      io.err(`DNR: dnr trial ${sub}: ${String((e as Error).message ?? e).split('\n')[0]}\n`);
      return EXIT.USAGE;
    }
  }
  if (HARNESS.has(sub)) {
    const { runHarness } = await import('@dnr/trial');
    return runHarness(sub, argv.slice(1), {
      env: io.env,
      cwd: io.cwd,
      out: (s) => io.out(s),
      err: (s) => io.err(s),
      ask,
      deps: { renderSteering },
    });
  }
  io.err(`DNR: unknown trial subcommand ${sub}\n`);
  return EXIT.USAGE;
}
