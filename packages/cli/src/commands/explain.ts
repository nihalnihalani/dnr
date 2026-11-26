/** `dnr explain <file> <qualname>`: the CLI form of the MCP `explain_function` query (§12.4). */
import { explainFunction } from '@dnr/mcp';
import { parse } from '../args';
import { repoContext } from '../context';
import { EXIT, usage } from '../errors';
import type { CliIO } from '../io';

export async function cmdExplain(argv: string[], io: CliIO): Promise<number> {
  const { values: v, positionals } = parse(argv, {});
  if (v.help) {
    io.out('dnr explain <file> <qualname>\n');
    return EXIT.OK;
  }
  const [file, qualname] = positionals;
  if (!file || !qualname || positionals.length > 2) throw usage('dnr explain <file> <qualname>');
  const ctx = await repoContext(io);
  const r = await explainFunction(ctx, { file, qualname });
  io.out(`${JSON.stringify(r, null, 2)}\n`);
  return EXIT.OK;
}
