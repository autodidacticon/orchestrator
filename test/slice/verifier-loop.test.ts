/**
 * The verifier loop (`orchestrator-verifier`) against a real daemon under `verifier.mode: remote`, over HTTP, with a
 * bare origin: scripted worker loops submit, the verifier loop claims each verify job, rebases, checks, pushes
 * `refs/verify/<jobId>` and posts the result, and the daemon publishes. Loops run as subprocesses.
 * See specs/verifier-pool.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteVerifierBackend } from '../../src/verify/remote.js';
import { gitIn, makeRepo, makeSlice, type SliceHarness, tsxLoader } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerTs = path.resolve(here, '../../src/worker/loop.ts');
const verifierTs = path.resolve(here, '../../src/verifier/loop.ts');

const harnesses: SliceHarness[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const h of harnesses.splice(0)) await h.cleanup();
});

// ---- copied from test/slice/worker-loop.test.ts (module-local there) ----

function fixture(): { dir: string; repo: string; bare: string } {
  // The real path: the check's `pwd` resolves symlinks (macOS /var -> /private/var).
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-verifier-slice-')));
  const repo = makeRepo(dir);
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  return { dir, repo, bare };
}
type Fixture = ReturnType<typeof fixture>;

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

function startLoop(h: SliceHarness, env: Record<string, string>, entry = workerTs): LoopRun {
  const child = spawn(process.execPath, ['--import', tsxLoader, entry], {
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

// ---- this file's helpers ----

/** A remote run under `verifier.mode: remote` with a `RemoteVerifierBackend`, built as test/slice/remote-verifier.test.ts builds it. */
async function remoteSlice(f: Fixture, graph: string, config: Record<string, unknown> = {}): Promise<SliceHarness> {
  let h!: SliceHarness;
  const backend = new RemoteVerifierBackend({
    repo: f.repo,
    integrationBranch: 'main',
    tempRoot: path.join(f.dir, 'run', 'verify'),
    checkCommand: () => h.orch.effective().config.checkCommand,
    checkTimeoutMs: 60_000,
  });
  const run = remoteRun(f.bare);
  h = await makeSlice({ graph, dir: f.dir, repo: f.repo, verifier: backend, config: { ...run, verifier: { mode: 'remote' }, checkCommand: 'pwd', ...config, git: { ...run.git, pushRetryBackoffMs: 0 } } });
  harnesses.push(h);
  return h;
}

const verifierEnv = (cache: string, extra: Record<string, string> = {}) => ({ ORCH_VERIFIER_CACHE: cache, ORCH_VERIFIER_BACKOFF_MS: '50', ORCH_VERIFIER_BACKOFF_MAX_MS: '400', ORCH_VERIFIER_ID: '', ...extra });
const startVerifier = (h: SliceHarness, env: Record<string, string>) => startLoop(h, env, verifierTs);

/** Tick the daemon until `pred` holds. */
async function tickUntil(h: SliceHarness, pred: () => boolean, what: string, loops: LoopRun[] = [], timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}:\n${loops.map((l) => `${l.stdout()}\n${l.stderr()}`).join('\n---\n')}`);
    await h.orch.tick();
    await new Promise((r) => setTimeout(r, 80));
  }
}

const verifyRefs = (f: Fixture) => gitIn(f.dir, 'ls-remote', f.bare, 'refs/verify/*');
const ofLine = (l: string) => {
  const [, id, event, jobId, taskId] = l.split(' ');
  return { id, event, jobId, taskId };
};

describe('slice: the verifier loop', () => {
  it('two scripted worker loops and one verifier loop work T1 -> T2 to done; the verifier claims, checks and verifies each job and exits 0', async () => {
    const f = fixture();
    const h = await remoteSlice(f, `nodes:\n${node('T1')}\n${node('T2', ['T1'])}`);
    await h.orch.tick();
    const vcache = path.join(f.dir, 'vcache');
    const w1 = startLoop(h, { POD_NAME: 'w-1', ORCH_WORKER_AGENT: 'scripted', ORCH_WORKER_CACHE: path.join(f.dir, 'cache-1') });
    const w2 = startLoop(h, { POD_NAME: 'w-2', ORCH_WORKER_AGENT: 'scripted', ORCH_WORKER_CACHE: path.join(f.dir, 'cache-2') });
    const v = startVerifier(h, verifierEnv(vcache, { POD_NAME: 'v-1', ORCH_VERIFIER_MAX_JOBS: '2' }));
    await tickUntilExited(h, [w1, w2, v]);
    expect(await v.exited, v.stderr()).toBe(0);
    expect(await w1.exited, w1.stderr()).toBe(0);
    expect(await w2.exited, w2.stderr()).toBe(0);
    // The loop can exit on max-jobs before the daemon has published and deleted the last ref.
    await tickUntil(h, () => ['T1', 'T2'].every((id) => h.orch.entry(id).status.kind === 'done') && verifyRefs(f) === '', 'both tasks done');

    expect(trailers(f.bare).sort()).toEqual(['T1', 'T2']);
    const out = v.stdout();
    for (const l of out.trim().split('\n')) expect(l, l).toMatch(/^verifier v-1 \S+ \S+ \S+$/);
    for (const task of ['T1', 'T2']) {
      const mine = out
        .trim()
        .split('\n')
        .map(ofLine)
        .filter((l) => l.taskId === task);
      expect(mine.map((l) => l.event)).toEqual(['claimed', 'check', 'verified']);
      const jobId = mine[0]!.jobId!;
      expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
      for (const l of mine) expect(l.jobId).toBe(jobId);
      expect(h.store.getJob(jobId)).toMatchObject({ taskId: task, status: 'published' });
    }
    expect(lines(out, 'max-jobs')).toHaveLength(1);
    // The check's output (`pwd`) names the job's worktree under the verifier's cache.
    expect(v.stderr()).toContain(`${path.join(vcache, 'verify')}${path.sep}`);
    expect(verifyRefs(f)).toBe('');
    expect(existsSync(path.join(f.dir, 'run', 'verify'))).toBe(false);
  }, 150_000);

  it('a failing check: T1 ends blocked naming checkFailed, its job is failed with the output, and the verifier prints checkFailed', async () => {
    const f = fixture();
    const h = await remoteSlice(f, `nodes:\n${node('T1')}`, { checkCommand: 'echo broken; exit 1', maxAttempts: 1 });
    await h.orch.tick();
    const w = startLoop(h, { POD_NAME: 'w-1', ORCH_WORKER_AGENT: 'scripted', ORCH_WORKER_CACHE: path.join(f.dir, 'cache-1'), ORCH_WORKER_MAX_LAUNCHES: '1' });
    const v = startVerifier(h, verifierEnv(path.join(f.dir, 'vcache'), { POD_NAME: 'v-1', ORCH_VERIFIER_MAX_JOBS: '1' }));
    await tickUntilExited(h, [w, v]);
    expect(await v.exited, v.stderr()).toBe(0);
    await tickUntil(h, () => h.orch.entry('T1').status.kind === 'blocked', 'T1 blocked', [w, v]);
    expect(JSON.stringify(h.orch.entry('T1').status)).toContain('checkFailed');
    const jobs = h.store.listJobs({ taskId: 'T1' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'failed', failureKind: 'checkFailed' });
    expect(jobs[0]!.output).toContain('broken');
    const failed = lines(v.stdout(), 'checkFailed');
    expect(failed).toHaveLength(1);
    expect(ofLine(failed[0]!)).toMatchObject({ jobId: jobs[0]!.jobId, taskId: 'T1' });
  }, 150_000);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`a verifier loop with nothing to claim exits 0 on ${signal} with a terminating line and releases nothing`, async () => {
      const f = fixture();
      const h = await remoteSlice(f, `nodes:\n${node('T1')}`);
      await h.orch.tick();
      const v = startVerifier(h, verifierEnv(path.join(f.dir, 'vcache'), { POD_NAME: 'v-1' }));
      await tickUntil(h, () => lines(v.stdout(), 'start').length === 1, 'the start line', [v]);
      // Let it claim (404) and wait at least once.
      await new Promise((r) => setTimeout(r, 300));
      v.child.kill(signal);
      expect(await v.exited, v.stderr()).toBe(0);
      expect(lines(v.stdout(), 'terminating')).toHaveLength(1);
      expect(h.store.listEvents({ kind: 'verify.released' })).toEqual([]);
    }, 60_000);
  }

  it('SIGTERM while the check runs: exit 0 within five seconds, the job is released with podTerminating, and a second verifier loop finishes it', async () => {
    const f = fixture();
    const first = path.join(f.dir, 'first');
    const h = await remoteSlice(f, `nodes:\n${node('T1')}`, { checkCommand: `if [ -e ${first} ]; then exit 0; fi; touch ${first}; sleep 60` });
    await h.orch.tick();
    const w = startLoop(h, { POD_NAME: 'w-1', ORCH_WORKER_AGENT: 'scripted', ORCH_WORKER_CACHE: path.join(f.dir, 'cache-1'), ORCH_WORKER_MAX_LAUNCHES: '1' });
    const v1 = startVerifier(h, verifierEnv(path.join(f.dir, 'vcache-1'), { POD_NAME: 'v-1' }));
    await tickUntil(h, () => existsSync(first), 'the first check', [w, v1], 90_000);
    const [claimed] = lines(v1.stdout(), 'claimed');
    const jobId = ofLine(claimed!).jobId!;
    const t0 = Date.now();
    v1.child.kill('SIGTERM');
    expect(await v1.exited, v1.stderr()).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(lines(v1.stdout(), 'terminating')).toHaveLength(1);
    expect(lines(v1.stdout(), 'released')).toHaveLength(1);
    const released = h.store.listEvents({ kind: 'verify.released' });
    expect(released).toHaveLength(1);
    expect(released[0]!.payload).toMatchObject({ jobId, verifierId: 'v-1', reason: 'podTerminating' });
    expect(verifyRefs(f)).toBe('');

    const v2 = startVerifier(h, verifierEnv(path.join(f.dir, 'vcache-2'), { POD_NAME: 'v-2', ORCH_VERIFIER_MAX_JOBS: '1' }));
    await tickUntilExited(h, [w, v2]);
    expect(await v2.exited, v2.stderr()).toBe(0);
    await tickUntil(h, () => h.orch.entry('T1').status.kind === 'done', 'T1 done', [v2]);
    expect(ofLine(lines(v2.stdout(), 'claimed')[0]!).jobId).toBe(jobId);
    expect(lines(v2.stdout(), 'verified')).toHaveLength(1);
    expect(h.store.getJob(jobId)).toMatchObject({ status: 'published' });
  }, 150_000);
});
