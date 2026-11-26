import { runMcpStdio } from '@dnr/mcp';
import { EXIT } from '../errors';
import type { CliIO } from '../io';

/** `dnr mcp`: the read-only MCP stdio server (§12.4). Runs until stdin closes. */
export async function cmdMcp(argv: string[], io: CliIO): Promise<number> {
  if (argv.includes('--help')) {
    io.out('dnr mcp   MCP stdio server: explain_function, list_orders_for_file (read-only)\n');
    return EXIT.OK;
  }
  await runMcpStdio({ cwd: io.cwd, env: io.env });
  await new Promise<void>((res) => process.stdin.once('close', () => res()));
  return EXIT.OK;
}
