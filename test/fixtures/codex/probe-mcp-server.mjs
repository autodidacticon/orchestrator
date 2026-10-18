#!/usr/bin/env node
// Reconstructed probe MCP server (see README.md): one `echo` tool over stdio, used to check how
// `codex exec` registers, starts, and approves an MCP server. Writes its environment to
// $PROBE_OUT when set, so a probe can see what the server child receives.
import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

if (process.env.PROBE_OUT) writeFileSync(process.env.PROBE_OUT, JSON.stringify(process.env, null, 2));
const server = new McpServer({ name: 'probe', version: '0' });
server.registerTool('echo', { description: 'Echo the text back.', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text }] }));
await server.connect(new StdioServerTransport());
