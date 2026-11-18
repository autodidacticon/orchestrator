/**
 * The remote worker loop (`orchestrator-worker`) against a real daemon over HTTP, with a bare origin: loops run as
 * subprocesses, clone origin into their caches, and work remote launches with the scripted agent or a command-mode
 * agent. See specs/worker-pool.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cloneDirFor } from '../../src/worker/clone.js';
import { gitIn, makeRepo, makeSlice, type SliceHarness, tsxLoader } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const loopTs = path.resolve(here, '../../src/worker/loop.ts');
const fallbackAgent = path.resolve(here, '../agents/fallback-agent.ts');

const harnesses: SliceHarness[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const h of harnesses.splice(0)) await h.cleanup();
});

function fixture(): { dir: string; repo: string; bare: string } {
  // The real path: the agent's process.cwd() resolves symlinks (macOS /var -> /private/var).
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-worker-loop-')));
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

/** Tick the daemon until every loop has exited (the loops do the work over HTTP meanwhile). */
async function tickUntilExited(h: SliceHarness, loops: LoopRun[], timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!loops.every((l) => l.done())) {
    if (Date.now() > deadline) throw new Error(`loops did not exit:\n${loops.map((l) => `${l.stdout()}\n${l.stderr()}`).join('\n---\n')}`);
    await h.orch.tick();
    await new Promise((r) => setTimeout(r, 80));
  }
}

const lines = (text: string, event: string) => text.split('\n').filter((l) => l.split(' ').slice(2, 2 + event.split(' ').length).join(' ') === event);
const trailers = (bare: string) => gitIn(bare, 'log', '--first-parent', '--format=%(trailers:key=Orchestrator-Task,valueonly)', 'main').split('\n').map((s) => s.trim()).filter(Boolean);

describe('slice: the remote worker loop', () => {
  it('two scripted loops work a three-task chain to done, publish each task once to origin, and exit 0 when the run is finished', async () => {
    const f = fixture();
    const h = await makeSlice({ graph: `nodes:\n${node('T1')}\n${node('T2', ['T1'])}\n${node('T3', ['T2'])}`, dir: f.dir, repo: f.repo, realVerifier: true, config: remoteRun(f.bare) });
    harnesses.push(h);
    await h.orch.tick();
    const cache = (n: number) => path.join(f.dir, `cache-${n}`);
    const w1 = startLoop(h, { POD_NAME: 'w-1', ORCH_WORKER_AGENT: 'scripted', ORCH_WORKER_CACHE: cache(1) });
    const w2 = startLoop(h, { POD_NAME: 'w-2', ORCH_WORKER_AGENT: 'scripted', ORCH_WORKER_CACHE: cache(2) });
    await tickUntilExited(h, [w1, w2]);
    expect(await w1.exited, w1.stderr()).toBe(0);
    expect(await w2.exited, w2.stderr()).toBe(0);

    for (const id of ['T1', 'T2', 'T3']) expect(h.orch.entry(id).status.kind).toBe('done');
    const status = (await (await fetch(`${h.orch.apiBaseUrl}/v1/status`)).json()) as Record<string, unknown>;
    expect(status['finished']).toBe(true);
    // One trailer per task on origin's integration branch, each task once.
    expect(trailers(f.bare).sort()).toEqual(['T1', 'T2', 'T3']);
    // Each README line the scripted agent appended is on origin's main.
    const readme = gitIn(f.bare, 'show', 'main:README.md');
    for (const id of ['T1', 'T2', 'T3']) expect(readme).toMatch(new RegExp(`^- ${id} by worker w-[12]$`, 'm'));

    // Exactly one `report accepted` line per task a loop worked; three in all.
    const accepted = [w1, w2].map((w) => lines(w.stdout(), 'report accepted'));
    const claimed = [w1, w2].map((w) => lines(w.stdout(), 'claimed'));
    for (let i = 0; i < 2; i++) {
      const workedTasks = claimed[i]!.map((l) => l.split(' ').at(-1));
      expect(new Set(workedTasks).size).toBe(workedTasks.length);
      expect(accepted[i]!.map((l) => l.split(' ').at(-1)).sort()).toEqual([...workedTasks].sort());
    }
    expect(accepted[0]!.length + accepted[1]!.length).toBe(3);
    expect([...accepted[0]!, ...accepted[1]!].map((l) => l.split(' ').at(-1)).sort()).toEqual(['T1', 'T2', 'T3']);
    // Every stdout line has the form `worker <id> <event> <launchId> <taskId>`.
    for (const [w, id] of [
      [w1, 'w-1'],
      [w2, 'w-2'],
    ] as const) {
      for (const l of w.stdout().trim().split('\n')) expect(l.startsWith(`worker ${id} `), l).toBe(true);
      expect(lines(w.stdout(), 'finished')).toHaveLength(1);
    }
  }, 120_000);

  it('starts the branch of a launch whose claim carries carry.interrupted.headSha at that sha', async () => {
    const f = fixture();
    const h = await makeSlice({ graph: `nodes:\n${node('T1')}`, dir: f.dir, repo: f.repo, realVerifier: true, config: remoteRun(f.bare) });
    harnesses.push(h);
    await h.orch.tick();
    // An earlier worker claims T1, commits on the claimed branch, pushes it, and releases with keep through the API.
    const post = async (route: string, body: Record<string, unknown>) => {
      const res = await fetch(`${h.orch.apiBaseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const first = await post('/v1/claims', { workerId: 'w-0', access: 'remote' });
    expect(first.status).toBe(200);
    const priorLaunchId = String(first.body['launchId']);
    const priorBranch = String(first.body['branch']);
    const prior = path.join(f.dir, 'prior');
    gitIn(f.dir, 'clone', '-q', f.bare, prior);
    gitIn(prior, 'checkout', '-q', '-b', priorBranch, String(first.body['baseSha']));
    gitIn(prior, 'commit', '-q', '--allow-empty', '-m', 'work in progress');
    const headSha = gitIn(prior, 'rev-parse', 'HEAD');
    gitIn(prior, 'push', '-q', 'origin', `HEAD:refs/heads/${priorBranch}`);
    const released = await post(`/v1/launches/${priorLaunchId}/release`, { workerId: 'w-0', reason: 'pod stopping', keep: true, headSha });
    expect(released).toMatchObject({ status: 200, body: { ok: true, outcome: 'unstarted' } });
    expect(h.orch.entry('T1').status.kind).toBe('unstarted');
    if (released.body['kept'] !== true) {
      // A kept release of a remote launch is ORC-23: until it lands, the release above keeps nothing, so the interrupted
      // context is seeded as that release stores it, from the real launch, branch and pushed head.
      const interrupted = { priorLaunchId, priorBranch, headSha, reason: 'pod stopping', interruptions: 1 };
      h.store.setEntry('T1', { ...h.orch.entry('T1'), carry: { interrupted }, interruptions: 1 });
    }
    await h.orch.tick();

    const w = startLoop(h, { POD_NAME: 'w-1', ORCH_WORKER_AGENT: 'scripted', ORCH_WORKER_CACHE: path.join(f.dir, 'cache') });
    await tickUntilExited(h, [w]);
    expect(await w.exited, w.stderr()).toBe(0);
    const launch = h.store.listLaunches({ taskId: 'T1' }).find((l) => l.launchId !== priorLaunchId);
    expect(launch!.briefJson?.['context']).toMatchObject({ interrupted: { headSha, priorBranch } });
    expect(lines(w.stdout(), 'claimed').map((l) => l.split(' ')[3])).toEqual([launch!.launchId]);
    // The worker's commit on the launch branch has the interrupted head as its parent.
    expect(gitIn(f.bare, 'rev-parse', `refs/heads/${launch!.branch}^`)).toBe(headSha);
    expect(h.orch.entry('T1').status.kind).toBe('done');
    expect(lines(w.stdout(), 'report accepted')).toHaveLength(1);
  }, 120_000);

  it('relays a fallback report.json the agent left, deletes it, and the task becomes submitted', async () => {
    const f = fixture();
    const h = await makeSlice({ graph: `nodes:\n${node('T1')}`, dir: f.dir, repo: f.repo, config: remoteRun(f.bare) });
    harnesses.push(h);
    await h.orch.tick();
    const cache = path.join(f.dir, 'cache');
    const w = startLoop(h, {
      POD_NAME: 'w-1',
      ORCH_WORKER_AGENT: 'command',
      ORCH_WORKER_COMMAND: `node --import ${tsxLoader} ${fallbackAgent} {briefJson} {taskId} {launchId}`,
      ORCH_WORKER_CACHE: cache,
      ORCH_WORKER_IDLE_EXIT_MS: '1000',
      AGENT_LOG: path.join(f.dir, 'agent.log'),
    });
    // No tick while the loop runs: the verifier does not start, so the task stays submitted.
    expect(await w.exited, w.stderr()).toBe(0);
    expect(h.orch.entry('T1').status.kind).toBe('submitted');
    const [launch] = h.store.listLaunches({ taskId: 'T1' });
    const report = h.store.listEvents({ kind: 'agent.report', launchId: launch!.launchId });
    expect(report).toHaveLength(1);
    // The loop pushed the branch and reported its HEAD as sealedSha.
    const tip = gitIn(f.bare, 'rev-parse', `refs/heads/${launch!.branch}`);
    expect(report[0]!.payload).toMatchObject({ kind: 'submit', seq: 1, sealedSha: tip });
    expect(existsSync(path.join(cloneDirFor(cache, f.bare), '.orchestrator', 'report.json'))).toBe(false);
    expect(lines(w.stdout(), 'relayed')).toHaveLength(1);
    expect(lines(w.stdout(), 'report accepted')).toHaveLength(1);
    expect(lines(w.stdout(), 'idle-exit')).toHaveLength(1);
  }, 120_000);

  it('reuses one clone for two launches in a row, and the second starts with a clean tree', async () => {
    const f = fixture();
    const h = await makeSlice({ graph: `nodes:\n${node('T1')}\n${node('T2')}`, dir: f.dir, repo: f.repo, config: remoteRun(f.bare) });
    harnesses.push(h);
    await h.orch.tick();
    const agentLog = path.join(f.dir, 'agent.log');
    const cache = path.join(f.dir, 'cache');
    const w = startLoop(h, {
      POD_NAME: 'w-1',
      ORCH_WORKER_AGENT: 'command',
      ORCH_WORKER_COMMAND: `node --import ${tsxLoader} ${fallbackAgent} {briefJson} {taskId} {launchId}`,
      ORCH_WORKER_CACHE: cache,
      ORCH_WORKER_IDLE_EXIT_MS: '1000',
      AGENT_LOG: agentLog,
    });
    expect(await w.exited, w.stderr()).toBe(0);
    const runs = readFileSync(agentLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(runs).toHaveLength(2);
    const clone = cloneDirFor(cache, f.bare);
    for (const r of runs) {
      expect(r['cwd']).toBe(clone);
      // The substituted {briefJson} is the clone's brief, whose worktree is the clone.
      expect(r['briefWorktree']).toBe(clone);
      expect(r['briefLaunchId']).toBe(r['launchId']);
      expect(r['env']).toEqual({ ORCH_LAUNCH_ID: r['launchId'], ORCH_WORKTREE: clone });
      const launch = h.store.getLaunch(String(r['launchId']))!;
      expect(r['branch']).toBe(launch.branch);
      expect(r['head']).toBe(launch.baseSha);
    }
    // The first agent left an untracked file, an untracked directory and an uncommitted change; the second saw none of it.
    // Only `.orchestrator/` is there besides the tracked files, ignored through the clone's .git/info/exclude.
    expect(runs[0]!['status']).toBe('!! .orchestrator/');
    expect(runs[1]!['status']).toBe('!! .orchestrator/');
    expect(readFileSync(path.join(clone, '.git', 'info', 'exclude'), 'utf8').split('\n')).toContain('/.orchestrator/');
    expect(existsSync(path.join(clone, `junk-${String(runs[0]!['taskId'])}.txt`))).toBe(false);
    expect(lines(w.stdout(), 'report accepted')).toHaveLength(2);
    for (const id of ['T1', 'T2']) expect(h.orch.entry(id).status.kind).toBe('submitted');
  }, 120_000);
});
