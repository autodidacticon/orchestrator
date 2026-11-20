/**
 * The remote worker loop's runner filter (`ORCH_WORKER_RUNNER`) and what it does when the daemon ends a launch whose
 * command agent still runs: a heartbeat answered 401 makes the loop read the status once, give an agent whose task
 * reported a short grace, and stop it. Loops run against a real daemon with a bare origin, as a subprocess or, where a
 * test needs `reportGraceMs` or its own fetch, in this process. Every loop ends by ORCH_WORKER_MAX_LAUNCHES or by its
 * termination, never by the idle clock. See specs/worker-pool "Worker loop: runner filter" and "Worker loop: revoked launch".
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runWorkerLoop, type WorkerSettings } from '../../src/worker/loop.js';
import { gitIn, makeRepo, makeSlice, type SliceHarness, tsxLoader } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const loopTs = path.resolve(here, '../../src/worker/loop.ts');
const slowAgent = path.resolve(here, '../agents/slow-agent.ts');
const lingerAgent = path.resolve(here, '../agents/linger-agent.ts');

const harnesses: SliceHarness[] = [];
const children: ChildProcess[] = [];
const agentDirs: Array<{ dir: string; root: string }> = [];
const loops: Array<{ abort: AbortController; done: Promise<number> }> = [];

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Kill the pid an agent recorded, only while its command line still names the test's directory or agent (not a recycled pid). */
function killOwnAgent(agentDir: string, root: string): void {
  const marker = path.join(agentDir, 'pid');
  const pid = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : 0;
  if (!pid || !pidAlive(pid)) return;
  let command = '';
  try {
    command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  } catch {
    return;
  }
  if (command.includes(root) || command.includes(slowAgent) || command.includes(lingerAgent)) process.kill(pid, 'SIGKILL');
}

afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const l of loops.splice(0)) {
    l.abort.abort();
    await l.done.catch(() => undefined);
  }
  for (const a of agentDirs.splice(0)) killOwnAgent(a.dir, a.root);
  for (const h of harnesses.splice(0)) await h.cleanup();
});

function fixture(): { dir: string; repo: string; bare: string } {
  // The real path: the agent's process.cwd() resolves symlinks (macOS /var -> /private/var).
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-worker-revoked-')));
  const repo = makeRepo(dir);
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  return { dir, repo, bare };
}

/** A remote run with a 3 s lease (a heartbeat every second); the daemon's own report grace is 0, so a tick ends a reported launch at once. */
const remoteRun = (bare: string, over: { health?: Record<string, number>; runner?: Record<string, unknown>; capacity?: number } = {}) => ({
  leaseTtlMs: 3000,
  apiBaseUrl: 'http://orchestrator.example:8080',
  ...(over.capacity ? { capacity: over.capacity } : {}),
  runner: { mode: 'pull' as const, access: 'remote' as const, claimWindowMs: 60_000, ...(over.runner ?? {}) },
  git: { pushIntegration: true, originUrl: bare, fetchIntervalMs: 0 },
  health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, ...(over.health ?? {}) },
});

const node = (id: string) => `  - { id: ${id}, deps: [], description: d, acceptanceCriteria: [a] }`;

const lines = (text: string, event: string) => text.split('\n').filter((l) => l.split(' ').slice(2, 2 + event.split(' ').length).join(' ') === event);
/** The index of the first stdout line of `event`, or -1. */
const lineAt = (all: string[], event: string) => all.findIndex((l) => l.split(' ').slice(2, 2 + event.split(' ').length).join(' ') === event);

async function until(pred: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface LoopRun {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
  done: () => boolean;
}

function startLoop(h: SliceHarness, env: Record<string, string>): LoopRun {
  const child = spawn(process.execPath, ['--import', tsxLoader, loopTs], {
    env: { ...process.env, ORCH_API: h.orch.apiBaseUrl, ORCH_WORKER_BACKOFF_MS: '50', ORCH_WORKER_BACKOFF_MAX_MS: '400', ORCH_RETRY_WINDOW_MS: '5000', POD_NAME: '', ORCH_WORKER_ID: '', ORCH_WORKER_RUNNER: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  let err = '';
  let finished = false;
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((resolve) =>
    child.on('close', (code) => {
      finished = true;
      resolve(code);
    }),
  );
  return { child, stdout: () => out, stderr: () => err, exited, done: () => finished };
}

interface Call {
  method: string;
  route: string;
  status: number;
  at: number;
}

interface InLoop {
  out: string[];
  err: () => string;
  calls: Call[];
  abort: AbortController;
  done: Promise<number>;
  finished: () => boolean;
}

/**
 * A loop in this process against the harness's API, with a fetch that records every call and its answer; `answer`
 * may replace a call's answer.
 */
function inLoop(h: SliceHarness, over: Partial<WorkerSettings>, opts: { reportGraceMs?: number; answer?: (method: string, route: string, real: () => Promise<Response>) => Promise<Response> } = {}): InLoop {
  const base = h.orch.apiBaseUrl;
  const calls: Call[] = [];
  const out: string[] = [];
  let err = '';
  const realFetch = globalThis.fetch;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url).replace(base, '');
    const method = init?.method ?? 'GET';
    const real = () => realFetch(url, init);
    const res = opts.answer ? await opts.answer(method, route, real) : await real();
    calls.push({ method, route, status: res.status, at: Date.now() });
    return res;
  }) as typeof fetch;
  const abort = new AbortController();
  let finished = false;
  const settings: WorkerSettings = { api: base, workerId: 'w-1', cache: path.join(h.dir, 'cache'), agent: 'command', idleExitMs: 0, retryWindowMs: 5000, backoffMs: 50, backoffMaxMs: 400, ...over };
  const done = runWorkerLoop(settings, { fetch: fetchFn, out: (l) => out.push(l), err: (t) => void (err += t), termination: abort.signal, ...(opts.reportGraceMs !== undefined ? { reportGraceMs: opts.reportGraceMs } : {}) }).finally(() => (finished = true));
  loops.push({ abort, done });
  return { out, err: () => err, calls, abort, done, finished: () => finished };
}

/** A one-task remote run, ticked once so T1 is claimable, and a directory for the agent's markers. */
async function oneTask(config: ReturnType<typeof remoteRun> | ((bare: string) => ReturnType<typeof remoteRun>) = remoteRun) {
  const f = fixture();
  const h = await makeSlice({ graph: `nodes:\n${node('T1')}`, dir: f.dir, repo: f.repo, config: typeof config === 'function' ? config(f.bare) : config });
  harnesses.push(h);
  await h.orch.tick();
  const agentDir = path.join(f.dir, 'agent');
  mkdirSync(agentDir);
  agentDirs.push({ dir: agentDir, root: f.dir });
  const pid = () => Number(readFileSync(path.join(agentDir, 'pid'), 'utf8'));
  return { f, h, agentDir, pid, launch: () => h.store.listLaunches({ taskId: 'T1' })[0]! };
}

const slowCommand = (agentDir: string, steps: string[] = []) => `SLOW_AGENT_DIR=${agentDir} node --import ${tsxLoader} ${slowAgent} ${steps.join(' ')}`;
const lingerCommand = (agentDir: string, print = false) => `LINGER_AGENT_DIR=${agentDir} node --import ${tsxLoader} ${lingerAgent}${print ? ' print' : ''}`;

/** Tick the daemon every 200 ms until `pred` holds. */
async function tickUntil(h: SliceHarness, pred: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await h.orch.tick();
    await delay(200);
  }
}

describe('slice: the runner filter (ORCH_WORKER_RUNNER)', () => {
  it('a claude-code loop works the claude-code task, the opencode launch stays claimable, and its claims carry runner claude-code', async () => {
    const f = fixture();
    // The opencode launch is parked first, so a claim without a filter would take it (the oldest).
    const h = await makeSlice({ graph: `nodes:\n${node('T1')}\n${node('T2')}`, dir: f.dir, repo: f.repo, config: { ...remoteRun(f.bare, { capacity: 1, runner: { kind: 'opencode' } }), leaseTtlMs: 60_000 } });
    harnesses.push(h);
    await h.orch.tick();
    expect(h.orch.setConfig({ runnerKind: 'claude-code', capacity: 2 })).toMatchObject({ ok: true });
    await h.orch.tick();
    const [oc] = h.store.listLaunches({ taskId: 'T1' });
    const [cc] = h.store.listLaunches({ taskId: 'T2' });
    expect(oc).toMatchObject({ status: 'claimable', runner: 'opencode' });
    expect(cc).toMatchObject({ status: 'claimable', runner: 'claude-code' });

    const w = startLoop(h, { POD_NAME: 'w-1', ORCH_WORKER_AGENT: 'scripted', ORCH_WORKER_CACHE: path.join(f.dir, 'cache'), ORCH_WORKER_RUNNER: 'claude-code', ORCH_WORKER_MAX_LAUNCHES: '1' });
    expect(await w.exited, w.stderr()).toBe(0);
    expect(lines(w.stdout(), 'claimed')[0]).toContain(' T2');
    expect(lines(w.stdout(), 'report accepted')).toHaveLength(1);
    expect(['submitted', 'done']).toContain(h.orch.entry('T2').status.kind);
    expect(h.store.getLaunch(oc!.launchId)?.status).toBe('claimable');
    const claims = h.store.listEvents({ kind: 'operator.claim' });
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) expect(c.payload).toMatchObject({ workerId: 'w-1', access: 'remote', runner: 'claude-code' });
  }, 120_000);
});

describe('slice: a launch the daemon ended (a heartbeat answered 401)', () => {
  it('cancelled: the agent is stopped within 5 s, agent-ended then ended, no release, and the loop claims again', async () => {
    const c = await oneTask();
    const w = startLoop(c.h, { POD_NAME: 'w-1', ORCH_WORKER_AGENT: 'command', ORCH_WORKER_COMMAND: slowCommand(c.agentDir), ORCH_WORKER_CACHE: path.join(c.f.dir, 'cache'), ORCH_WORKER_RUNNER: 'claude-code' });
    await until(() => existsSync(path.join(c.agentDir, 'ready')) || w.done(), 'the agent to be ready');
    expect(w.done(), `${w.stdout()}\n${w.stderr()}`).toBe(false);
    const pid = c.pid();
    const launchId = c.launch().launchId;
    expect(c.h.orch.cancel('T1', 'the test cancels it')).toMatchObject({ ok: true });
    await c.h.orch.tick();
    const t0 = Date.now();
    await until(() => !pidAlive(pid), `the agent ${pid} to be gone`, 5000);
    expect(Date.now() - t0).toBeLessThan(5000);
    await until(() => lines(w.stdout(), 'ended').length === 1, 'the ended line', 10_000);
    const all = w.stdout().split('\n');
    expect(lineAt(all, 'agent-ended')).toBeGreaterThanOrEqual(0);
    expect(lineAt(all, 'agent-ended')).toBeLessThan(lineAt(all, 'ended'));
    expect(all[lineAt(all, 'agent-ended')]).toContain(launchId);
    expect(c.h.store.listEvents({ kind: 'launch.released', launchId })).toHaveLength(0);
    // The loop goes on: another claim follows the ended launch.
    await until(() => c.h.store.listEvents({ kind: 'operator.claim' }).length >= 2, 'another claim', 10_000);
    w.child.kill('SIGTERM');
    expect(await w.exited, w.stderr()).toBe(0);
  }, 120_000);

  it('stuck: the daemon fails the silent launch as stuck, the agent is gone within 3 s, one attempt is spent and nothing is released', async () => {
    const c = await oneTask((bare) => remoteRun(bare, { health: { stuckAfterMs: 1000, stuckFailAfterMs: 2000 } }));
    const w = startLoop(c.h, { POD_NAME: 'w-1', ORCH_WORKER_AGENT: 'command', ORCH_WORKER_COMMAND: slowCommand(c.agentDir), ORCH_WORKER_CACHE: path.join(c.f.dir, 'cache'), ORCH_WORKER_RUNNER: 'claude-code', ORCH_WORKER_MAX_LAUNCHES: '1' });
    await until(() => existsSync(path.join(c.agentDir, 'ready')) || w.done(), 'the agent to be ready');
    const pid = c.pid();
    const launchId = c.launch().launchId;
    await tickUntil(c.h, () => c.h.store.getLaunch(launchId)?.endReason !== undefined, 'the launch to end');
    const t0 = Date.now();
    expect(c.h.store.getLaunch(launchId)?.endReason).toBe('stuck');
    await until(() => !pidAlive(pid), `the agent ${pid} to be gone`, 3000);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await w.exited, w.stderr()).toBe(0);
    expect(lines(w.stdout(), 'agent-ended')).toHaveLength(1);
    expect(c.h.orch.entry('T1').attempts).toBe(1);
    expect(c.h.store.listEvents({ kind: 'operator.release' }).filter((e) => JSON.stringify(e.payload).includes(launchId) || e.launchId === launchId)).toHaveLength(0);
    expect(c.h.store.listEvents({ kind: 'launch.released', launchId })).toHaveLength(0);
  }, 120_000);

  it('reported: the agent keeps reportGraceMs after the 401 and is then stopped; agent-ended then report accepted', async () => {
    const c = await oneTask();
    const w = inLoop(c.h, { command: lingerCommand(c.agentDir), runnerKinds: ['claude-code'], maxLaunches: 1 }, { reportGraceMs: 1000 });
    await until(() => existsSync(path.join(c.agentDir, 'submitted')) || w.finished(), 'the submit');
    expect(readFileSync(path.join(c.agentDir, 'submitted'), 'utf8')).toMatch(/^200 /);
    const pid = c.pid();
    // Right after the submit: the tick ends the reported launch, so the next heartbeat is answered 401 while the agent runs.
    await c.h.orch.tick();
    const revoked = () => w.calls.find((x) => x.route.endsWith('/heartbeat') && x.status === 401);
    await until(() => revoked() !== undefined, 'a heartbeat answered 401', 10_000);
    const t401 = revoked()!.at;
    expect(['submitted', 'done']).toContain(c.h.orch.entry('T1').status.kind);
    await delay(Math.max(0, t401 + 300 - Date.now()));
    expect(pidAlive(pid)).toBe(true);
    await until(() => !pidAlive(pid), `the agent ${pid} to be gone`, Math.max(0, t401 + 3000 - Date.now()));
    expect(await w.done).toBe(0);
    expect(lineAt(w.out, 'agent-ended')).toBeGreaterThanOrEqual(0);
    expect(lineAt(w.out, 'agent-ended')).toBeLessThan(lineAt(w.out, 'report accepted'));
  }, 120_000);

  it('an agent that exits within the grace is not stopped, and the usage it printed is recorded', async () => {
    const c = await oneTask();
    const w = inLoop(c.h, { command: lingerCommand(c.agentDir, true), runnerKinds: ['claude-code'], maxLaunches: 1 }, { reportGraceMs: 3000 });
    await until(() => existsSync(path.join(c.agentDir, 'submitted')) || w.finished(), 'the submit');
    await c.h.orch.tick();
    expect(await w.done).toBe(0);
    expect(lineAt(w.out, 'agent-ended')).toBe(-1);
    expect(lineAt(w.out, 'report accepted')).toBeGreaterThanOrEqual(0);
    expect(c.h.store.getLaunch(c.launch().launchId)).toMatchObject({ usageSource: 'worker', tokens: { input: 140, cachedInput: 40, output: 7 } });
  }, 120_000);

  it('a status read answered 500 after the 401 stops the agent at once, without the report grace', async () => {
    const c = await oneTask();
    let revokedAt: number | undefined;
    const w = inLoop(
      c.h,
      { command: lingerCommand(c.agentDir), runnerKinds: ['claude-code'], maxLaunches: 1 },
      {
        reportGraceMs: 30_000,
        answer: async (method, route, real) => {
          if (revokedAt !== undefined && method === 'GET' && route === '/v1/status') return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
          const res = await real();
          if (route.endsWith('/heartbeat') && res.status === 401) revokedAt ??= Date.now();
          return res;
        },
      },
    );
    await until(() => existsSync(path.join(c.agentDir, 'submitted')) || w.finished(), 'the submit');
    const pid = c.pid();
    await c.h.orch.tick();
    await until(() => revokedAt !== undefined, 'a heartbeat answered 401', 10_000);
    expect(['submitted', 'done']).toContain(c.h.orch.entry('T1').status.kind);
    await until(() => !pidAlive(pid), `the agent ${pid} to be gone`, 3000);
    expect(Date.now() - revokedAt!).toBeLessThan(3000);
    expect(w.calls.some((x) => x.method === 'GET' && x.route === '/v1/status' && x.status === 500)).toBe(true);
    expect(await w.done).toBe(0);
    expect(lineAt(w.out, 'agent-ended')).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('no clock of its own: with the stuck limits at 0, an agent silent for three lease TTLs still runs, and no status was read', async () => {
    const c = await oneTask();
    const w = inLoop(c.h, { command: slowCommand(c.agentDir), runnerKinds: ['claude-code'] });
    await until(() => existsSync(path.join(c.agentDir, 'ready')) || w.finished(), 'the agent to be ready');
    const pid = c.pid();
    const deadline = Date.now() + 3 * 3000 + 500;
    while (Date.now() < deadline) {
      await c.h.orch.tick();
      await delay(250);
    }
    expect(pidAlive(pid)).toBe(true);
    expect(c.launch().status).toBe('live');
    expect(w.calls.filter((x) => x.method === 'GET' && x.route === '/v1/status')).toEqual([]);
    expect(w.calls.filter((x) => x.route.endsWith('/heartbeat')).length).toBeGreaterThanOrEqual(8);
    expect(lineAt(w.out, 'agent-ended')).toBe(-1);
    w.abort.abort();
    await w.done;
  }, 120_000);
});
