import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envFor, type Fixture, revertFixture } from '../../hook/test/helpers';

let fx: Fixture;
let client: Client;
const root = fileURLToPath(new URL('../../..', import.meta.url));

beforeAll(async () => {
  fx = await revertFixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      pathToFileURL(createRequire(`${root}/package.json`).resolve('tsx')).href,
      fileURLToPath(new URL('../src/bin.ts', import.meta.url)),
    ],
    cwd: fx.repo.dir,
    env: { ...(envFor(fx.repo) as Record<string, string>), NODE_PATH: `${root}/node_modules` },
    stderr: 'pipe',
  });
  client = new Client({ name: 'dnr-test', version: '0.0.0' });
  await client.connect(transport);
}, 30_000);
afterAll(async () => {
  await client?.close();
  fx?.repo.cleanup();
});

function payload(r: unknown): Record<string, unknown> {
  const c = (r as { content: Array<{ type: string; text: string }> }).content[0];
  return JSON.parse(c?.text ?? '{}');
}

describe('mcp', () => {
  it('P12-04: the stdio server lists exactly the two read-only tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['explain_function', 'list_orders_for_file']);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it('P12-04: explain_function returns {orders:[{id, effective_status, reason, links}]} and never A/R tokens', async () => {
    const r = await client.callTool({
      name: 'explain_function',
      arguments: { file: 'shop.py', qualname: 'total' },
    });
    const p = payload(r);
    expect(p).toEqual({
      orders: [
        { id: fx.order.id, effective_status: 'approved', reason: fx.order.reason, links: fx.order.links },
      ],
    });
    const raw = JSON.stringify(r);
    expect(raw).not.toContain('"A"');
    expect(raw).not.toContain('"R"');
    expect(raw).not.toContain('discount');
  });

  it('P12-04: list_orders_for_file returns {orders:[{id, qualnames, reason}]}', async () => {
    const r = await client.callTool({ name: 'list_orders_for_file', arguments: { file: 'shop.py' } });
    expect(payload(r)).toEqual({
      orders: [{ id: fx.order.id, qualnames: ['total'], reason: fx.order.reason }],
    });
    const none = await client.callTool({ name: 'list_orders_for_file', arguments: { file: 'notes.txt' } });
    expect(payload(none)).toEqual({ orders: [] });
  });
});
