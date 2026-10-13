import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOL_NAMES } from '../../src/operator/mcp-server.js';
import { listRuns, stopDaemon } from '../../src/runs/lifecycle.js';
import { gitIn, makeRepo, tsxLoader } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '../../src/operator/mcp.ts');

let dirs: string[] = [];
let client: Client | undefined;
let env: Record<string, string>;

function parse(r: unknown): Record<string, unknown> {
  const content = (r as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}
async function tool(name: string, args: Record<string, unknown> = {}) {
  return parse(await client!.callTool({ name, arguments: args }));
}
const by = (s: Record<string, unknown>, k: string): string[] => ((s['byStatus'] as Record<string, string[]>)[k] ?? []);
async function until(pred: (s: Record<string, unknown>) => boolean, tries = 200): Promise<Record<string, unknown>> {
  for (let i = 0; i < tries; i++) {
    const s = await tool('status');
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition not reached');
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = undefined;
  if (env) for (const r of await listRuns(env)) if (r.alive && r.repo) await stopDaemon({ repo: r.repo, env, reap: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('worker tools on the operator MCP server', () => {
  it('a session acts as the worker: start in pull mode, claim, block until pending and collect the answer, report after a dirty 409, release, fenced after release, mode switch', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), ['checkCommand: "true"', 'tickIntervalMs: 150', 'leaseTtlMs: 60000', 'capacity: 2'].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo, ORCH_WAIT_CAP_MS: '2000' };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools.tools).toHaveLength(30);

    const started = await tool('start', { mode: 'pull' });
    expect(started).toMatchObject({ status: 200, started: true, mode: 'pull' });
    expect(await tool('import_graph', { content: 'nodes:\n  - { id: T1, deps: [], description: d, acceptanceCriteria: [works] }\n  - { id: T2, deps: [T1], description: d, acceptanceCriteria: [works] }\n' })).toMatchObject({ accepted: true });
    const s0 = await until((s) => (s['claimable'] as string[]).includes('T1'));
    expect(s0).toMatchObject({ runner: { mode: 'pull' }, claimable: ['T1'], workers: [] });

    const c = await tool('claim', { workerId: 'w1' });
    expect(c).toMatchObject({ status: 200, taskId: 'T1', workerId: 'w1' });
    const launchId = String(c['launchId']);
    const token = String(c['token']);
    const worktree = String(c['worktree']);
    expect((c['brief'] as { acceptanceCriteria: string[] }).acceptanceCriteria).toEqual(['works']);
    expect((await tool('status'))['workers']).toMatchObject([{ id: 'w1', taskId: 'T1', launchId }]);
    expect(await tool('launch_log', { launchId, token, text: 'claimed' })).toMatchObject({ status: 200, ok: true });
    expect(await tool('launch_inbox', { launchId, token })).toMatchObject({ status: 200, notices: [] });

    const t0 = Date.now();
    const pending = await tool('launch_block', { launchId, token, seq: 1, kind: 'needsDecision', message: 'which?' });
    expect(pending).toMatchObject({ status: 200, pending: true, seq: 1 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    await until((s) => (s['openQuestions'] as string[]).includes('T1'));
    expect(await tool('answer', { task: 'T1', text: 'this one' })).toMatchObject({ ok: true });
    const answered = await tool('launch_block', { launchId, token, seq: 1, kind: 'needsDecision', message: 'which?' });
    expect(answered).toMatchObject({ status: 200, answer: 'this one' });

    writeFileSync(path.join(worktree, 'T1.txt'), 'done\n');
    const dirty = await client.callTool({ name: 'launch_report', arguments: { launchId, token, seq: 2, kind: 'submit', summary: 'T1 done', acceptance: [{ criterion: 'works', evidence: 'yes' }] } });
    expect(dirty.isError).toBe(true);
    expect(parse(dirty)).toMatchObject({ status: 409, error: 'dirtyWorktree', files: ['T1.txt'] });
    gitIn(worktree, 'add', '-A');
    gitIn(worktree, 'commit', '-q', '-m', 'T1');
    expect(await tool('launch_report', { launchId, token, seq: 2, kind: 'submit', summary: 'T1 done', acceptance: [{ criterion: 'works', evidence: 'yes' }] })).toMatchObject({ status: 200, accepted: true, outcome: 'submitted' });
    await until((s) => by(s, 'done').includes('T1'));
    // The launch ends once its report is accepted and published; the token is fenced from then on.
    await until((s) => (s['workers'] as unknown[]).length === 0);
    const late = await client.callTool({ name: 'launch_log', arguments: { launchId, token, text: 'late', seq: 3 } });
    expect(late.isError).toBe(true);
    const trailers = gitIn(repo, 'log', '--first-parent', '--format=%(trailers:key=Orchestrator-Task,valueonly)', 'main').split('\n').filter(Boolean);
    expect(trailers).toEqual(['T1']);

    await until((s) => (s['claimable'] as string[]).includes('T2'));
    const c2 = await tool('claim', { workerId: 'w2' });
    expect(c2).toMatchObject({ taskId: 'T2' });
    // Any API call under the token counts as progress, so release before touching anything.
    expect(await tool('release', { launchId: String(c2['launchId']), reason: 'not now' })).toMatchObject({ status: 200, outcome: 'unstarted', progressed: false });
    const fenced = await client.callTool({ name: 'launch_heartbeat', arguments: { launchId: String(c2['launchId']), token: String(c2['token']) } });
    expect(fenced.isError).toBe(true);
    expect(parse(fenced)['status']).toBe(401);

    const switched = await tool('start', { mode: 'spawn' });
    expect(switched).toMatchObject({ started: false, mode: 'spawn' });
    expect((await tool('status'))['runner']).toMatchObject({ mode: 'spawn' });
    expect(await tool('stop', { reap: true })).toMatchObject({ status: 200, stopped: true });
  }, 90_000);
});
