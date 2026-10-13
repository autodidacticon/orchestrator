import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ApiServer } from '../../src/agent/server.js';
import { TOOL_NAMES } from '../../src/agent/mcp-shim.js';
import { gitIn, makeSlice, single, tsxLoader, type SliceHarness } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const shim = path.resolve(here, '../../src/agent/mcp-shim.ts');

let h: SliceHarness | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = undefined;
  await h?.cleanup();
  h = undefined;
});

function parse(r: unknown): Record<string, unknown> {
  const content = (r as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe('MCP shim', () => {
  it('exposes five tools, forwards with the launch token, and retries through a daemon restart', async () => {
    h = await makeSlice({ graph: single('hang'), config: { leaseTtlMs: 60_000 } });
    await h.orch.tick();
    const l = h.launchOf('T1');
    client = new Client({ name: 'test', version: '0' });
    const transport = new StdioClientTransport({
      command: 'node',
      args: ['--import', tsxLoader, shim],
      env: { ...(process.env as Record<string, string>), ORCH_API: h.orch.apiBaseUrl, ORCH_LAUNCH_ID: l.launchId, ORCH_TOKEN: l.token, ORCH_RETRY_WINDOW_MS: '8000' },
      stderr: 'pipe',
    });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());

    const hb = parse(await client.callTool({ name: 'heartbeat', arguments: { progress: 'hi' } }));
    expect(hb).toMatchObject({ status: 200, ok: true });
    expect(h.store.listEvents({ kind: 'agent.heartbeat' })[0]?.payload).toEqual({ progress: 'hi' });

    // a payload edit to the running task reaches the agent through the inbox tool
    h.source.set(single('hang', ', title: "renamed"'));
    await h.orch.tick();
    const inbox = parse(await client.callTool({ name: 'inbox', arguments: {} }));
    expect(inbox).toMatchObject({ status: 200, notices: [{ kind: 'payloadChanged', rev: h.orch.graph().rev }] });

    // restart the server on the same port while a call is in flight
    const port = h.server.port;
    await h.server.close();
    const pending = client.callTool({ name: 'log', arguments: { text: 'during restart', seq: 1 } });
    await new Promise((r) => setTimeout(r, 400));
    const server2 = new ApiServer(h.orch);
    await server2.listen(port);
    expect(parse(await pending)).toMatchObject({ status: 200, ok: true });
    expect(h.store.listEvents({ kind: 'agent.log' })[0]?.payload).toEqual({ text: 'during restart' });

    gitIn(l.worktree, 'commit', '-q', '--allow-empty', '-m', 'work');
    const rep = parse(await client.callTool({ name: 'report', arguments: { seq: 2, kind: 'submit', summary: 'via mcp' } }));
    expect(rep).toMatchObject({ status: 200, accepted: true });
    expect(h.orch.entry('T1').status.kind).toBe('submitted');
    await server2.close();
  }, 30_000);
});
