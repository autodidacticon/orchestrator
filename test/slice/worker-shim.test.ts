/**
 * The remote worker loop with an agent that reports through the MCP shim the loop names in `.orchestrator/mcp.json`:
 * the shim runs in remote mode, so it pushes the launch branch and names its tip as `sealedSha`, and the loop has no
 * fallback report to relay. See specs/worker-pool "Clone cache" and specs/agent-protocol "MCP façade".
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cloneDirFor } from '../../src/worker/clone.js';
import { gitIn, makeRepo, makeSlice, type SliceHarness, tsxLoader } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const loopTs = path.resolve(here, '../../src/worker/loop.ts');
const mcpReportAgent = path.resolve(here, '../agents/mcp-report-agent.ts');

const harnesses: SliceHarness[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const h of harnesses.splice(0)) await h.cleanup();
});

function fixture(): { dir: string; repo: string; bare: string } {
  // The real path: the agent's process.cwd() resolves symlinks (macOS /var -> /private/var).
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-worker-shim-')));
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

const node = (id: string) => `  - { id: ${id}, deps: [], description: d, acceptanceCriteria: [a] }`;

interface LoopRun {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

function startLoop(h: SliceHarness, env: Record<string, string>): LoopRun {
  const base = { ...process.env } as Record<string, string>;
  // The loop's environment carries none of the shim's remote variables: the loop writes them into mcp.json.
  for (const k of ['ORCH_ACCESS', 'ORCH_WORKTREE', 'ORCH_BRANCH']) delete base[k];
  const child = spawn(process.execPath, ['--import', tsxLoader, loopTs], {
    env: { ...base, ORCH_API: h.orch.apiBaseUrl, ORCH_WORKER_BACKOFF_MS: '50', ORCH_WORKER_BACKOFF_MAX_MS: '400', ORCH_RETRY_WINDOW_MS: '5000', POD_NAME: '', ORCH_WORKER_ID: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  return { child, stdout: () => out, stderr: () => err, exited };
}

const lines = (text: string, event: string) => text.split('\n').filter((l) => l.split(' ').slice(2, 2 + event.split(' ').length).join(' ') === event);

describe('slice: the worker loop with an agent that reports through the shim', () => {
  it('the agent commits without pushing and submits through the report tool; the shim pushes and seals, and the loop relays nothing', async () => {
    const f = fixture();
    const h = await makeSlice({ graph: `nodes:\n${node('T1')}`, dir: f.dir, repo: f.repo, config: remoteRun(f.bare) });
    harnesses.push(h);
    await h.orch.tick();
    const cache = path.join(f.dir, 'cache');
    const agentLog = path.join(f.dir, 'agent.log');
    const w = startLoop(h, {
      POD_NAME: 'w-1',
      ORCH_WORKER_AGENT: 'command',
      ORCH_WORKER_COMMAND: `node --import ${tsxLoader} ${mcpReportAgent} {mcpConfig} {briefJson} {taskId}`,
      ORCH_WORKER_CACHE: cache,
      ORCH_WORKER_IDLE_EXIT_MS: '1000',
      AGENT_LOG: agentLog,
    });
    // No tick while the loop runs: the verifier does not start, so the task stays submitted.
    expect(await w.exited, w.stderr()).toBe(0);
    expect(h.orch.entry('T1').status.kind, w.stderr()).toBe('submitted');

    const [launch] = h.store.listLaunches({ taskId: 'T1' });
    const clone = cloneDirFor(cache, f.bare);
    const [run, ...more] = readFileSync(agentLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(more).toHaveLength(0);
    expect(run!['cwd']).toBe(clone);
    expect(run!['mcpPath']).toBe(path.join(clone, '.orchestrator', 'mcp.json'));
    expect(run!['shimEnv']).toMatchObject({ ORCH_ACCESS: 'remote', ORCH_WORKTREE: run!['cwd'], ORCH_BRANCH: launch!.branch, ORCH_LAUNCH_ID: launch!.launchId });

    // The shim pushed the agent's commit and reported it as sealedSha.
    const tip = gitIn(f.bare, 'rev-parse', `refs/heads/${launch!.branch}`);
    expect(tip).toBe(run!['head']);
    const report = h.store.listEvents({ kind: 'agent.report', launchId: launch!.launchId });
    expect(report).toHaveLength(1);
    expect(report[0]!.payload).toMatchObject({ kind: 'submit', seq: 1, sealedSha: tip });

    expect(lines(w.stdout(), 'report accepted')).toHaveLength(1);
    expect(lines(w.stdout(), 'relayed')).toHaveLength(0);
  }, 120_000);
});
