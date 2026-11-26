/**
 * `dnr trial <sub>`: mine, tickets, assign and known-reverts delegate to the mining code in
 * @dnr/trial; every other trial subcommand belongs to a later wave and exits 69.
 */
import { EXIT } from '../errors';
import type { CliIO } from '../io';

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
const LATER = new Set([
  'envs',
  'probe',
  'baseline',
  'prepare',
  'run',
  'label',
  'replay',
  'falsealarm',
  'score',
  'rescore',
  'report',
]);

export async function cmdTrial(argv: string[], io: CliIO): Promise<number> {
  const [sub] = argv;
  if (!sub || sub === '--help' || sub === '-h') {
    io.out(`dnr trial <${[...MINING, ...LATER].join('|')}> …\n`);
    return sub ? EXIT.OK : EXIT.USAGE;
  }
  if (MINING.has(sub)) {
    const { runMineCli } = await import('@dnr/trial');
    const code = await runMineCli(argv);
    return code === 2 ? EXIT.DEPENDENCY : code;
  }
  if (LATER.has(sub)) {
    io.err(`DNR: \`dnr trial ${sub}\` is not built yet (it belongs to a later build wave).\n`);
    return EXIT.DEPENDENCY;
  }
  io.err(`DNR: unknown trial subcommand ${sub}\n`);
  return EXIT.USAGE;
}
