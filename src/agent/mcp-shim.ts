#!/usr/bin/env node
/**
 * MCP façade: a stdio MCP server exposing the five agent operations as tools
 * and forwarding them to the daemon's HTTP API with the launch token from the
 * environment. Retries through daemon restarts for the retry window.
 *
 * Env: ORCH_API, ORCH_LAUNCH_ID, ORCH_TOKEN, ORCH_RETRY_WINDOW_MS (default 120000).
 */
import path from 'node:path';
import { z } from 'zod';

export interface ShimEnv {
  api: string;
  launchId: string;
  token: string;
  retryWindowMs: number;
}

export function envFromProcess(env = process.env): ShimEnv {
  const api = env['ORCH_API'];
  const launchId = env['ORCH_LAUNCH_ID'];
  const token = env['ORCH_TOKEN'];
  if (!api || !launchId || !token) throw new Error('ORCH_API, ORCH_LAUNCH_ID and ORCH_TOKEN are required');
  return { api, launchId, token, retryWindowMs: Number(env['ORCH_RETRY_WINDOW_MS'] ?? 120_000) };
}

/** Forward one operation, retrying connection failures with backoff for the retry window. */
export async function forward(env: ShimEnv, op: string, body: Record<string, unknown>, method: 'GET' | 'POST' = 'POST'): Promise<{ status: number; body: unknown }> {
  const url = `${env.api}/v1/launches/${env.launchId}/${op}`;
  const deadline = Date.now() + env.retryWindowMs;
  let delay = 100;
  for (;;) {
    try {
      const res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    } catch (err) {
      if (Date.now() + delay > deadline) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 2000);
    }
  }
}

export const TOOL_NAMES = ['heartbeat', 'report', 'block', 'inbox', 'log'] as const;

export async function startShim(env: ShimEnv): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = new McpServer({ name: 'orchestrator-agent-api', version: '0.1.0' });
  const text = (r: { status: number; body: unknown }) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ status: r.status, ...(typeof r.body === 'object' && r.body ? (r.body as object) : { body: r.body }) }) }],
    isError: r.status >= 400,
  });

  server.registerTool('heartbeat', { description: 'Renew the lease; optionally report progress.', inputSchema: { progress: z.string().optional() } }, async (args) => text(await forward(env, 'heartbeat', args)));
  server.registerTool(
    'report',
    {
      description: 'Final report. kind=submit requires a committed, clean worktree; kind=fail gives up. seq must increase per call.',
      inputSchema: {
        seq: z.number().int().nonnegative(),
        kind: z.enum(['submit', 'fail']),
        summary: z.string().optional(),
        interfaces: z.array(z.string()).optional(),
        decisions: z.array(z.string()).optional(),
        deviations: z.array(z.string()).optional(),
        followUps: z.array(z.string()).optional(),
        tests: z.array(z.string()).optional(),
        acceptance: z.array(z.object({ criterion: z.string(), evidence: z.string() })).optional(),
        noChanges: z.object({ justification: z.string() }).optional(),
        tried: z.string().optional(),
        why: z.string().optional(),
        whatWouldUnblock: z.string().optional(),
      },
    },
    async (args) => text(await forward(env, 'report', args)),
  );
  server.registerTool(
    'block',
    {
      description: 'Ask a human a question and wait for the answer. Returns {answer} or {timeout:true}.',
      inputSchema: {
        seq: z.number().int().nonnegative(),
        kind: z.enum(['needsDecision', 'needsAccess', 'impossible', 'dependencyCancelled', 'outOfScope', 'insufficientSpec', 'milestoneRejected']),
        message: z.string(),
        options: z.array(z.string()).optional(),
      },
    },
    async (args) => text(await forward({ ...env, retryWindowMs: Math.max(env.retryWindowMs, 24 * 3600_000) }, 'block', args)),
  );
  server.registerTool('inbox', { description: 'Fetch pending notices from the orchestrator.', inputSchema: {} }, async () => text(await forward(env, 'inbox', {}, 'GET')));
  server.registerTool('log', { description: 'Append a log line to the launch log.', inputSchema: { text: z.string(), seq: z.number().int().optional() } }, async (args) => text(await forward(env, 'log', args)));

  await server.connect(new StdioServerTransport());
}

export const USAGE = `orchestrator-mcp-shim: MCP façade for an agent launch.

  orchestrator-mcp-shim

A stdio MCP server exposing heartbeat, report, block, inbox, and log, forwarded
to the daemon with the launch token. Env: ORCH_API, ORCH_LAUNCH_ID, ORCH_TOKEN,
ORCH_RETRY_WINDOW_MS. The orchestrator writes this into each launch's mcp.json.
`;

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isEntry && (process.argv.includes('--help') || process.argv.includes('-h'))) {
  process.stdout.write(USAGE);
} else if (isEntry) {
  startShim(envFromProcess()).catch((err) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
