/**
 * The usage post of the remote worker loop (`orchestrator-worker`): the loop keeps the tail of the command agent's
 * standard output, parses the Claude Code result object at its end, and posts it to `POST /v1/launches/:id/usage` as
 * the last step of the launch. Loops run as subprocesses against a real daemon with a bare origin, as in
 * worker-loop.test.ts (whose helpers are copied here). See specs/worker-pool "Usage post".
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { gitIn, makeRepo, makeSlice, type SliceHarness, tsxLoader } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const loopTs = path.resolve(here, '../../src/worker/loop.ts');
const usageAgent = path.resolve(here, '../agents/usage-agent.ts');

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

/** Kill the pid the waiting agent recorded, only while its command line still names the test's directory (not a recycled pid). */
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
  if (command.includes(root) || command.includes(usageAgent)) process.kill(pid, 'SIGKILL');
}

afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  // The agent runs in a process group of its own: killing the loop does not end it.
  for (const a of agentDirs.splice(0)) killOwnAgent(a.dir, a.root);
  for (const h of harnesses.splice(0)) await h.cleanup();
});

function fixture(): { dir: string; repo: string; bare: string } {
  // The real path: the agent's process.cwd() resolves symlinks (macOS /var -> /private/var).
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-worker-usage-')));
  const repo = makeRepo(dir);
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  return { dir, repo, bare };
}

const MODEL = 'claude-opus-5-5';

const remoteRun = (bare: string, budgets?: Record<string, unknown>) => ({
  leaseTtlMs: 60_000,
  apiBaseUrl: 'http://orchestrator.example:8080',
  runner: { mode: 'pull' as const, access: 'remote' as const, claimWindowMs: 60_000 },
  git: { pushIntegration: true, originUrl: bare, fetchIntervalMs: 0 },
  health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0 },
  ...(budgets ? { budgets: { maxLaunchMs: 0, maxRunCostUsd: 0, prices: {}, ...budgets } } : {}),
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
  launch: () => ReturnType<SliceHarness['store']['listLaunches']>[number];
}

/** A one-task remote run and one loop with the usage agent (or the scripted agent), which works one launch and exits. */
async function startCase(o: { flags?: string[]; budgets?: Record<string, unknown>; agent?: 'scripted' } = {}): Promise<Case> {
  const f = fixture();
  const h = await makeSlice({ graph: `nodes:\n${node('T1')}`, dir: f.dir, repo: f.repo, config: remoteRun(f.bare, o.budgets) });
  harnesses.push(h);
  await h.orch.tick();
  const agentDir = path.join(f.dir, 'agent');
  mkdirSync(agentDir);
  agentDirs.push({ dir: agentDir, root: f.dir });
  const w = startLoop(h, {
    POD_NAME: 'w-1',
    ORCH_WORKER_CACHE: path.join(f.dir, 'cache'),
    ORCH_WORKER_MAX_LAUNCHES: '1',
    ...(o.agent === 'scripted'
      ? { ORCH_WORKER_AGENT: 'scripted' }
      : { ORCH_WORKER_AGENT: 'command', ORCH_WORKER_COMMAND: `node --import ${tsxLoader} ${usageAgent} {briefJson} {taskId} {launchId} ${(o.flags ?? []).join(' ')}`, USAGE_AGENT_DIR: agentDir }),
  });
  return { f, h, w, agentDir, launch: () => h.store.listLaunches({ taskId: 'T1' })[0]! };
}

const status = async (h: SliceHarness) => (await (await fetch(`${h.orch.apiBaseUrl}/v1/status`)).json()) as Record<string, unknown>;
const usageEvents = (c: Case, kind: 'launch.usage' | 'operator.usage') => c.h.store.listEvents({ kind }).filter((e) => kind === 'operator.usage' || e.launchId === c.launch().launchId);

describe('slice: the worker loop posts the usage its agent printed', () => {
  it('a reported cost: the posted cost and tokens are on the launch row, in launch.usage and in /v1/status', async () => {
    const c = await startCase();
    expect(await c.w.exited, c.w.stderr()).toBe(0);
    const launch = c.launch();
    expect(launch).toMatchObject({ usageSource: 'worker', costUsd: 0.25, costSource: 'reported', tokens: { input: 140, cachedInput: 40, output: 7 } });
    expect(usageEvents(c, 'launch.usage')).toHaveLength(1);
    expect(usageEvents(c, 'operator.usage')).toHaveLength(1);
    const cost = (await status(c.h))['cost'] as Record<string, unknown>;
    expect((cost['byTask'] as Record<string, number>)['T1']).toBe(0.25);
    expect(lines(c.w.stdout(), 'usage')).toEqual([`worker w-1 usage ${launch.launchId} T1`]);
    expect(lines(c.w.stdout(), 'report accepted')).toHaveLength(1);
    // The usage line is the launch's last step, after the verdict.
    const out = c.w.stdout().trim().split('\n');
    expect(out.indexOf(`worker w-1 usage ${launch.launchId} T1`)).toBeGreaterThan(out.indexOf(`worker w-1 report accepted ${launch.launchId} T1`));
  }, 120_000);

  it('tokens without a cost are priced by the daemon from budgets.prices for the claim model', async () => {
    const c = await startCase({ flags: ['no-cost'], budgets: { prices: { [MODEL]: { inputPerMTok: 100, outputPerMTok: 1000 } } } });
    expect(await c.w.exited, c.w.stderr()).toBe(0);
    const launch = c.launch();
    expect(launch.model).toBe(MODEL);
    expect(launch).toMatchObject({ usageSource: 'worker', costSource: 'priced', tokens: { input: 140, cachedInput: 40, output: 7 } });
    expect(launch.costUsd).toBeGreaterThan(0);
    expect(usageEvents(c, 'launch.usage')).toHaveLength(1);
    expect(lines(c.w.stdout(), 'usage')).toHaveLength(1);
  }, 120_000);

  it('the budget: a posted cost of 0.25 over budgets.maxRunCostUsd 0.1 pauses the run on the next tick', async () => {
    const c = await startCase({ budgets: { maxRunCostUsd: 0.1 } });
    expect(await c.w.exited, c.w.stderr()).toBe(0);
    expect(c.launch().costUsd).toBe(0.25);
    await c.h.orch.tick();
    expect(await status(c.h)).toMatchObject({ paused: true, pausedReason: 'costBudget' });
  }, 120_000);

  it('no object: an agent that prints text only leaves the launch without usage and posts nothing', async () => {
    const c = await startCase({ flags: ['no-object'] });
    expect(await c.w.exited, c.w.stderr()).toBe(0);
    const launch = c.launch();
    expect(launch.usageSource).toBeUndefined();
    expect(launch.tokens).toBeUndefined();
    expect(launch.costUsd).toBeUndefined();
    expect(usageEvents(c, 'operator.usage')).toHaveLength(0);
    expect(lines(c.w.stdout(), 'usage')).toHaveLength(0);
    expect(lines(c.w.stdout(), 'report accepted')).toHaveLength(1);
  }, 120_000);

  it('no report: the usage of an agent that exits without a report is recorded, and the launch is released as today', async () => {
    const c = await startCase({ flags: ['no-report'] });
    expect(await c.w.exited, c.w.stderr()).toBe(0);
    const launch = c.launch();
    expect(lines(c.w.stdout(), 'released')).toHaveLength(1);
    expect(c.w.stderr()).toMatch(/released: the agent exited without a report -> 200/);
    expect(c.h.store.listEvents({ kind: 'launch.released', launchId: launch.launchId })).toHaveLength(1);
    expect(c.h.store.getLaunch(launch.launchId)).toMatchObject({ usageSource: 'worker', costUsd: 0.25, costSource: 'reported' });
    expect(lines(c.w.stdout(), 'usage')).toHaveLength(1);
    const out = c.w.stdout().trim().split('\n');
    expect(out.indexOf(`worker w-1 usage ${launch.launchId} T1`)).toBeGreaterThan(out.indexOf(`worker w-1 released ${launch.launchId} T1`));
  }, 120_000);

  it('a terminated launch: SIGTERM to the loop hands the launch back with kept: true, then posts the usage the agent printed', async () => {
    const c = await startCase({ flags: ['wait'] });
    await until(() => existsSync(path.join(c.agentDir, 'ready')) || c.w.done(), 'the agent to be ready');
    expect(c.w.done(), `${c.w.stdout()}\n${c.w.stderr()}`).toBe(false);
    c.w.child.kill('SIGTERM');
    expect(await c.w.exited, c.w.stderr()).toBe(0);
    const launch = c.launch();
    const released = c.h.store.listEvents({ kind: 'launch.released', launchId: launch.launchId });
    expect(released).toHaveLength(1);
    expect(released[0]!.payload).toMatchObject({ reason: 'podTerminating', keep: true, kept: true });
    expect(c.h.store.getLaunch(launch.launchId)).toMatchObject({ usageSource: 'worker', costUsd: 0.25, costSource: 'reported' });
    expect(lines(c.w.stdout(), 'usage')).toHaveLength(1);
  }, 120_000);

  it('the scripted agent: no usage is posted', async () => {
    const c = await startCase({ agent: 'scripted' });
    expect(await c.w.exited, c.w.stderr()).toBe(0);
    expect(lines(c.w.stdout(), 'report accepted')).toHaveLength(1);
    expect(usageEvents(c, 'operator.usage')).toHaveLength(0);
    expect(lines(c.w.stdout(), 'usage')).toHaveLength(0);
  }, 120_000);
});
