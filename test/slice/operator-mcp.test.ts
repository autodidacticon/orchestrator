import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { clampWait, defaultModeFor, digestSatisfies, kindOfRun, modeNoteFor, REPO_ARG_TEXT, TOOL_NAMES, WAIT_CAP_MS, WAIT_DEFAULT_MS } from '../../src/operator/mcp-server.js';
import { listRuns, startDaemon, stopDaemon } from '../../src/runs/lifecycle.js';
import { runPaths } from '../../src/runs/runDir.js';
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

/**
 * An import tool call, judged by what the daemon adopted. The import route can answer `accepted: false` with no
 * reasons when the daemon's own tick reloaded the written file alongside it and adopted it first (product defect,
 * reproduced by test/slice/import-reload-race.test.ts; openspec/changes/suite-flake-causes). Such an answer counts
 * as accepted only once the daemon's active graph is the written rev; a rejection with reasons stays a rejection.
 */
async function importAdopted(name: 'import_graph' | 'import_issues', args: Record<string, unknown>) {
  const res = await tool(name, args);
  if (res['accepted'] !== false || (res['reasons'] as unknown[] | undefined)?.length || typeof res['rev'] !== 'string') return res;
  for (let i = 0; i < 50; i++) {
    if ((await tool('status'))['graphRev'] === res['rev']) return { ...res, accepted: true };
    await new Promise((r) => setTimeout(r, 100));
  }
  return res;
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
    // The wait description quotes the cap in force, which a Codex registration sizes tool_timeout_sec against. See specs/operator-mcp "Wait tool".
    expect(tools.tools.find((t) => t.name === 'wait')?.description).toContain(`cap ${WAIT_CAP_MS}`);
    const configure = tools.tools.find((t) => t.name === 'configure');
    expect(Object.keys((configure?.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(['allowedTools', 'budgets', 'capacity', 'checkCommand', 'claude', 'codex', 'commit', 'dataDir', 'effort', 'endLive', 'health', 'model', 'opencode', 'permission', 'repo', 'runnerCommand', 'runnerKind', 'sandbox']);
    // The limit keys. See specs/operator-mcp "Configure and start tools: limit keys".
    for (const word of ['budgets { maxLaunchMs }', 'health { stuckAfterMs, stuckFailAfterMs }', '0 disables a limit', 'applies on the next tick']) expect(configure?.description, word).toContain(word);
    // See specs/operator-mcp "Configure tool: endLive".
    expect(configure?.description).toContain('A change that would end a live launch');
    expect(configure?.description).toContain('is refused without endLive');
    const startProps = (tools.tools.find((t) => t.name === 'start')?.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(startProps)).not.toContain('endLive');
    expect(Object.keys(startProps)).toEqual(expect.arrayContaining(['budgets', 'health']));
    expect(JSON.stringify(startProps['health'])).toContain('stuckFailAfterMs');
    expect(JSON.stringify(startProps['budgets'])).toContain('maxLaunchMs');
    const codexArg = (configure?.inputSchema as { properties: Record<string, { anyOf?: Array<{ properties?: Record<string, unknown> }>; properties?: Record<string, unknown> }> }).properties['codex'];
    expect(JSON.stringify(codexArg)).toContain('"model"');
    expect(JSON.stringify(codexArg)).toContain('"ultra"');
    const reviewTool = tools.tools.find((t) => t.name === 'review');
    expect(Object.keys((reviewTool?.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(['full', 'milestone', 'repo', 'statLines', 'summaryChars', 'task']);
    for (const word of ['task', 'full', 'omitted', 'too large for a client']) expect(reviewTool?.description, word).toContain(word);
    // The ack answer carries the effect's id and state, not its payload. See specs/operator-control "Tracker outbox".
    expect(tools.tools.find((t) => t.name === 'ack')?.description).toContain('payload');
    const statusTool = tools.tools.find((t) => t.name === 'status');
    for (const word of ['runnerKind', 'runner', 'codex.sandbox', 'claimableByKind']) expect(statusTool?.description, word).toContain(word);
    const startTool = tools.tools.find((t) => t.name === 'start');
    for (const word of ['claude-opus-5-5', 'gpt-6-astra', 'anthropic/claude-opus-5-5', 'ultra', 'spawn when the runner kind is codex or opencode', 'orchestrator-work --runner', 'permission', 'dataDir']) expect(JSON.stringify(startTool), word).toContain(word);
    // The profile hold. See specs/operator-mcp "Start tool turns the profile hold on".
    for (const word of ['runner.confirmProfile', 'confirmProfile']) expect(startTool?.description, word).toContain(word);
    for (const word of ['profiles', 'runner.confirmProfile']) expect(statusTool?.description, word).toContain(word);
    expect(tools.tools.find((t) => t.name === 'wait')?.description).toContain('profileHeld');

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
    // The limit keys: a set leaf reports as an argument; a mistyped leaf is refused by the tool, not dropped.
    const raised = await tool('configure', { health: { stuckFailAfterMs: 5_400_000 } });
    expect(raised).toMatchObject({ status: 200, ok: true, config: { health: { stuckFailAfterMs: { value: 5_400_000, source: 'argument' } } } });
    expect(raised['applied']).toContain('health');
    const mistyped = await client.callTool({ name: 'configure', arguments: { health: { stuckFailAfterMS: 1 } } });
    expect(mistyped.isError).toBe(true);
    expect(JSON.stringify(mistyped.content)).toContain('stuckFailAfterMS');
    expect((await client.callTool({ name: 'configure', arguments: { budgets: { maxLaunchMs: -1 } } })).isError).toBe(true);
    expect(await tool('start', { budgets: { maxLaunchMs: 10_800_000 } })).toMatchObject({ started: false, applied: ['budgets'], config: { budgets: { maxLaunchMs: { value: 10_800_000, source: 'argument' } } } });
    expect(await tool('configure', { health: null, budgets: { maxLaunchMs: null } })).toMatchObject({ status: 200, ok: true, config: { health: { stuckFailAfterMs: { value: 2_700_000, source: 'default' } }, budgets: { maxLaunchMs: { value: 7_200_000, source: 'default' } } } });

    const imported = await importAdopted('import_graph', {
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
    // The submitted event comes cut like the review index. See specs/operator-mcp "Wait tool".
    const submittedEv = (rv['events'] as Array<{ kind: string; taskId?: string; payload?: Record<string, unknown> }>).find(
      (e) => e.kind === 'transition' && e.taskId === 'MVP' && e.payload?.['to'] === 'submitted',
    );
    expect(Array.isArray(submittedEv?.payload?.['omitted'])).toBe(true);

    const bundle = await tool('review', { milestone: 'MVP' });
    expect(bundle).toMatchObject({ status: 200, milestone: 'MVP', reviewVersion: 1, tag: 'milestone/MVP/v1' });
    expect((bundle['closure'] as Array<{ taskId: string }>).map((c) => c.taskId).sort()).toEqual(['T1', 'T2']);
    // The index by default; task, summaryChars and full forwarded only when set. See specs/operator-mcp "Review tool".
    expect(bundle['view']).toBe('index');
    const oneTask = await tool('review', { milestone: 'MVP', task: 'T2' });
    expect(oneTask).toMatchObject({ status: 200, view: 'task', integrationSha: bundle['integrationSha'], reviewVersion: 1 });
    expect((oneTask['closure'] as Array<{ taskId: string }>).map((c) => c.taskId)).toEqual(['T2']);
    const noSummaries = await tool('review', { milestone: 'MVP', summaryChars: 0 });
    expect((noSummaries['closure'] as Array<{ summary: string }>).map((c) => c.summary)).toEqual(['', '']);
    expect(await tool('review', { milestone: 'MVP', full: true })).toMatchObject({ status: 200, view: 'full', omitted: [] });
    expect(await tool('review', { milestone: 'MVP', full: false })).toMatchObject({ status: 200, view: 'index' });
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

  it('review fetches a task whose id needs URL encoding', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), [
      `runnerCommand: "node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`,
      'runner: { mode: spawn }',
      'checkCommand: "true"', 'tickIntervalMs: 150', 'leaseTtlMs: 60000', 'capacity: 2',
    ].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    expect(await tool('start')).toMatchObject({ status: 200, started: true });
    const imported = await importAdopted('import_graph', {
      content: ['nodes:', '  - { id: "A+1", deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }', '  - { id: MVP, kind: milestone, gated: true, deps: ["A+1"] }', ''].join('\n'),
    });
    expect(imported).toMatchObject({ status: 200, accepted: true });
    expect(await tool('wait', { afterSeq: 0, until: 'review', timeoutMs: 60_000 })).toMatchObject({ matched: true });
    const one = await tool('review', { milestone: 'MVP', task: 'A+1' });
    expect(one).toMatchObject({ status: 200, view: 'task', closure: [{ taskId: 'A+1', acceptanceCriteria: ['a'] }] });
  }, 120_000);

  // See specs/operator-mcp "Configure tool: endLive".
  it('configure returns the 409 with wouldEnd for a limit a live launch is past, and applies it with endLive', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), [
      `runnerCommand: "node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`,
      'runner: { mode: spawn }',
      'checkCommand: "true"', 'tickIntervalMs: 150', 'leaseTtlMs: 60000', 'capacity: 1',
      'budgets: { maxLaunchMs: 600000 }',
    ].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    expect(await tool('start')).toMatchObject({ status: 200, started: true });
    const imported = await importAdopted('import_graph', {
      content: ['nodes:', '  - { id: T1, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }', ''].join('\n'),
    });
    expect(imported).toMatchObject({ status: 200, accepted: true });
    let live: Array<{ taskId: string; launchId: string }> = [];
    for (let i = 0; i < 200 && !live.length; i++) {
      const s = await tool('status');
      if ((s['byStatus'] as Record<string, string[]> | undefined)?.['running']?.includes('T1')) live = (s['liveLaunches'] as typeof live).filter((l) => l.taskId === 'T1');
      if (!live.length) await new Promise((r) => setTimeout(r, 100));
    }
    expect(live).toHaveLength(1);
    const refused = await client.callTool({ name: 'configure', arguments: { budgets: { maxLaunchMs: 1 } } });
    expect(refused.isError).toBe(true);
    expect(parse(refused)).toMatchObject({ status: 409, ok: false, wouldEnd: [{ taskId: 'T1', launchId: live[0]!.launchId, limit: 'budgets.maxLaunchMs', value: 1 }] });
    expect(String(parse(refused)['error'])).toContain('endLive');
    expect(await tool('configure', { budgets: { maxLaunchMs: 1 }, endLive: true })).toMatchObject({ status: 200, ok: true, applied: ['budgets'] });
  }, 120_000);

  it('defaults a plugin-started run to pull, yields to a configured mode, and leaves a running daemon alone', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), ['checkCommand: "true"', 'tickIntervalMs: 150', 'leaseTtlMs: 60000', 'capacity: 2', 'runner: { confirmProfile: false }'].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    const started = await tool('start');
    expect(started).toMatchObject({ status: 200, started: true, mode: 'pull' });
    expect(await importAdopted('import_graph', { content: 'nodes:\n  - { id: T1, deps: [], description: d, acceptanceCriteria: [a] }\n' })).toMatchObject({ accepted: true });
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

  // See specs/operator-mcp "Start tool turns the profile hold on".
  it('a run started through the start tool holds a task on default worker values until configure sets them', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), ['checkCommand: "true"', 'tickIntervalMs: 150', 'leaseTtlMs: 60000', 'capacity: 2'].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    const started = await tool('start');
    expect(started).toMatchObject({ status: 200, started: true, mode: 'pull', confirmProfile: true });
    const before = await tool('status');
    expect(before['runner']).toMatchObject({ confirmProfile: true });
    expect(before['profiles']).toEqual([]);
    expect(await importAdopted('import_graph', { content: 'nodes:\n  - { id: T1, deps: [], description: d, acceptanceCriteria: [a] }\n' })).toMatchObject({ accepted: true });
    const held = await tool('status');
    expect(held['profiles']).toMatchObject([{ runner: 'claude-code', held: true, missing: ['model', 'effort'], tasks: 1, sample: ['T1'] }]);
    // A few ticks pass and the task is still not parked for a worker.
    await new Promise((r) => setTimeout(r, 600));
    expect((await tool('status'))['claimable']).toEqual([]);
    const digest = (await tool('wait', { timeoutMs: 300 }))['digest'] as Record<string, unknown>;
    expect(digest['profileHeld']).toEqual([{ runner: 'claude-code', missing: ['model', 'effort'], tasks: 1 }]);
    expect(await tool('configure', { model: 'claude-opus-5-5', effort: 'medium' })).toMatchObject({ status: 200, ok: true });
    for (let i = 0; i < 50 && ((await tool('status'))['claimable'] as string[]).length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect((await tool('status'))['claimable']).toEqual(['T1']);
    const released = (await tool('wait', { timeoutMs: 300 }))['digest'] as Record<string, unknown>;
    expect(released['profileHeld']).toEqual([]);
  }, 120_000);

  // See specs/operator-mcp "Configure and start tools: claude object".
  it('the claude object sets the claude-code leaves on a run of another kind and releases a held claude-code task', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), ['checkCommand: "true"', 'tickIntervalMs: 150', 'leaseTtlMs: 60000', 'capacity: 2'].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    const tools = await client.listTools();
    for (const name of ['configure', 'start']) {
      const props = (tools.tools.find((t) => t.name === name)?.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(Object.keys(props), name).toContain('claude');
    }
    const started = await tool('start', { mode: 'pull', runnerKind: 'codex', codex: { model: 'gpt-6-astra', effort: 'medium' }, claude: { effort: 'high' } });
    expect(started).toMatchObject({ status: 200, started: true, mode: 'pull', confirmProfile: true });
    expect(started['applied']).toContain('claude');
    expect(await importAdopted('import_graph', {
      content: 'nodes:\n  - { id: C1, deps: [], runner: claude-code, description: d, acceptanceCriteria: [a] }\n  - { id: C2, deps: [C1], runner: claude-code, description: d, acceptanceCriteria: [a] }\n',
    })).toMatchObject({ accepted: true });
    expect((await tool('status'))['profiles']).toMatchObject([{ runner: 'claude-code', held: true, missing: ['model'], effortSource: 'argument', tasks: 2 }]);
    expect(await tool('configure', { claude: { model: 'claude-opus-5-5' } })).toMatchObject({ status: 200, ok: true });
    for (let i = 0; i < 50 && ((await tool('status'))['claimable'] as string[]).length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    const after = await tool('status');
    expect(after['claimable']).toEqual(['C1']);
    const c2 = (after['profiles'] as Array<{ sample: string[] }>).find((p) => p.sample.includes('C2'));
    expect(c2).toMatchObject({ runner: 'claude-code', held: false, modelSource: 'argument' });
  }, 120_000);

  // See specs/operator-mcp "Start tool" (mode default for codex) and "Configure tool". No graph is loaded: a codex daemon in spawn would exec codex.
  it('defaults a plugin-started codex run to spawn, by argument or by the kind already in force, and binds sandbox and commit to codex', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), ['checkCommand: "true"', 'tickIntervalMs: 150'].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    const started = await tool('start', { runnerKind: 'codex', sandbox: 'read-only', codex: { effort: 'ultra' } });
    expect(started).toMatchObject({
      status: 200,
      started: true,
      mode: 'spawn',
      config: { runnerKind: { value: 'codex', source: 'argument' }, effort: { value: 'ultra', source: 'argument' }, codex: { sandbox: { value: 'read-only', source: 'argument' }, commit: { value: 'daemon', source: 'default' } } },
    });
    expect(started['modeNote']).toMatch(/codex.*spawn/);
    expect(started['modeNote']).toContain('pull-mode workers for codex come from `orchestrator-work --runner codex`');
    expect((await tool('status'))['runner']).toMatchObject({ mode: 'spawn' });
    // commit binds to the kind in force on the daemon.
    expect(await tool('configure', { commit: 'agent' })).toMatchObject({ status: 200, config: { codex: { commit: { value: 'agent', source: 'argument' } }, claude: { commit: { value: 'agent', source: 'default' } } } });
    expect(await tool('configure', { sandbox: null, commit: null })).toMatchObject({ status: 200, config: { codex: { sandbox: { value: 'workspace-write', source: 'default' }, commit: { value: 'daemon', source: 'default' } } } });
    // ultra is codex-only: refused for a claude-code effort.
    const refused = await client.callTool({ name: 'configure', arguments: { runnerKind: 'claude-code', effort: 'ultra' } });
    expect(refused.isError).toBe(true);
    expect(parse(refused)).toMatchObject({ status: 400, key: 'effort' });
    await stopDaemon({ repo, env, reap: true });
    // Already in force for the run: the stored override (config.json) names codex for a start without arguments; a fresh run directory reads the file.
    expect(kindOfRun(repo, env)).toBe('codex');
    await client.close();
    client = undefined;

    const filed = realpathSync(makeRepo(mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'))));
    dirs.push(path.dirname(filed));
    writeFileSync(path.join(filed, 'orchestrator.yaml'), ['checkCommand: "true"', 'runner: { kind: codex }'].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: filed };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    expect(await tool('start')).toMatchObject({ started: true, mode: 'spawn', config: { runnerKind: { value: 'codex', source: 'file' } } });
    // A codex run switched to pull is warned about.
    const pulled = await tool('start', { mode: 'pull' });
    expect(pulled).toMatchObject({ started: false, mode: 'pull' });
    expect(pulled['modeNote']).toMatch(/runner kind codex in pull mode/);
    expect(pulled['modeNote']).toContain('`orchestrator-work --runner codex`');
  }, 120_000);

  // See specs/operator-control "Start arguments" and "Configuration route" (opencode). No graph is loaded: an opencode daemon in spawn would exec opencode.
  it('defaults a plugin-started opencode run to spawn naming the opencode work loop, and takes the opencode leaves on configure', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), ['checkCommand: "true"', 'tickIntervalMs: 150'].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    const started = await tool('start', { runnerKind: 'opencode', permission: 'allow', dataDir: 'launch' });
    expect(started).toMatchObject({
      status: 200,
      started: true,
      mode: 'spawn',
      config: {
        runnerKind: { value: 'opencode', source: 'argument' },
        model: { value: 'anthropic/claude-opus-5-5', source: 'default' },
        opencode: { permission: { value: 'allow', source: 'argument' }, dataDir: { value: 'launch', source: 'argument' }, commit: { value: 'agent', source: 'default' } },
      },
    });
    expect(started['modeNote']).toMatch(/opencode.*spawn/);
    expect(started['modeNote']).toContain('orchestrator-work --runner opencode');
    // The opencode block sets its leaves whichever kind is in force; commit binds to the kind in force.
    expect(await tool('configure', { opencode: { model: 'opencode/big-pickle' }, commit: 'daemon' })).toMatchObject({
      status: 200,
      config: { model: { value: 'opencode/big-pickle', source: 'argument' }, opencode: { model: { value: 'opencode/big-pickle', source: 'argument' }, commit: { value: 'daemon', source: 'argument' } }, claude: { commit: { value: 'agent', source: 'default' } } },
    });
    expect(await tool('configure', { permission: null })).toMatchObject({ status: 200, config: { opencode: { permission: { value: 'derived', source: 'default' } } } });
    // ultra is codex-only: refused for an opencode effort with the kind named.
    const refused = await client.callTool({ name: 'configure', arguments: { runnerKind: 'opencode', effort: 'ultra' } });
    expect(refused.isError).toBe(true);
    expect(parse(refused)).toMatchObject({ status: 400, key: 'effort', error: expect.stringContaining('opencode') });
    // An opencode run switched to pull is warned about, naming the kind and its work loop.
    const pulled = await tool('start', { mode: 'pull' });
    expect(pulled).toMatchObject({ started: false, mode: 'pull' });
    expect(pulled['modeNote']).toMatch(/runner kind opencode in pull mode/);
    expect(pulled['modeNote']).toContain('orchestrator-work --runner opencode');
    expect(modeNoteFor('claude-code', { mode: 'pull', started: true }, false)).toBeUndefined();
    expect(defaultModeFor('opencode')).toBe('spawn');
    expect(defaultModeFor('claude-code')).toBe('pull');
  }, 120_000);

  // A plugin-installed server runs in the plugin root, outside any git repository. See specs/operator-mcp "Operator MCP server".
  it('outside a git repository the server refuses a call without repo, serves the repo a call passes, and reuses it for the session', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    const pluginRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-mcp-plugin-root-')));
    dirs.push(home, base, pluginRoot);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), ['checkCommand: "true"', 'tickIntervalMs: 150', 'runner: { mode: pull }'].join('\n'));
    const { ORCH_REPO: _unset, ...rest } = process.env as Record<string, string>;
    env = { ...rest, ORCH_HOME: home };
    // The fixture's run exists before the session: a daemon with a graph, started from the test process.
    const lifecycleEnv = { ...env, ORCH_REPO: repo };
    const run = await startDaemon({ repo, env: lifecycleEnv });
    const put = await fetch(`${run.url}/v1/graph`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'nodes:\n  - { id: T1, deps: [], description: d, acceptanceCriteria: [a] }\n' }) });
    expect(put.status).toBe(200);
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, cwd: pluginRoot, stderr: 'pipe' }));

    const tools = await client.listTools();
    for (const t of tools.tools) {
      expect(Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}), t.name).toContain('repo');
      expect(JSON.stringify(t.inputSchema), t.name).toContain(REPO_ARG_TEXT.slice(0, 40));
    }

    const refused = await client.callTool({ name: 'status', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(parse(refused)['error']).toMatch(/not inside a git repository: .*orch-mcp-plugin-root-.*pass repo, the absolute path of the session's project, as a tool argument/);
    const relative = await client.callTool({ name: 'status', arguments: { repo: 'some/where' } });
    expect(relative.isError).toBe(true);
    expect(parse(relative)['error']).toMatch(/repo must be an absolute path/);
    const notGit = await client.callTool({ name: 'status', arguments: { repo: pluginRoot } });
    expect(parse(notGit)['error']).toMatch(/repo .* is not inside a git repository/);

    // A subdirectory of the project names its top level.
    mkdirSync(path.join(repo, 'sub'));
    const tasksOf = (s: Record<string, unknown>) => Object.values(s['byStatus'] as Record<string, string[]>).flat();
    const served = await tool('status', { repo: path.join(repo, 'sub') });
    expect(served).toMatchObject({ status: 200 });
    expect(tasksOf(served)).toEqual(['T1']);
    const again = await tool('status');
    expect(again).toMatchObject({ status: 200 });
    expect(tasksOf(again)).toEqual(['T1']);
    // repo is never forwarded: configure would refuse an unknown key.
    expect(await tool('configure', { capacity: 3 })).toMatchObject({ status: 200, applied: ['capacity'] });
    expect(await tool('configure', { capacity: null, repo })).toMatchObject({ status: 200 });
    const started = await tool('start');
    expect(started).toMatchObject({ status: 200, started: false, repo, runDir: runPaths(repo, env).runDir });
  }, 60_000);

  // Requests run concurrently on one server; each call is bound to its repository once. See specs/operator-mcp "Operator MCP server".
  it('a wait bound to one repo keeps polling its daemon while a call names another repo', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const pluginRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-mcp-plugin-root-')));
    dirs.push(home, pluginRoot);
    const { ORCH_REPO: _unset, ...rest } = process.env as Record<string, string>;
    env = { ...rest, ORCH_HOME: home };
    const fixture = async (ids: string[]) => {
      const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
      dirs.push(base);
      const repo = realpathSync(makeRepo(base));
      writeFileSync(path.join(repo, 'orchestrator.yaml'), ['checkCommand: "true"', 'tickIntervalMs: 150', 'runner: { mode: pull }'].join('\n'));
      const run = await startDaemon({ repo, env: { ...env, ORCH_REPO: repo } });
      const content = ['nodes:', ...ids.map((id) => `  - { id: ${id}, deps: [], description: d, acceptanceCriteria: [a] }`), ''].join('\n');
      const put = await fetch(`${run.url}/v1/graph`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
      expect(put.status).toBe(200);
      return { repo, url: run.url };
    };
    const a = await fixture(['A1']);
    // B has more events than A, so a slice polling B with A's seq would return B's events.
    const b = await fixture(['B1', 'B2', 'B3', 'B4', 'B5']);
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, cwd: pluginRoot, stderr: 'pipe' }));
    const tasksOf = (s: Record<string, unknown>) => Object.values(s['byStatus'] as Record<string, string[]>).flat().sort();

    const seqA = Number((await tool('status', { repo: a.repo }))['latestSeq']);
    const waiting = tool('wait', { repo: a.repo, afterSeq: seqA, until: 'finished', timeoutMs: 4000 });
    await new Promise((r) => setTimeout(r, 300));
    const statusB = await tool('status', { repo: b.repo });
    expect(statusB).toMatchObject({ status: 200 });
    expect(tasksOf(statusB)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5']);
    // An event on A ends the wait's current slice; the next slice must poll A again.
    expect((await fetch(`${a.url}/v1/pause`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
    const w = await waiting;
    const latestA = Number(((await (await fetch(`${a.url}/v1/status`)).json()) as Record<string, unknown>)['latestSeq']);
    expect(w).toMatchObject({ status: 200, matched: false, seq: latestA, digest: { pausedReason: 'operator' } });
    const events = w['events'] as Array<{ seq: number; kind: string }>;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.seq > seqA && e.seq <= latestA)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/B[1-5]/);

    // A call without repo is served by the repo the session last passed.
    const again = await tool('status');
    expect(again).toMatchObject({ status: 200 });
    expect(tasksOf(again)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5']);
  }, 60_000);

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

  // See specs/operator-mcp "Start tool turns the profile hold on": the local revival is a spawn by the plugin too.
  it('a revival through a tool turns the profile hold on for a run that has no stored choice', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-mcp-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-mcp-repo-'));
    dirs.push(home, base);
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), ['checkCommand: "true"', 'tickIntervalMs: 100', 'daemon: { idleExitMs: 800, exitWhileAttached: true }', 'runner: { mode: pull }'].join('\n'));
    env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    // A run from before the update: started without the default, so it stores no choice.
    const run = await startDaemon({ repo, env });
    expect(run.confirmProfile).toBe(false);
    const put = await fetch(`${run.url}/v1/graph`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'nodes:\n  - { id: T1, deps: [], description: d, acceptanceCriteria: [a] }\n  - { id: T2, deps: [T1], description: d, acceptanceCriteria: [a] }\n' }),
    });
    expect(put.status).toBe(200);
    const deadline = Date.now() + 15_000;
    while (pidAlive(run.pid)) {
      if (Date.now() > deadline) throw new Error('daemon did not exit idle');
      await new Promise((r) => setTimeout(r, 100));
    }
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env, stderr: 'pipe' }));
    expect((await tool('runs'))['runs']).toMatchObject([{ repo, alive: false, exit: { reason: 'idle' } }]);
    const revived = await tool('status');
    expect(revived).toMatchObject({ status: 200, runner: { confirmProfile: true } });
    const t2 = (revived['profiles'] as Array<{ held: boolean; sample: string[] }>).find((p) => p.sample.includes('T2'));
    expect(t2).toMatchObject({ held: true });
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

    const imported = await importAdopted('import_issues', {
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
    const ackResult = await tool('ack', { id: first!.id, result: { stateId: 'st-1' } });
    expect(ackResult).toMatchObject({ status: 200, ok: true, effect: { status: 'applied', result: { stateId: 'st-1' } } });
    expect(ackResult['effect']).not.toHaveProperty('payload');
    const ackError = await tool('ack', { id: second!.id, error: 'rate limited' });
    expect(ackError).toMatchObject({ status: 200, effect: { status: 'pending', attempts: 1, error: 'rate limited' } });
    expect(ackError['effect']).not.toHaveProperty('payload');
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
    expect(await importAdopted('import_graph', {
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
    expect(await importAdopted('import_graph', { content: 'nodes:\n  - { id: T1, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }\n' })).toMatchObject({ accepted: true });
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
