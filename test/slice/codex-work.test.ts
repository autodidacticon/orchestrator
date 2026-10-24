import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRunner, composeCodexCommand, type CodexSettings } from '../../src/runner/codex.js';
import { DEFAULT_CODEX_COMMAND } from '../../src/runner/command.js';
import type { Launch } from '../../src/state/store.js';
import { fakeCodex, makeSlice, type SliceHarness, tsxLoader } from './harness.js';
// @ts-expect-error a plain .mjs host script without type declarations
import { parseWorkArgs, stopVerdict, workerPreamble } from '../../hosts/codex/bin/work.mjs';

/**
 * The Codex work loop (hosts/codex/bin/work.mjs) against a pull-mode codex run, with
 * test/agents/fake-codex.ts on PATH as `codex`: claims carry runner "codex", each launch runs
 * the composed `codex exec`, usage is posted back, and a codex that fails to start is released
 * with keep. See specs/host-integration "Codex work loop".
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const workMjs = path.resolve(here, '../../hosts/codex/bin/work.mjs');

let h: SliceHarness | undefined;
let child: ChildProcess | undefined;
afterEach(async () => {
  child?.kill('SIGKILL');
  child = undefined;
  await h?.cleanup();
  h = undefined;
});

const graph = `nodes:
  - { id: T1, title: One,   description: d, acceptanceCriteria: [a], deps: [],   behavior: commitAndSubmit }
  - { id: T2, title: Two,   description: d, acceptanceCriteria: [a], deps: [T1], behavior: commitAndSubmit }
  - { id: T3, title: Three, description: d, acceptanceCriteria: [a], deps: [],   behavior: commitAndSubmit }
`;

/** A bin directory whose `codex` is the fake, or a `codex` that exits 127 like a missing executable. */
function binDir(h: SliceHarness, missing = false): string {
  const dir = path.join(h.dir, 'bin');
  mkdirSync(dir, { recursive: true });
  const body = missing ? '#!/bin/sh\necho "codex: command not found" >&2\nexit 127\n' : `#!/bin/sh\nexec node --import ${tsxLoader} ${fakeCodex} "$@"\n`;
  writeFileSync(path.join(dir, 'codex'), body, { mode: 0o755 });
  return dir;
}

function startLoop(h: SliceHarness, bin: string, args: string[]): { done: Promise<{ code: number | null; stdout: string; stderr: string }> } {
  let stdout = '';
  let stderr = '';
  child = spawn(process.execPath, ['--import', tsxLoader, workMjs, '--url', h.orch.apiBaseUrl, '--poll-ms', '300', ...args], {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
  const c = child;
  return { done: new Promise((resolve) => c.on('close', (code) => resolve({ code, stdout, stderr }))) };
}

describe('codex work loop (work.mjs, fake codex on PATH)', () => {
  it('two loops drain a three-task pull-mode codex graph; every launch is claimed, done, and carries worker usage', async () => {
    h = await makeSlice({ graph, config: { runner: { mode: 'pull', kind: 'codex' } } });
    expect(h.orch.effective().config.runner.codex.command).toBeUndefined();
    const loop = startLoop(h, binDir(h), ['--workers', '2', '--run-tag', 'cx', '--idle-exit-ms', '20000']);
    const t0 = Date.now();
    const events = () => JSON.stringify(h!.store.listEvents().map((ev) => [ev.ts - t0, ev.kind, ev.taskId, ev.payload]));
    try {
      await h.waitFor(() => ['T1', 'T2', 'T3'].every((t) => h!.orch.entry(t).status.kind === 'done'), 90_000);
    } catch (e) {
      throw new Error(`${String(e)}; events: ${events()}`);
    }
    // The run is finished, so both loops stop by themselves. A loop must not stop while T1 or T3 is still
    // verifying: T2 becomes claimable only after T1 is done.
    const timer = setInterval(() => void h?.orch.tick(), 100);
    const out = await loop.done.finally(() => clearInterval(timer));
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toMatch(/stops: the run is finished/);

    const launches = h.store.listLaunches();
    expect(launches.length).toBe(3);
    for (const l of launches) {
      expect(l.runner).toBe('codex');
      expect(l.worker?.id).toMatch(/^cx-[12]$/);
      expect(l.pid).toBeUndefined();
      expect(l.usageSource).toBe('worker');
      expect(l.tokens?.input).toBeGreaterThan(0);
      expect(l.tokens?.output).toBeGreaterThan(0);
    }
    // Every claim named the codex runner.
    const claims = h.store.listEvents({ kind: 'operator.claim' }).map((e) => e.payload as { runner?: unknown; workerId?: string });
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((p) => p.runner === 'codex' && /^cx-[12]$/.test(String(p.workerId)))).toBe(true);
    const result = JSON.parse(out.stdout.trim().split('\n').pop()!) as { outcomes: Array<{ result: string }> };
    expect(result.outcomes.map((o) => o.result)).toEqual(['started', 'started', 'started']);
  }, 150_000);

  it('a codex claim carries the commit policy, the runner.codex settings, and the agent environment', async () => {
    h = await makeSlice({ graph: 'nodes:\n  - { id: T1, title: One, description: d, acceptanceCriteria: [a], deps: [], behavior: commitAndSubmit }', config: { runner: { mode: 'pull', kind: 'codex' } } });
    await h.waitFor(() => h!.store.listLaunches({ status: 'claimable' }).length === 1);
    const res = await fetch(`${h.orch.apiBaseUrl}/v1/claims`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workerId: 'w', runner: 'codex' }) });
    const body = (await res.json()) as { token: string; runner: string; commitPolicy: string; codex: { settings: CodexSettings; maxWaitMs: number; retryWindowMs: number; env: Record<string, string> } };
    expect(res.status).toBe(200);
    expect(body.runner).toBe('codex');
    expect(body.commitPolicy).toBe('daemon');
    expect(body.codex.settings.sandbox).toBe('workspace-write');
    expect(body.codex.maxWaitMs).toBe(h.config.maxWaitMs);
    expect(body.codex.retryWindowMs).toBe(h.config.retryWindowMs);
    expect(body.codex.env['ORCH_TOKEN']).toBe(body.token);
    expect(body.codex.env['ORCH_COMMIT_POLICY']).toBe('daemon');
  });

  it('a codex that fails to start is released with keep, and the loop stops after --max-failures', async () => {
    h = await makeSlice({ graph: 'nodes:\n  - { id: T1, title: One, description: d, acceptanceCriteria: [a], deps: [], behavior: commitAndSubmit }', config: { runner: { mode: 'pull', kind: 'codex' } } });
    await h.waitFor(() => h!.store.listLaunches({ status: 'claimable' }).length === 1);
    const loop = startLoop(h, binDir(h, true), ['--workers', '1', '--run-tag', 'bad', '--max-failures', '2']);
    const timer = setInterval(() => void h?.orch.tick(), 100);
    const out = await loop.done.finally(() => clearInterval(timer));
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toMatch(/codex failed to start/);
    expect(out.stderr).toMatch(/2 launches in a row/);
    const releases = h.store.listEvents({ kind: 'operator.release' }).map((e) => e.payload as { keep?: boolean; reason?: string });
    expect(releases.length).toBe(2);
    expect(releases.every((r) => r.keep === true && /codex failed to start/.test(String(r.reason)))).toBe(true);
    // Nothing ran, so each release returned the task to unstarted at no cost.
    const claimed = h.store.listLaunches().filter((l) => l.worker);
    expect(claimed.length).toBe(2);
    expect(claimed.every((l) => l.worker?.id === 'bad-1' && l.pid === undefined && l.status === 'ended')).toBe(true);
    expect(['unstarted', 'running']).toContain(h.orch.entry('T1').status.kind);
  }, 90_000);
});

describe('composeCodexCommand', () => {
  const settings: CodexSettings = { sandbox: 'workspace-write', ephemeral: true, ignoreUserConfig: true };
  const launch = { worktree: '/tmp/wt', launchId: 'L1', taskId: 'T1', model: 'gpt-x', effort: 'high' } as Pick<Launch, 'worktree' | 'launchId' | 'taskId' | 'model' | 'effort'>;

  it('is the command the Codex runner spawns, with the brief swapped for the loop prompt', () => {
    const cmd = composeCodexCommand(launch, { settings, maxWaitMs: 60_000 });
    expect(cmd).toContain('codex exec --json --ephemeral --ignore-user-config -C /tmp/wt -m gpt-x');
    expect(cmd).toContain(`-c model_reasoning_effort='"high"'`);
    expect(cmd).toContain(`-c mcp_servers.orchestrator.args=`);
    expect(cmd).toContain('/tmp/wt/.orchestrator/shim.env');
    expect(cmd).toContain('-c mcp_servers.orchestrator.tool_timeout_sec=120');
    expect(cmd).toMatch(/approval_policy='"never"'/);
    expect(cmd.endsWith('- < /tmp/wt/.orchestrator/brief.md')).toBe(true);
    const swapped = composeCodexCommand(launch, { settings, maxWaitMs: 60_000, brief: '/tmp/wt/.orchestrator/codex-work-prompt.md' });
    expect(swapped).toBe(cmd.replace('/tmp/wt/.orchestrator/brief.md', '/tmp/wt/.orchestrator/codex-work-prompt.md'));
    // The runner goes through the same function.
    let composed = '';
    const runner = new CodexRunner({ command: DEFAULT_CODEX_COMMAND, settings: () => settings, maxWaitMs: 60_000, retryWindowMs: 1000, logDir: '/tmp' });
    composed = (runner as unknown as { opts: { compose: (l: unknown) => string } }).opts.compose(launch);
    expect(composed).toBe(cmd);
  });
});

describe('work.mjs helpers', () => {
  it('clamps workers to capacity', () => {
    expect(parseWorkArgs(['--workers', '4', '--capacity', '2']).workers).toBe(2);
    expect(parseWorkArgs(['--workers', '2', '--capacity', '8']).workers).toBe(2);
    expect(parseWorkArgs(['--run-tag', 'x']).runTag).toBe('x');
  });

  it('stops on finished or stalled, on quiet with a human wait, or after the idle window', () => {
    const base = { finished: false, stalled: false, paused: false, claimableByKind: { 'claude-code': 0, codex: 0 }, liveLaunches: [], openQuestions: [], awaitingReview: [] };
    expect(stopVerdict({ ...base, finished: true }, undefined, 0, 1000).stop).toBe(true);
    expect(stopVerdict({ ...base, stalled: true }, undefined, 0, 1000).stop).toBe(true);
    expect(stopVerdict({ ...base, claimableByKind: { 'claude-code': 0, codex: 1 } }, 0, 5000, 1000).stop).toBe(false);
    expect(stopVerdict({ ...base, liveLaunches: [{ runner: 'codex' }] }, 0, 5000, 1000).stop).toBe(false);
    expect(stopVerdict({ ...base, openQuestions: ['T1'] }, undefined, 0, 1000).stop).toBe(true);
    expect(stopVerdict({ ...base, awaitingReview: ['MVP'], verifying: [] }, undefined, 0, 1000).stop).toBe(true);
    // A task awaiting the verifier waits on no human, and its result can make work claimable: not quiet.
    expect(stopVerdict({ ...base, awaitingReview: ['T1'], verifying: ['T1'] }, 0, 5000, 1000)).toEqual({ stop: false, quiet: false });
    expect(stopVerdict({ ...base, awaitingReview: ['MVP', 'T1'], verifying: ['T1'] }, undefined, 0, 1000)).toEqual({ stop: false, quiet: false });
    expect(stopVerdict(base, undefined, 0, 1000)).toEqual({ stop: false, quiet: true });
    expect(stopVerdict(base, 0, 999, 1000).stop).toBe(false);
    expect(stopVerdict(base, 0, 1000, 1000).stop).toBe(true);
    // Parked claude-code launches are another worker's business.
    expect(stopVerdict({ ...base, claimableByKind: { 'claude-code': 2, codex: 0 } }, 0, 1000, 1000).stop).toBe(true);
    expect(stopVerdict({ ...base, paused: true }, 0, 5000, 1000).stop).toBe(false);
  });

  it('the preamble names the launch, the 401 rule, and the fallback-file rule', () => {
    const p = workerPreamble({ launchId: 'L1', taskId: 'T1', worktree: '/wt', pending: { seq: 2 } }, 'cx-1') as string;
    expect(p).toContain('launch L1 for task T1');
    expect(p).toContain('401');
    expect(p).toContain('Never write a fallback report file');
    expect(p).toContain('seq 2');
  });
});
