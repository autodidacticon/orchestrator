import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { clampWait, digestSatisfies, TOOL_NAMES, WAIT_CAP_MS, WAIT_DEFAULT_MS } from '../../src/operator/mcp-server.js';
import { listRuns, stopDaemon } from '../../src/runs/lifecycle.js';
import { pidAlive } from '../../src/runner/subprocess.js';
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
      'runner: { mode: spawn }',
      'checkCommand: "true"', 'tickIntervalMs: 150', 'leaseTtlMs: 60000', 'retryWindowMs: 5000', 'capacity: 2',
    ].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools.tools).toHaveLength(31);
    const configure = tools.tools.find((t) => t.name === 'configure');
    expect(Object.keys((configure?.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(['allowedTools', 'capacity', 'checkCommand', 'effort', 'model', 'runnerCommand']);

    const noDaemon = await client.callTool({ name: 'status', arguments: {} });
    expect(noDaemon.isError).toBe(true);
    expect(parse(noDaemon)['error']).toMatch(/no running daemon.*start/);

    const started = await tool('start');
    expect(started).toMatchObject({ status: 200, started: true });
    expect(String(started['runDir']).startsWith(home)).toBe(true);
    expect((await tool('start'))['started']).toBe(false);
    // The start result says what was resolved; configure forwards refusals unchanged. See specs/operator-mcp "Start tool" and "Configure tool".
    expect(started['config']).toMatchObject({ checkCommand: { value: 'true', source: 'file' }, capacity: { value: 2, source: 'file' }, integrationBranch: { value: 'main', source: 'detected' } });
    expect(started['needsConfig']).toEqual([]);
    expect(started['toolchain']).toMatchObject({ kinds: [] });
    const refused = await client.callTool({ name: 'configure', arguments: { capacity: 0 } });
    expect(refused.isError).toBe(true);
    expect(parse(refused)).toMatchObject({ status: 400, key: 'capacity' });
    expect(await tool('configure', { capacity: 3 })).toMatchObject({ status: 200, ok: true, applied: ['capacity'], config: { capacity: { value: 3, source: 'argument' } } });
    expect(await tool('configure', { capacity: null })).toMatchObject({ status: 200, ok: true, config: { capacity: { value: 2, source: 'file' } } });
    expect((await tool('status'))['config']).toMatchObject({ capacity: { value: 2, source: 'file' } });
    // See specs/operator-mcp "Configure tool" (model) and "Start tool" (effort).
    expect(await tool('configure', { model: 'claude-sonnet-5-5' })).toMatchObject({ status: 200, ok: true, applied: ['model'], config: { model: { value: 'claude-sonnet-5-5', source: 'argument', applied: false } } });
    expect(await tool('start', { effort: 'high' })).toMatchObject({ started: false, applied: ['effort'], config: { effort: { value: 'high', source: 'argument', applied: false }, model: { value: 'claude-sonnet-5-5', source: 'argument' } } });
    expect(await tool('configure', { model: null, effort: null })).toMatchObject({ status: 200, ok: true, config: { model: { value: 'claude-opus-5-5', source: 'default' }, effort: { value: 'medium', source: 'default' } } });

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
    expect(parse(after)['error']).toMatch(/stopped at .*start/);
    expect((await listRuns(env)).find((r) => r.repo === repo)).toMatchObject({ alive: false, exit: { reason: 'stop' } });
  }, 120_000);

  it('defaults a plugin-started run to pull, yields to a configured mode, and leaves a running daemon alone', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), ['checkCommand: "true"', 'tickIntervalMs: 150', 'leaseTtlMs: 60000', 'capacity: 2'].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    const started = await tool('start');
    expect(started).toMatchObject({ status: 200, started: true, mode: 'pull' });
    expect(await tool('import_graph', { content: 'nodes:\n  - { id: T1, deps: [], description: d, acceptanceCriteria: [a] }\n' })).toMatchObject({ accepted: true });
    for (let i = 0; i < 50 && ((await tool('status'))['claimable'] as string[]).length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect((await tool('status'))['claimable']).toEqual(['T1']);
    expect(await tool('start')).toMatchObject({ started: false, mode: 'pull' });
    expect((await tool('status'))['runner']).toMatchObject({ mode: 'pull' });
    // The session's attachment is registered and shows in status with the server's pid first.
    const attachments = (await tool('status'))['attachments'] as Array<{ id: string; pids: number[]; launches: string[] }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.pids.length).toBeGreaterThanOrEqual(2);
    // A claim through the tool carries the attachment; ending it through the route flags the next call and the server registers again.
    const claimed = await tool('claim', { workerId: 'w1' });
    expect(claimed).toMatchObject({ status: 200, taskId: 'T1' });
    const url = String(started['url']);
    const launchesOf = async () => ((await tool('status'))['attachments'] as Array<{ id: string; launches: string[] }>);
    expect((await launchesOf())[0]!.launches).toEqual([claimed['launchId']]);
    const first = attachments[0]!.id;
    await fetch(`${url}/v1/attachments/${first}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'test' }) });
    const flagged = await fetch(`${url}/v1/status`, { headers: { 'x-orch-attachment': first } });
    expect(flagged.headers.get('x-orch-attachment')).toBe('unknown');
    // The ended attachment's launch is handed back at no cost and parked again. Raw polls: a tool call would register the
    // server again first, and a live attachment keeps its launches.
    for (let i = 0; i < 50; i++) {
      const s = (await (await fetch(`${url}/v1/status`)).json()) as { claimable: string[] };
      if (s.claimable.includes('T1')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await tool('status')).toMatchObject({ status: 200, claimable: ['T1'] }); // sees the unknown flag and registers again
    const again = (await tool('status'))['attachments'] as Array<{ id: string; launches: string[] }>;
    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe(first); // the same server re-registers its own id
    expect(again[0]!.launches).toEqual([]);
    // The next claim carries the fresh attachment.
    const second = await tool('claim', { workerId: 'w1' });
    expect(second).toMatchObject({ status: 200, taskId: 'T1', repeated: false });
    expect(second['launchId']).not.toBe(claimed['launchId']);
    expect((await launchesOf())[0]!.launches).toEqual([second['launchId']]);
    // Closing the transport ends the attachment; the daemon releases the launch within a tick.
    await client.close();
    client = undefined;
    const deadline = Date.now() + 10_000;
    for (;;) {
      const s = await fetch(`${url}/v1/status`).then((r) => r.json() as Promise<Record<string, unknown>>);
      // The attachment is gone and T1's launch was handed back untouched: parked again for the next worker.
      if ((s['attachments'] as unknown[]).length === 0 && (s['claimable'] as string[]).includes('T1')) break;
      if (Date.now() > deadline) throw new Error(`attachment not released: ${JSON.stringify(s['attachments'])}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    await stopDaemon({ repo, env, reap: true });

    const configured = realpathSync(makeRepo(mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'))));
    dirs.push(path.dirname(configured));
    writeFileSync(path.join(configured, 'orchestrator.yaml'), ['checkCommand: "true"', 'runner: { mode: spawn }'].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: configured };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    expect(await tool('start')).toMatchObject({ started: true, mode: 'spawn' });
  }, 120_000);

  it('revives the daemon after an idle exit and refuses after a stop', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), ['checkCommand: "true"', 'tickIntervalMs: 100', 'daemon: { idleExitMs: 800, exitWhileAttached: true }'].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    const started = await tool('start');
    expect(started).toMatchObject({ status: 200, started: true });
    const pid = Number(started['pid']);
    const deadline = Date.now() + 15_000;
    while (pidAlive(pid)) {
      if (Date.now() > deadline) throw new Error('daemon did not exit idle');
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await tool('runs'))['runs']).toMatchObject([{ repo, alive: false, exit: { reason: 'idle' } }]);
    const revived = await tool('status');
    expect(revived).toMatchObject({ status: 200 });
    expect((await tool('runs'))['runs']).toMatchObject([{ repo, alive: true }]);
    expect(await tool('stop')).toMatchObject({ stopped: true });
    const refused = await client.callTool({ name: 'status', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(parse(refused)['error']).toMatch(/stopped at .*start/);
    expect((await tool('runs'))['runs']).toMatchObject([{ repo, alive: false, exit: { reason: 'stop' } }]);
  }, 60_000);

  it('records the tracker at import and drives the outbox: list, ack with a result, ack with an error, local argument error', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), [
      `runnerCommand: "node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`,
      'runner: { mode: spawn }',
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

  it('reopen refuses with blockers then cascades; proposals are listed, accepted with a node id, and rejected', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), [
      `runnerCommand: "node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`,
      'runner: { mode: spawn }',
      'checkCommand: "true"', 'tickIntervalMs: 150', 'leaseTtlMs: 60000', 'retryWindowMs: 5000', 'capacity: 3',
    ].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    await tool('start');
    expect(await tool('import_graph', {
      content: ['nodes:',
        '  - { id: T1, deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }',
        '  - { id: T2, deps: [T1], behavior: hang, description: d, acceptanceCriteria: [a] }',
        '  - { id: T3, deps: [], behavior: "proposeThenSubmit:2", description: d, acceptanceCriteria: [a] }', ''].join('\n'),
    })).toMatchObject({ accepted: true });
    const by = (s: Record<string, unknown>, k: string): string[] => ((s['byStatus'] as Record<string, string[]>)[k] ?? []);
    const until = async (pred: (s: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 200; i++) {
        const s = await tool('status');
        if (pred(s)) return s;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('condition not reached');
    };
    await until((s) => by(s, 'running').includes('T2') && by(s, 'done').includes('T3'));

    const refused = await client.callTool({ name: 'reopen', arguments: { task: 'T1' } });
    expect(refused.isError).toBe(true);
    expect(parse(refused)).toMatchObject({ status: 409, blockers: ['T2'] });
    const cascaded = await tool('reopen', { task: 'T1', cascade: true });
    expect(cascaded).toMatchObject({ status: 200, ok: true });
    expect((cascaded['reset'] as Array<{ id: string }>).map((r) => r.id).sort()).toEqual(['T1', 'T2']);

    const listed = await tool('proposals');
    expect((listed['proposals'] as Array<{ id: string; status: string }>).map((p) => [p.id, p.status])).toEqual([['T3-p1', 'pending'], ['T3-p2', 'pending']]);
    const accepted = await tool('accept_proposal', { id: 'T3-p1', nodeId: 'ENG-9' });
    expect(accepted).toMatchObject({ status: 200, ok: true, nodeId: 'ENG-9', accepted: true });
    expect(await tool('reject_proposal', { id: 'T3-p2', note: 'later' })).toMatchObject({ status: 200, ok: true });
    const status = await until((s) => by(s, 'done').includes('ENG-9'));
    expect(status['proposals']).toEqual([]);
    expect(by(status, 'done')).toEqual(expect.arrayContaining(['T3', 'ENG-9']));
    expect(await tool('stop', { reap: true })).toMatchObject({ status: 200, stopped: true });
  }, 90_000);

  it('wait returns on a stuck flag and nudge reaches the launch', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), [
      `runnerCommand: "node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`,
      'runner: { mode: spawn }',
      'checkCommand: "true"', 'tickIntervalMs: 150', 'leaseTtlMs: 60000', 'retryWindowMs: 5000', 'capacity: 2',
      'health:', '  stuckAfterMs: 1500', '  stuckFailAfterMs: 0',
    ].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    await tool('start');
    expect(await tool('import_graph', { content: 'nodes:\n  - { id: T1, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }\n' })).toMatchObject({ accepted: true });
    const t0 = Date.now();
    const w = await tool('wait', { afterSeq: 0, until: 'any', timeoutMs: 20_000 });
    expect(w).toMatchObject({ matched: true });
    let digest = w['digest'] as Record<string, unknown>;
    let seq = w['seq'] as number;
    while (!(digest['stuck'] as string[]).includes('T1') && Date.now() - t0 < 20_000) {
      const n = await tool('wait', { afterSeq: seq, until: 'any', timeoutMs: 10_000 });
      digest = n['digest'] as Record<string, unknown>;
      seq = n['seq'] as number;
    }
    expect(digest['stuck']).toEqual(['T1']);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(await tool('nudge', { task: 'T1', message: 'commit what you have' })).toMatchObject({ status: 200, ok: true });
    const status = await tool('status');
    expect(status).toMatchObject({ stuck: ['T1'], paused: false });
    expect((status['liveLaunches'] as Array<Record<string, unknown>>)[0]).toMatchObject({ taskId: 'T1', stuck: true });
    expect(await tool('stop', { reap: true })).toMatchObject({ status: 200, stopped: true });
  }, 60_000);
});
