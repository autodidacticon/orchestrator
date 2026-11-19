/**
 * Graceful pod termination of the remote worker loop (`orchestrator-worker`): on SIGTERM or SIGINT the loop stops its
 * agent, commits work in progress, pushes the launch branch and releases with keep and reason `podTerminating`. Loops
 * run as subprocesses against a real daemon with a bare origin; the case of a claim in flight runs the loop in this
 * process with a fetch of its own. See specs/worker-pool "Pod termination".
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runWorkerLoop, workerSettings } from '../../src/worker/loop.js';
import { gitIn, makeRepo, makeSlice, type SliceHarness, tsxLoader } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const loopTs = path.resolve(here, '../../src/worker/loop.ts');
const slowAgent = path.resolve(here, '../agents/slow-agent.ts');

const harnesses: SliceHarness[] = [];
const children: ChildProcess[] = [];
const agentDirs: Array<{ dir: string; root: string }> = [];

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Kill the pid the slow agent recorded, only while its command line still names the test's directory (not a recycled pid). */
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
  if (command.includes(root) || command.includes(slowAgent)) process.kill(pid, 'SIGKILL');
}

afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  // The agent runs in a process group of its own: killing the loop does not end it.
  for (const a of agentDirs.splice(0)) killOwnAgent(a.dir, a.root);
  for (const h of harnesses.splice(0)) await h.cleanup();
});

function fixture(): { dir: string; repo: string; bare: string } {
  // The real path: the agent's process.cwd() resolves symlinks (macOS /var -> /private/var).
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-worker-term-')));
  const repo = makeRepo(dir);
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  return { dir, repo, bare };
}

const remoteRun = (bare: string) => ({
  leaseTtlMs: 60_000,
  apiBaseUrl: 'http://orchestrator.example:8080',
  runner: { mode: 'pull' as const, access: 'remote' as const, claimWindowMs: 60_000 },
  git: { pushIntegration: true, originUrl: bare, fetchIntervalMs: 0 },
  health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0 },
});

const node = (id: string, deps: string[] = []) => `  - { id: ${id}, deps: [${deps.join(', ')}], description: d, acceptanceCriteria: [a] }`;

interface LoopRun {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
  done: () => boolean;
}

function startLoop(h: SliceHarness, env: Record<string, string>): LoopRun {
  const child = spawn(process.execPath, ['--import', tsxLoader, loopTs], {
    env: { ...process.env, ORCH_API: h.orch.apiBaseUrl, ORCH_WORKER_BACKOFF_MS: '50', ORCH_WORKER_BACKOFF_MAX_MS: '400', ORCH_RETRY_WINDOW_MS: '5000', POD_NAME: '', ORCH_WORKER_ID: '', ...env },
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

const lines = (text: string, event: string) => text.split('\n').filter((l) => l.split(' ').slice(2, 2 + event.split(' ').length).join(' ') === event);

async function until(pred: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Case {
  f: ReturnType<typeof fixture>;
  h: SliceHarness;
  w: LoopRun;
  agentDir: string;
  /** The pid the agent recorded. */
  pid: () => number;
  launch: () => ReturnType<SliceHarness['launchOf']>;
}

/** A one-task remote run and a loop whose slow agent does `steps`; resolves once the agent's ready marker exists. */
async function startCase(steps: string[], env: Record<string, string> = {}): Promise<Case> {
  const f = fixture();
  const h = await makeSlice({ graph: `nodes:\n${node('T1')}`, dir: f.dir, repo: f.repo, config: remoteRun(f.bare) });
  harnesses.push(h);
  await h.orch.tick();
  const agentDir = path.join(f.dir, 'agent');
  mkdirSync(agentDir);
  agentDirs.push({ dir: agentDir, root: f.dir });
  const w = startLoop(h, {
    POD_NAME: 'w-1',
    ORCH_WORKER_AGENT: 'command',
    ORCH_WORKER_COMMAND: `node --import ${tsxLoader} ${slowAgent} ${steps.join(' ')}`,
    ORCH_WORKER_CACHE: path.join(f.dir, 'cache'),
    SLOW_AGENT_DIR: agentDir,
    ...env,
  });
  await until(() => existsSync(path.join(agentDir, 'ready')) || w.done(), 'the agent to be ready');
  expect(w.done(), `${w.stdout()}\n${w.stderr()}`).toBe(false);
  const pid = () => Number(readFileSync(path.join(agentDir, 'pid'), 'utf8'));
  return { f, h, w, agentDir, pid, launch: () => h.store.listLaunches({ taskId: 'T1' })[0]! };
}

const released = (c: Case) => c.h.store.listEvents({ kind: 'launch.released', launchId: c.launch().launchId });
const operatorReleases = (c: Case) => c.h.store.listEvents({ kind: 'operator.release' });
const tipOf = (c: Case) => gitIn(c.f.bare, 'rev-parse', `refs/heads/${c.launch().branch}`);

async function expectAgentGone(pid: number): Promise<void> {
  // An orphaned agent may linger as a zombie for a moment until it is reaped.
  await until(() => !pidAlive(pid), `the agent ${pid} to be gone`, 5000);
}

describe('slice: the worker loop on SIGTERM', () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`${signal}, uncommitted work: commits both files as work in progress, pushes it, and is released with keep (podTerminating)`, async () => {
      const c = await startCase(['modify', 'untracked']);
      const agentPid = c.pid();
      c.w.child.kill(signal);
      expect(await c.w.exited, c.w.stderr()).toBe(0);
      expect(lines(c.w.stdout(), 'terminating')).toHaveLength(1);
      expect(lines(c.w.stdout(), 'released')).toHaveLength(1);

      const ev = released(c);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.payload).toMatchObject({ reason: 'podTerminating', keep: true, kept: true });
      const headSha = String((ev[0]!.payload as Record<string, unknown>)['headSha']);
      expect(headSha).toMatch(/^[0-9a-f]{40}$/);
      // Origin's branch tip is the pushed head: one commit over the base with both files and nothing under .orchestrator/.
      expect(tipOf(c)).toBe(headSha);
      expect(gitIn(c.f.bare, 'rev-parse', `${headSha}^`)).toBe(c.launch().baseSha);
      expect(gitIn(c.f.bare, 'show', '--name-only', '--format=', headSha).split('\n').sort()).toEqual(['README.md', 'new-file.txt']);
      expect(gitIn(c.f.bare, 'ls-tree', '-r', '--name-only', headSha).split('\n').filter((p) => p.startsWith('.orchestrator'))).toEqual([]);
      expect(gitIn(c.f.bare, 'show', `${headSha}:README.md`)).toContain('- changed by the slow agent');

      const entry = c.h.orch.entry('T1');
      expect(entry.status.kind).toBe('unstarted');
      expect(entry.attempts).toBe(0);
      expect(entry.interruptions).toBe(1);
      expect(entry.carry?.interrupted).toMatchObject({ reason: 'podTerminating', headSha, wipCommit: headSha });
      await expectAgentGone(agentPid);

      if (signal === 'SIGTERM') {
        // The next claim starts at the kept head.
        await c.h.orch.tick();
        const res = await fetch(`${c.h.orch.apiBaseUrl}/v1/claims`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workerId: 'w-2', access: 'remote' }) });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { carry?: { interrupted?: { headSha?: string } } };
        expect(body.carry?.interrupted?.headSha).toBe(headSha);
      }
    }, 120_000);
  }

  it('committed work: no further commit, headSha is the agent commit, and no wipCommit', async () => {
    const c = await startCase(['commit']);
    const agentCommit = readFileSync(path.join(c.agentDir, 'commit'), 'utf8').trim();
    c.w.child.kill('SIGTERM');
    expect(await c.w.exited, c.w.stderr()).toBe(0);
    const ev = released(c);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ reason: 'podTerminating', keep: true, kept: true, headSha: agentCommit });
    expect(tipOf(c)).toBe(agentCommit);
    const interrupted = c.h.orch.entry('T1').carry?.interrupted;
    expect(interrupted).toMatchObject({ headSha: agentCommit, reason: 'podTerminating' });
    expect(interrupted).not.toHaveProperty('wipCommit');
  }, 120_000);

  it('no work: the release is answered kept: false, the task is unstarted with no carry, and the loop exits 0', async () => {
    const c = await startCase([]);
    c.w.child.kill('SIGTERM');
    expect(await c.w.exited, c.w.stderr()).toBe(0);
    const ev = released(c);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ reason: 'podTerminating', keep: true, kept: false, headSha: c.launch().baseSha });
    expect(c.w.stderr()).toMatch(/released: podTerminating keep -> 200 unstarted kept false/);
    const entry = c.h.orch.entry('T1');
    expect(entry.status.kind).toBe('unstarted');
    expect(entry.attempts).toBe(0);
    expect(entry.carry?.interrupted).toBeUndefined();
  }, 120_000);

  it('an agent that ignores SIGTERM is killed after ORCH_WORKER_AGENT_STOP_MS, and the launch is still handed back with keep', async () => {
    const c = await startCase(['ignore-term', 'modify'], { ORCH_WORKER_AGENT_STOP_MS: '300' });
    const agentPid = c.pid();
    c.w.child.kill('SIGTERM');
    expect(await c.w.exited, c.w.stderr()).toBe(0);
    expect(released(c)[0]!.payload).toMatchObject({ reason: 'podTerminating', keep: true, kept: true });
    await expectAgentGone(agentPid);
  }, 120_000);

  it('an agent behind a shell that stays its parent is still killed after the limit when it ignores SIGTERM', async () => {
    // `; true` keeps /bin/sh as the agent's parent: SIGTERM ends the shell, and only the SIGKILL to the group ends the agent.
    const c = await startCase(['ignore-term', 'modify', '; true'], { ORCH_WORKER_AGENT_STOP_MS: '300' });
    const agentPid = c.pid();
    const t0 = Date.now();
    c.w.child.kill('SIGTERM');
    expect(await c.w.exited, c.w.stderr()).toBe(0);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(released(c)[0]!.payload).toMatchObject({ reason: 'podTerminating', keep: true, kept: true });
    await expectAgentGone(agentPid);
  }, 120_000);

  it('two SIGTERM in a row record one operator.release event', async () => {
    const c = await startCase(['modify']);
    c.w.child.kill('SIGTERM');
    c.w.child.kill('SIGTERM');
    expect(await c.w.exited, c.w.stderr()).toBe(0);
    expect(operatorReleases(c)).toHaveLength(1);
    expect(lines(c.w.stdout(), 'terminating')).toHaveLength(1);
    expect(released(c)[0]!.payload).toMatchObject({ reason: 'podTerminating', kept: true });
  }, 120_000);

  it('a failed push: exit 1, a push-failed line, no release, and the launch is still live', async () => {
    const c = await startCase(['modify']);
    renameSync(c.f.bare, `${c.f.bare}.moved`);
    c.w.child.kill('SIGTERM');
    expect(await c.w.exited, c.w.stderr()).toBe(1);
    expect(lines(c.w.stdout(), 'push-failed')).toHaveLength(1);
    expect(lines(c.w.stdout(), 'released')).toHaveLength(0);
    expect(c.w.stderr()).toMatch(/push-failed: /);
    expect(released(c)).toHaveLength(0);
    expect(c.launch().status).toBe('live');
  }, 120_000);

  it('the daemon unreachable: the work is pushed, no release is recorded, and the loop exits 1', async () => {
    const c = await startCase(['modify'], { ORCH_RETRY_WINDOW_MS: '500' });
    await c.h.server.close();
    c.w.child.kill('SIGTERM');
    expect(await c.w.exited, c.w.stderr()).toBe(1);
    expect(gitIn(c.f.bare, 'show', `${tipOf(c)}:README.md`)).toContain('- changed by the slow agent');
    expect(lines(c.w.stdout(), 'release-failed')).toHaveLength(1);
    expect(released(c)).toHaveLength(0);
  }, 120_000);

  it('a failed work-in-progress commit (index.lock): released with keep at the agent commit, no wipCommit', async () => {
    const c = await startCase(['commit', 'modify', 'lock']);
    const agentCommit = readFileSync(path.join(c.agentDir, 'commit'), 'utf8').trim();
    c.w.child.kill('SIGTERM');
    expect(await c.w.exited, c.w.stderr()).toBe(0);
    expect(c.w.stderr()).toMatch(/wip-commit T1: /);
    expect(released(c)[0]!.payload).toMatchObject({ reason: 'podTerminating', keep: true, kept: true, headSha: agentCommit });
    expect(tipOf(c)).toBe(agentCommit);
    expect(c.h.orch.entry('T1').carry?.interrupted).not.toHaveProperty('wipCommit');
  }, 120_000);

  it('a report left behind is relayed: the task is submitted and nothing is released', async () => {
    const c = await startCase(['commit', 'report']);
    c.w.child.kill('SIGTERM');
    expect(await c.w.exited, c.w.stderr()).toBe(0);
    expect(c.h.orch.entry('T1').status.kind).toBe('submitted');
    expect(lines(c.w.stdout(), 'relayed')).toHaveLength(1);
    expect(lines(c.w.stdout(), 'report accepted')).toHaveLength(1);
    expect(operatorReleases(c)).toHaveLength(0);
  }, 120_000);

  it('idle: a loop with nothing claimable exits 0 at once with a terminating line and releases nothing', async () => {
    const f = fixture();
    // No tick: nothing is claimable yet.
    const h = await makeSlice({ graph: `nodes:\n${node('T1')}`, dir: f.dir, repo: f.repo, config: remoteRun(f.bare) });
    harnesses.push(h);
    const w = startLoop(h, { POD_NAME: 'w-1', ORCH_WORKER_AGENT: 'scripted', ORCH_WORKER_CACHE: path.join(f.dir, 'cache'), ORCH_WORKER_BACKOFF_MS: '30000', ORCH_WORKER_BACKOFF_MAX_MS: '30000' });
    await until(() => lines(w.stdout(), 'start').length === 1, 'the start line');
    // Let the first claim be answered, so the loop is in its wait.
    await new Promise((r) => setTimeout(r, 1000));
    expect(lines(w.stdout(), 'claimed')).toHaveLength(0);
    const t0 = Date.now();
    w.child.kill('SIGTERM');
    expect(await w.exited, w.stderr()).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(lines(w.stdout(), 'terminating')).toHaveLength(1);
    expect(h.store.listEvents({ kind: 'operator.release' })).toHaveLength(0);
  }, 120_000);
});

describe('ORCH_WORKER_AGENT_STOP_MS', () => {
  it('is in the settings only when set', () => {
    const base = { ORCH_API: 'http://d', ORCH_WORKER_AGENT: 'scripted' };
    expect(workerSettings(base, () => 'h')).not.toHaveProperty('agentStopMs');
    expect(workerSettings({ ...base, ORCH_WORKER_AGENT_STOP_MS: '300' }, () => 'h').agentStopMs).toBe(300);
    expect(workerSettings({ ...base, ORCH_WORKER_AGENT_STOP_MS: '0' }, () => 'h').agentStopMs).toBe(0);
    expect(() => workerSettings({ ...base, ORCH_WORKER_AGENT_STOP_MS: '-1' })).toThrow(/ORCH_WORKER_AGENT_STOP_MS/);
  });
});

describe('the worker loop with a claim in flight', () => {
  it('awaits the claim, releases its launch without keep (podTerminating), starts no agent and claims no more', async () => {
    const calls: Array<{ method: string; route: string; body: Record<string, unknown> }> = [];
    let answerClaim: (r: Response) => void = () => undefined;
    let claimAsked: () => void = () => undefined;
    const asked = new Promise<void>((r) => (claimAsked = r));
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const route = String(url).replace('http://daemon.test', '');
      const method = init?.method ?? 'GET';
      calls.push({ method, route, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      if (route === '/v1/claims') {
        claimAsked();
        return new Promise<Response>((r) => (answerClaim = r));
      }
      if (route === '/v1/launches/L1/release') return new Response(JSON.stringify({ ok: true, outcome: 'unstarted' }), { status: 200 });
      return new Response('{}', { status: 500 });
    }) as typeof fetch;
    const out: string[] = [];
    const termination = new AbortController();
    const loop = runWorkerLoop(
      { api: 'http://daemon.test', workerId: 'w-1', cache: path.join(tmpdir(), 'orch-no-cache-used'), agent: 'command', command: 'touch /nonexistent/should-not-run', idleExitMs: 0, retryWindowMs: 1000, backoffMs: 1000, backoffMaxMs: 30_000 },
      { fetch: fetchFn, out: (l) => out.push(l), err: () => undefined, termination: termination.signal },
    );
    await asked;
    termination.abort();
    answerClaim(new Response(JSON.stringify({ launchId: 'L1', taskId: 'T1', token: 'tok', branch: 'task/T1/l1', baseSha: 'a'.repeat(40), repoUrl: '/nonexistent/origin.git', lease: { ttlMs: 60_000 } }), { status: 200 }));
    expect(await loop).toBe(0);
    expect(calls.filter((c) => c.route === '/v1/claims')).toHaveLength(1);
    const releases = calls.filter((c) => c.route.endsWith('/release'));
    expect(releases).toEqual([{ method: 'POST', route: '/v1/launches/L1/release', body: { workerId: 'w-1', reason: 'podTerminating' } }]);
    expect(out.some((l) => l.includes(' agent-start ') || l.includes(' checkout '))).toBe(false);
    expect(out).toContain('worker w-1 terminating - -');
    expect(out).toContain('worker w-1 released L1 T1');
  });
});
