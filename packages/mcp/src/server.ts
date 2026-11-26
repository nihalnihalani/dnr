/** `dnr mcp`: the read-only MCP stdio server (§12.4). */

import { openContext } from '@dnr/hook';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { explainFunction, listOrdersForFile } from './tools';

export const MCP_VERSION = '0.1.0';

export function createDnrMcpServer(opts: { cwd: string; env?: NodeJS.ProcessEnv }): McpServer {
  const env = opts.env ?? process.env;
  const server = new McpServer({ name: 'dnr', version: MCP_VERSION });
  const ctx = async () => {
    const c = await openContext(opts.cwd, env);
    if (!c) throw new Error(`DNR: ${opts.cwd} is not inside a git repository`);
    return c;
  };
  const text = (v: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(v) }],
    structuredContent: v as Record<string, unknown>,
  });
  server.registerTool(
    'explain_function',
    {
      title: 'Explain a function',
      description:
        'Before editing a function, ask whether a DNR order covers it: a change that was tried and reverted. Returns each order with its effective status, the reason it was reverted, and links. Read-only.',
      inputSchema: {
        file: z.string().min(1).describe('repo-relative file path'),
        qualname: z.string().min(1).describe('qualified name, e.g. Query.clear_ordering'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ file, qualname }) => text(await explainFunction(await ctx(), { file, qualname })),
  );
  server.registerTool(
    'list_orders_for_file',
    {
      title: 'List DNR orders for a file',
      description:
        'Lists the DNR orders that cover any function in a file, with the covered qualified names and the reason. Read-only.',
      inputSchema: { file: z.string().min(1).describe('repo-relative file path') },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ file }) => text(await listOrdersForFile(await ctx(), { file })),
  );
  return server;
}

export async function runMcpStdio(opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<void> {
  const server = createDnrMcpServer(opts);
  await server.connect(new StdioServerTransport());
}
