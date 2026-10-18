import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ApiServer } from '../../src/agent/server.js';
import { TOOL_NAMES } from '../../src/agent/mcp-shim.js';
import { formatEnvFile } from '../../src/runner/shim-command.js';
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

  // See specs/worker-runners "Sandbox and commit policy".
  it('the report tool states the committed, clean worktree requirement only when the agent commits', async () => {
    const descriptions: Record<string, string> = {};
    for (const policy of ['unset', 'agent', 'daemon']) {
      const c = new Client({ name: 'test', version: '0' });
      const env: Record<string, string> = { ...(process.env as Record<string, string>), ORCH_API: 'http://127.0.0.1:1', ORCH_LAUNCH_ID: 'l', ORCH_TOKEN: 't' };
      delete env['ORCH_COMMIT_POLICY'];
      if (policy !== 'unset') env['ORCH_COMMIT_POLICY'] = policy;
      await c.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, shim], env, stderr: 'pipe' }));
      try {
        descriptions[policy] = (await c.listTools()).tools.find((t) => t.name === 'report')?.description ?? '';
      } finally {
        await c.close().catch(() => undefined);
      }
    }
    expect(descriptions['unset']).toContain('committed, clean worktree');
    expect(descriptions['agent']).toContain('committed, clean worktree');
    expect(descriptions['daemon']).not.toContain('committed, clean worktree');
    expect(descriptions['daemon']).toContain('the orchestrator commits');
  }, 30_000);

  // See specs/agent-protocol "Launch token scoping": the Codex runner passes the token in a 0600 file named on argv.
  it('started with --orch-env-file, forwards with the token from the file', async () => {
    h = await makeSlice({ graph: single('hang'), config: { leaseTtlMs: 60_000 } });
    await h.orch.tick();
    const l = h.launchOf('T1');
    const file = path.join(l.worktree, '.orchestrator', 'shim.env');
    writeFileSync(file, formatEnvFile({ ORCH_API: h.orch.apiBaseUrl, ORCH_LAUNCH_ID: l.launchId, ORCH_TOKEN: l.token, ORCH_RETRY_WINDOW_MS: '8000' }));
    chmodSync(file, 0o600);
    const env = { ...(process.env as Record<string, string>) };
    for (const k of ['ORCH_API', 'ORCH_LAUNCH_ID', 'ORCH_TOKEN', 'ORCH_RETRY_WINDOW_MS']) delete env[k];
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, shim, '--orch-env-file', file], env, stderr: 'pipe' }));
    expect(parse(await client.callTool({ name: 'heartbeat', arguments: { progress: 'from env file' } }))).toMatchObject({ status: 200, ok: true });
    expect(h.store.listEvents({ kind: 'agent.heartbeat' })[0]?.payload).toEqual({ progress: 'from env file' });
  }, 30_000);

  it('fails fast naming the env file when it is missing', () => {
    const missing = path.join(here, 'no-such-dir', 'shim.env');
    const r = spawnSync('node', ['--import', tsxLoader, shim, '--orch-env-file', missing], { encoding: 'utf8', input: '', timeout: 20_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`--orch-env-file ${missing}: cannot read the shim env file (ENOENT)`);
  }, 30_000);
});