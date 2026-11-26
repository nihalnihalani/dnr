/** @dnr/mcp: read-only MCP server with `explain_function` and `list_orders_for_file` (§12.4). */
export { createDnrMcpServer, MCP_VERSION, runMcpStdio } from './server';
export { type ExplainResult, explainFunction, type ListResult, listOrdersForFile } from './tools';
