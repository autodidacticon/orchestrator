/**
 * The remote worker loop's settings, its polling with backoff on a fake clock, and its agent command composition.
 * See specs/worker-pool.
 */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// A spy around the one substitution function, to show the loop calls it rather than a copy.
vi.mock('../../src/runner/command.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runner/command.js')>();
  return { ...actual, substitute: vi.fn(actual.substitute), fixedSlots: vi.fn(actual.fixedSlots) };
});

const command = await import('../../src/runner/command.js');
const { Backoff, composeAgentCommand, DEFAULT_WORKER_CACHE, launchState, runWorkerLoop, startOf, workerSettings } = await import('../../src/worker/loop.js');

const settings = (over: Partial<import('../../src/worker/loop.js').WorkerSettings> = {}) => ({
  api: 'http://daemon.test',
  workerId: 'w-1',
  cache: '/nonexistent-cache',
  agent: 'scripted' as const,
  idleExitMs: 0,
  retryWindowMs: 1000,
  backoffMs: 1000,
  backoffMaxMs: 30_000,
  ...over,
});

/** A daemon that never has anything claimable: 404 on claims, `finished` from `finished()` on status. */
function idleDaemon(finished: () => boolean = () => false) {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url).replace('http://daemon.test', '');
    calls.push(`${init?.method ?? 'GET'} ${route}`);
    if (route === '/v1/claims') return new Response(JSON.stringify({ error: 'nothing is claimable', paused: false }), { status: 404 });
    if (route === '/v1/status') return new Response(JSON.stringify({ finished: finished() }), { status: 200 });
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

/** A fake clock: `sleep` records the delay and advances `now` at once. */
function fakeClock() {
  let t = 1_000_000;
  const delays: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void (delays.push(ms), (t += ms)), delays };
}

describe('worker loop settings', () => {
  it('takes the worker id from POD_NAME, else ORCH_WORKER_ID, else the host name, and applies the defaults', () => {
    const base = { ORCH_API: 'http://d:8080/', ORCH_WORKER_AGENT: 'scripted' };
    expect(workerSettings({ ...base, POD_NAME: 'pod-a', ORCH_WORKER_ID: 'id-b' }, () => 'host-c').workerId).toBe('pod-a');
    expect(workerSettings({ ...base, ORCH_WORKER_ID: 'id-b' }, () => 'host-c').workerId).toBe('id-b');
    expect(workerSettings({ ...base, POD_NAME: '' }, () => 'host-c').workerId).toBe('host-c');
    expect(workerSettings(base, () => 'h')).toEqual({
      api: 'http://d:8080',
      workerId: 'h',
      cache: DEFAULT_WORKER_CACHE,
      agent: 'scripted',
      idleExitMs: 0,
      retryWindowMs: 60_000,
      backoffMs: 1000,
      backoffMaxMs: 30_000,
    });
    expect(DEFAULT_WORKER_CACHE).toBe('/var/cache/orchestrator');
  });

  it('defaults the agent to command, which needs ORCH_WORKER_COMMAND; refuses a missing ORCH_API and malformed values', () => {
    expect(() => workerSettings({ ORCH_API: 'http://d' })).toThrow(/ORCH_WORKER_COMMAND is required/);
    expect(workerSettings({ ORCH_API: 'http://d', ORCH_WORKER_COMMAND: 'agent {brief}' }, () => 'h')).toMatchObject({ agent: 'command', command: 'agent {brief}' });
    expect(() => workerSettings({ ORCH_WORKER_AGENT: 'scripted' })).toThrow(/ORCH_API is required/);
    expect(() => workerSettings({ ORCH_API: 'http://d', ORCH_WORKER_AGENT: 'model' })).toThrow(/ORCH_WORKER_AGENT must be scripted or command/);
    expect(() => workerSettings({ ORCH_API: 'http://d', ORCH_WORKER_AGENT: 'scripted', ORCH_WORKER_IDLE_EXIT_MS: '-1' })).toThrow(/ORCH_WORKER_IDLE_EXIT_MS/);
    expect(workerSettings({ ORCH_API: 'http://d', ORCH_WORKER_AGENT: 'scripted', ORCH_WORKER_CACHE: '/c', ORCH_WORKER_IDLE_EXIT_MS: '5000' }, () => 'h')).toMatchObject({ cache: '/c', idleExitMs: 5000 });
  });
});

describe('polling with nothing claimable', () => {
  it('waits 1, 2, 4 s and doubling up to the 30 s cap, and exits 0 after ORCH_WORKER_IDLE_EXIT_MS', async () => {
    const clock = fakeClock();
    const daemon = idleDaemon();
    const out: string[] = [];
    const code = await runWorkerLoop(settings({ idleExitMs: 120_000 }), { fetch: daemon.fetchFn, sleep: clock.sleep, now: clock.now, out: (l) => out.push(l), err: () => undefined });
    expect(code).toBe(0);
    // 1+2+4+8+16+30+30+30 = 121 s: the first look at or past 120 s of idleness exits.
    expect(clock.delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
    expect(out.at(-1)).toBe('worker w-1 idle-exit - -');
    expect(out[0]).toBe('worker w-1 start - -');
    // Every poll is a claim with access remote, then a status read.
    expect(daemon.calls.filter((c) => c === 'POST /v1/claims')).toHaveLength(9);
    expect(daemon.calls.filter((c) => c === 'GET /v1/status')).toHaveLength(9);
  });

  it('exits 0 as soon as /v1/status says the run is finished', async () => {
    const clock = fakeClock();
    let polls = 0;
    const daemon = idleDaemon(() => ++polls >= 3);
    const out: string[] = [];
    expect(await runWorkerLoop(settings(), { fetch: daemon.fetchFn, sleep: clock.sleep, now: clock.now, out: (l) => out.push(l), err: () => undefined })).toBe(0);
    expect(clock.delays).toEqual([1000, 2000]);
    expect(out.at(-1)).toBe('worker w-1 finished - -');
  });

  it('never exits on idleness with ORCH_WORKER_IDLE_EXIT_MS 0 (the default)', async () => {
    const clock = fakeClock();
    let polls = 0;
    const daemon = idleDaemon(() => ++polls > 40);
    expect(await runWorkerLoop(settings(), { fetch: daemon.fetchFn, sleep: clock.sleep, now: clock.now, out: () => undefined, err: () => undefined })).toBe(0);
    expect(clock.delays).toHaveLength(40);
    expect(clock.delays.slice(5).every((d) => d === 30_000)).toBe(true);
  });

  it('the backoff resets to the first delay after a claim', () => {
    const b = new Backoff(1000, 30_000);
    expect([b.delay(), b.delay(), b.delay()]).toEqual([1000, 2000, 4000]);
    b.reset();
    expect(b.delay()).toBe(1000);
  });

  it('retries a connection failure within ORCH_RETRY_WINDOW_MS, then gives up with the error', async () => {
    const clock = fakeClock();
    let failures = 0;
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
      if (failures++ < 3) throw new TypeError('fetch failed');
      return idleDaemon(() => true).fetchFn(url, init);
    }) as typeof fetch;
    expect(await runWorkerLoop(settings({ retryWindowMs: 5000 }), { fetch: flaky, sleep: clock.sleep, now: clock.now, out: () => undefined, err: () => undefined })).toBe(0);
    expect(clock.delays).toEqual([100, 200, 400]);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const clock2 = fakeClock();
    await expect(runWorkerLoop(settings({ retryWindowMs: 2000 }), { fetch: down, sleep: clock2.sleep, now: clock2.now, out: () => undefined, err: () => undefined })).rejects.toThrow('fetch failed');
    expect(clock2.delays).toEqual([100, 200, 400, 800]);
  });
});

describe('agent command', () => {
  it('fills every placeholder through substitute and fixedSlots from src/runner/command.ts, with the clone as the worktree', () => {
    const subst = vi.mocked(command.substitute);
    const slots = vi.mocked(command.fixedSlots);
    subst.mockClear();
    slots.mockClear();
    const template = 'agent --brief {brief} --json {briefJson} --mcp {mcpConfig} --model {model} --effort {effort} --allowedTools {allowedTools} --in {worktree} {launchId} {taskId} {unknown}';
    const clone = '/cache/repo-abc';
    const claim = { launchId: 'L1', taskId: 'T1', model: 'claude-opus-5-5', effort: 'high', brief: { allowedTools: ['Bash(git:*)', 'mcp__orchestrator__report'] } };
    const cmd = composeAgentCommand(template, claim, clone);
    const orch = path.join(clone, '.orchestrator');
    expect(cmd).toBe(
      `agent --brief ${orch}/brief.md --json ${orch}/brief.json --mcp ${orch}/mcp.json --model claude-opus-5-5 --effort high --allowedTools "Bash(git:*)" "mcp__orchestrator__report" --in ${clone} L1 T1 {unknown}`,
    );
    // The same function every runner composes with, called once for this command.
    expect(subst).toHaveBeenCalledTimes(1);
    expect(subst.mock.calls[0]![0]).toBe(template);
    expect(slots).toHaveBeenCalledWith({ worktree: clone, launchId: 'L1', taskId: 'T1', model: 'claude-opus-5-5', effort: 'high' });
    // The default Claude Code template composes without a slot left over.
    expect(composeAgentCommand(command.DEFAULT_CLAUDE_COMMAND, claim, clone)).not.toMatch(/\{\w+\}/);
  });

  it('an empty allow list and no model or effort fill empty slots', () => {
    expect(composeAgentCommand('a {allowedTools}|{model}|{effort}', { launchId: 'L', taskId: 'T' }, '/c')).toBe('a ||');
  });
});

describe('launch start and state', () => {
  it('starts at carry.interrupted.headSha when the claim carries one, else at the base', () => {
    expect(startOf({ baseSha: 'base' })).toBe('base');
    expect(startOf({ baseSha: 'base', carry: { interrupted: { headSha: 'head' } } })).toBe('head');
  });

  it('reads reported, held or ended from the status', () => {
    const c = { launchId: 'L1', taskId: 'T1' };
    expect(launchState({ byStatus: { submitted: ['T1'] } }, 'w', c)).toBe('reported');
    expect(launchState({ byStatus: { done: ['T1'] } }, 'w', c)).toBe('reported');
    expect(launchState({ byStatus: { running: ['T1'] }, workers: [{ id: 'w', launchId: 'L1' }] }, 'w', c)).toBe('held');
    expect(launchState({ byStatus: { running: ['T1'] }, workers: [{ id: 'w', launchId: 'L2' }] }, 'w', c)).toBe('ended');
    expect(launchState({ byStatus: { failed: ['T1'] } }, 'w', c)).toBe('ended');
  });
});
