import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDaemon, stopDaemon } from '../../src/runs/lifecycle.js';
import { makeRepo, tsxLoader } from './harness.js';

// The work verdict per runner kind over the wire (GH-192). See specs/operator-control "Status report: work verdict per kind",
// "Status report: work verdict without a graph" and specs/operator-mcp "Wait digest: workByKind".

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '../../src/operator/mcp.ts');

let client: Client | undefined;
const daemons: Array<{ repo: string; env: NodeJS.ProcessEnv }> = [];
const dirs: string[] = [];

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = undefined;
  for (const d of daemons.splice(0)) await stopDaemon({ ...d, reap: true }).catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function http(url: string, method: 'GET' | 'POST' | 'PUT', route: string, body?: unknown) {
  const res = await fetch(`${url}${route}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = (await client!.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

const IDLE = { verdict: 'idle', claimable: 0, preparing: 0, working: 0 };
const PAUSED = { ...IDLE, verdict: 'paused' };

/** The three views of workByKind: GET /v1/status, the digest of GET /v1/events, and the digest of the wait tool. */
async function views(url: string) {
  const status = (await http(url, 'GET', '/v1/status')).body['workByKind'];
  const events = ((await http(url, 'GET', '/v1/events?after=0&limit=1')).body['digest'] as Record<string, unknown>)['workByKind'];
  const wait = ((await tool('wait', { timeoutMs: 200 }))['digest'] as Record<string, unknown>)['workByKind'];
  return { status, events, wait };
}

describe('workByKind over HTTP and the wait tool', () => {
  it('without a graph every kind is idle, paused after POST /v1/pause; with a graph the three views agree', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-verdict-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-verdict-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), ['checkCommand: "true"', 'tickIntervalMs: 150', 'leaseTtlMs: 60000', 'runner: { mode: pull, claimWindowMs: 600000, confirmProfile: false }'].join('\n'));
    const env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    daemons.push({ repo, env });
    const started = await startDaemon({ repo, env });
    expect(started.started).toBe(true);
    const url = started.url!;
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));

    // Before a graph is loaded.
    expect((await http(url, 'GET', '/v1/status')).body['error']).toBe('graph not loaded');
    let v = await views(url);
    const idle = { 'claude-code': IDLE, codex: IDLE, opencode: IDLE };
    expect(v).toEqual({ status: idle, events: idle, wait: idle });

    expect((await http(url, 'POST', '/v1/pause')).status).toBe(200);
    v = await views(url);
    const paused = { 'claude-code': PAUSED, codex: PAUSED, opencode: PAUSED };
    expect(v).toEqual({ status: paused, events: paused, wait: paused });
    expect((await http(url, 'POST', '/v1/resume')).status).toBe(200);

    // With a graph: one claude-code task and one codex task parked.
    const content = 'nodes:\n  - { id: T1, deps: [], description: d, acceptanceCriteria: [a] }\n  - { id: T2, deps: [], runner: codex, description: d, acceptanceCriteria: [a] }\n';
    expect((await http(url, 'PUT', '/v1/graph', { content })).status).toBe(200);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && ((await http(url, 'GET', '/v1/status')).body['claimable'] as string[] | undefined)?.length !== 2) await new Promise((r) => setTimeout(r, 100));
    v = await views(url);
    const parked = { 'claude-code': { ...IDLE, verdict: 'claim', claimable: 1 }, codex: { ...IDLE, verdict: 'claim', claimable: 1 }, opencode: IDLE };
    expect(v).toEqual({ status: parked, events: parked, wait: parked });
  }, 120_000);
});
