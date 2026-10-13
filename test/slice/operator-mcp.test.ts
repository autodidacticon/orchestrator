import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { clampWait, digestSatisfies, TOOL_NAMES, WAIT_CAP_MS, WAIT_DEFAULT_MS } from '../../src/operator/mcp-server.js';
import { listRuns, stopDaemon } from '../../src/runs/lifecycle.js';
import { gitIn, makeRepo, scriptedAgent, tsxLoader } from './harness.js';

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

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = undefined;
  if (env) for (const r of await listRuns(env)) if (r.alive && r.repo) await stopDaemon({ repo: r.repo, env, reap: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('operator MCP server', () => {
  it('clamps wait and matches digests', () => {
    expect(clampWait(undefined)).toBe(WAIT_DEFAULT_MS);
    expect(clampWait(10 * 60_000)).toBe(WAIT_CAP_MS);
    expect(clampWait(500)).toBe(500);
    expect(digestSatisfies({ openQuestions: ['T1'] }, 'question', 0)).toBe(true);
    expect(digestSatisfies({ openQuestions: [] }, 'question', 5)).toBe(false);
    expect(digestSatisfies({}, 'any', 1)).toBe(true);
    expect(digestSatisfies({ finished: true }, 'finished', 0)).toBe(true);
  });

  it('drives a run end to end over stdio: start, import, wait for a question, answer, review, accept, stop', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), [
      `runnerCommand: "node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`,
      'checkCommand: "true"', 'tickIntervalMs: 150', 'leaseTtlMs: 60000', 'retryWindowMs: 5000', 'capacity: 2',
    ].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools.tools).toHaveLength(19);

    const noDaemon = await client.callTool({ name: 'status', arguments: {} });
    expect(noDaemon.isError).toBe(true);
    expect(parse(noDaemon)['error']).toMatch(/no running daemon.*start/);

    const started = await tool('start');
    expect(started).toMatchObject({ status: 200, started: true });
    expect(String(started['runDir']).startsWith(home)).toBe(true);
    expect((await tool('start'))['started']).toBe(false);

    const imported = await tool('import_graph', {
      content: ['nodes:',
        '  - { id: T1, deps: [], behavior: "blockAndWait:pick", description: d, acceptanceCriteria: [a] }',
        '  - { id: T2, deps: [T1], behavior: commitAndSubmit, description: d, acceptanceCriteria: [b] }',
        '  - { id: MVP, kind: milestone, gated: true, deps: [T2] }', ''].join('\n'),
    });
    expect(imported).toMatchObject({ status: 200, accepted: true });

    const q = await tool('wait', { afterSeq: 0, until: 'question', timeoutMs: 30_000 });
    expect(q).toMatchObject({ matched: true, until: 'question' });
    expect((q['digest'] as Record<string, unknown>)['openQuestions']).toEqual(['T1']);
    expect((q['events'] as unknown[]).length).toBeGreaterThan(0);

    expect(await tool('answer', { task: 'T1', text: 'b' })).toMatchObject({ status: 200, ok: true });
    const rv = await tool('wait', { afterSeq: q['seq'] as number, until: 'review', timeoutMs: 60_000 });
    expect(rv).toMatchObject({ matched: true });
    expect((rv['digest'] as Record<string, unknown>)['awaitingReview']).toEqual(['MVP']);

    const bundle = await tool('review', { milestone: 'MVP' });
    expect(bundle).toMatchObject({ status: 200, milestone: 'MVP', reviewVersion: 1, tag: 'milestone/MVP/v1' });
    expect((bundle['closure'] as Array<{ taskId: string }>).map((c) => c.taskId).sort()).toEqual(['T1', 'T2']);
    expect(await tool('accept', { milestone: 'MVP', sha: bundle['integrationSha'], version: 1 })).toMatchObject({ ok: true });
    const fin = await tool('wait', { afterSeq: rv['seq'] as number, until: 'finished', timeoutMs: 20_000 });
    expect(fin).toMatchObject({ matched: true });
    expect((fin['digest'] as Record<string, unknown>)['finished']).toBe(true);

    const quick = await tool('wait', { timeoutMs: 400, until: 'stalled' });
    expect(quick).toMatchObject({ matched: false, events: [] });

    const status = await tool('status');
    expect(status).toMatchObject({ finished: true, byStatus: { done: ['T1', 'T2', 'MVP'] } });
    expect(gitIn(repo, 'show', 'main:T1.txt')).toBe('answer: b');
    const trailers = gitIn(repo, 'log', '--first-parent', '--format=%(trailers:key=Orchestrator-Task,valueonly)', 'main').split('\n').filter(Boolean);
    expect(trailers.sort()).toEqual(['T1', 'T2']);
    expect(gitIn(repo, 'rev-parse', 'milestone/MVP/v1^{commit}')).toBe(bundle['integrationSha']);
    const runs = await tool('runs');
    expect((runs['runs'] as Array<{ repo: string; alive: boolean }>)).toMatchObject([{ repo, alive: true }]);

    expect(await tool('stop')).toMatchObject({ status: 200, stopped: true });
    const after = await client.callTool({ name: 'status', arguments: {} });
    expect(after.isError).toBe(true);
  }, 120_000);

  it('records the tracker at import and drives the outbox: list, ack with a result, ack with an error, local argument error', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), [
      `runnerCommand: "node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`,
      'checkCommand: "true"', 'tickIntervalMs: 150', 'leaseTtlMs: 60000', 'retryWindowMs: 5000', 'capacity: 2',
    ].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    await tool('start');

    const imported = await tool('import_issues', {
      root: 'E-1',
      issues: [
        { id: 'E-1', title: 'Epic', state: 'open', url: 'https://tracker.example/E-1' },
        { id: 'E-2', title: 'A', parent: 'E-1', state: 'open', description: 'Build A.\n\n## Acceptance criteria\n- works', url: 'https://tracker.example/E-2' },
      ],
      tracker: { kind: 'linear', workspace: 'acme' },
    });
    expect(imported).toMatchObject({ status: 200, accepted: true });
    expect((await tool('status'))['tracker']).toMatchObject({ kind: 'linear', workspace: 'acme' });

    let effects: Array<{ id: number; taskId: string; kind: string; payload: Record<string, unknown> }> = [];
    for (let i = 0; i < 100 && effects.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 100));
      effects = (await tool('outbox'))['effects'] as typeof effects;
    }
    expect(effects.map((e) => [e.taskId, e.kind, e.payload['state']])).toEqual([
      ['E-2', 'setState', 'inProgress'],
      ['E-1', 'setState', 'inProgress'],
    ]);
    const [first, second] = effects;
    expect(await tool('ack', { id: first!.id, result: { stateId: 'st-1' } })).toMatchObject({ status: 200, ok: true, effect: { status: 'applied', result: { stateId: 'st-1' } } });
    expect(await tool('ack', { id: second!.id, error: 'rate limited' })).toMatchObject({ status: 200, effect: { status: 'pending', attempts: 1, error: 'rate limited' } });
    const neither = await client.callTool({ name: 'ack', arguments: { id: second!.id } });
    expect(neither.isError).toBe(true);
    expect(parse(neither)['error']).toMatch(/exactly one of result or error/);
    const both = await client.callTool({ name: 'ack', arguments: { id: second!.id, result: {}, error: 'x' } });
    expect(both.isError).toBe(true);
    expect(((await tool('outbox', { after: first!.id, limit: 10 }))['effects'] as Array<{ id: number }>).map((e) => e.id)).toEqual([second!.id]);
    expect(await tool('stop', { reap: true })).toMatchObject({ status: 200, stopped: true });
  }, 60_000);
});
