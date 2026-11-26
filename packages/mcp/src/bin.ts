// Standalone stdio entry (used by the SDK integration test): `node --import tsx packages/mcp/src/bin.ts`.
import { runMcpStdio } from './server';

await runMcpStdio({ cwd: process.cwd() });
