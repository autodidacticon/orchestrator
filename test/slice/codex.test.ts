import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../../src/agent/mcp-shim.js';
import { codexToolTimeoutSec, shimEnvPath } from '../../src/runner/codex.js';
import { pidAlive } from '../../src/runner/subprocess.js';
import { parseEnvFile } from '../../src/runner/shim-command.js';
import { fakeCodex, gitIn, makeSlice, single, type SliceHarness, tsxLoader } from './harness.js';

/**
 * Codex launches end to end without a model: the Codex runner composes its real template with
 * test/agents/fake-codex.ts in place of the `codex` executable, so no codex is needed on PATH.
 * See specs/worker-runners "Codex runner command composition" and "Codex usage parsing".
 */
let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

interface FakeArgs {
  argv: string[];
  cwd: string;
  model?: string;
  sandbox?: string;
  outFile?: string;
  flags: string[];
  overrides: Record<string, unknown>;
  promptBytes: number;
}

const ID = 'mcp_servers.orchestrator';
const GIT_EVENTS_TOKENS = { input: 40361, cachedInput: 32128, cacheWriteInput: 0, output: 260, reasoningOutput: 0 };

async function readArgs(h: SliceHarness, worktree: string): Promise<FakeArgs> {
  const file = path.join(worktree, '.orchestrator', 'fake-codex-args.json');
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as FakeArgs;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await h.orch.tick();
      await new Promise((r) => setTimeout(r, 60));
    }
  }
}

function usageEvents(h: SliceHarness, launchId: string) {
  return h.store.listEvents({ kind: 'launch.usage', launchId });
}

describe('codex slice (fake codex)', () => {
  it('composes the shim registration, approvals, timeouts, model and effort; a blockAndWait task round-trips its answer; usage is recorded', async () => {
    h = await makeSlice({ graph: single('blockAndWait:which db?'), kind: 'codex' });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'waiting');
    const launch = h.launchOf('T1');
    expect(launch.runner).toBe('codex');

    const args = await readArgs(h, launch.worktree);
    // -C was honoured and the prompt (brief.md) came on stdin.
    expect(args.argv[args.argv.indexOf('-C') + 1]).toBe(launch.worktree);
    expect(args.cwd).toBe(realpathSync(launch.worktree));
    expect(args.promptBytes).toBeGreaterThan(0);
    expect(args.flags).toEqual(expect.arrayContaining(['--json', '--ephemeral', '--ignore-user-config']));
    expect(args.sandbox).toBe('workspace-write');
    expect(args.outFile).toBe(path.join(launch.worktree, '.orchestrator', 'last-message.txt'));
    // The launch's model and effort were filled.
    expect(launch.model).toBeTruthy();
    expect(launch.effort).toBeTruthy();
    expect(args.model).toBe(launch.model);
    expect(args.overrides['model_reasoning_effort']).toBe(launch.effort);

    // The shim entry, with the env file instead of the token.
    const shimArgs = args.overrides[`${ID}.args`] as string[];
    expect(typeof args.overrides[`${ID}.command`]).toBe('string');
    expect(shimArgs.slice(-2)).toEqual(['--orch-env-file', shimEnvPath(launch.worktree)]);
    expect(shimArgs.some((a) => /mcp-shim\.(js|ts)$/.test(a))).toBe(true);
    expect(args.overrides[`${ID}.required`]).toBe(true);
    expect(args.overrides[`${ID}.startup_timeout_sec`]).toBe(30);
    expect(args.overrides[`${ID}.tool_timeout_sec`]).toBe(codexToolTimeoutSec({}, h.config.maxWaitMs));
    expect(args.overrides[`${ID}.tool_timeout_sec`]).toBe(Math.ceil(h.config.maxWaitMs / 1000) + 60);
    // The approval keys: the policy, the server default, and one per shim tool.
    expect(args.overrides['approval_policy']).toBe('never');
    expect(args.overrides[`${ID}.default_tools_approval_mode`]).toBe('approve');
    for (const t of TOOL_NAMES) expect(args.overrides[`${ID}.tools.${t}.approval_mode`]).toBe('approve');
    expect(args.overrides).not.toHaveProperty('sandbox_workspace_write.network_access');

    // The token travels in a 0600 env file, never on argv.
    const envFile = shimEnvPath(launch.worktree);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(parseEnvFile(readFileSync(envFile, 'utf8'))).toMatchObject({ ORCH_LAUNCH_ID: launch.launchId, ORCH_TOKEN: launch.token, ORCH_COMMIT_POLICY: 'daemon' });
    expect(JSON.stringify(args.argv)).not.toContain(launch.token);
    expect(readFileSync(path.join(launch.worktree, '.orchestrator', 'fake-codex-args.json'), 'utf8')).not.toContain(launch.token);

    // The question round-trips over the HTTP API.
    expect(h.orch.answer('T1', 'postgres')).toEqual({ ok: true });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    expect(gitIn(h.repo, 'show', `${launch.branch}:T1.txt`)).toBe('answer: postgres');

    // Usage is read from the JSONL log once the fake has exited.
    await h.waitFor(() => usageEvents(h!, launch.launchId).length > 0);
    const row = h.store.getLaunch(launch.launchId)!;
    expect(row.runner).toBe('codex');
    expect(row.tokens).toEqual(GIT_EVENTS_TOKENS);
    expect(row.usageSource).toBe('codex');
    expect(usageEvents(h, launch.launchId)[0]!.payload).toMatchObject({ tokens: GIT_EVENTS_TOKENS, source: 'codex' });
    const log = readFileSync(path.join(h.config.dataDir, 'logs', `${launch.launchId}.log`), 'utf8');
    expect(log).toContain('Reading prompt from stdin...');
    expect(log.trimEnd().split('\n').pop()).toContain('"turn.completed"');
  });

  it('sums the usage of every turn.completed (two-turns.jsonl, a test decision)', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit', ', codexFixture: two-turns.jsonl'), kind: 'codex' });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    const [launch] = h.store.listLaunches({ taskId: 'T1' });
    await h.waitFor(() => usageEvents(h!, launch!.launchId).length > 0);
    expect(h.store.getLaunch(launch!.launchId)!.tokens).toEqual({ input: 3000, cachedInput: 1900, cacheWriteInput: 50, output: 400, reasoningOutput: 30 });
  });

  it('a submitDirty task is sealed by the daemon under the default codex commit policy', async () => {
    h = await makeSlice({ graph: single('submitDirty'), kind: 'codex' });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    const [launch] = h.store.listLaunches({ taskId: 'T1' });
    expect(launch!.commitPolicy).toBe('daemon');
    const [report] = h.store.listEvents({ kind: 'agent.report', launchId: launch!.launchId });
    expect(report!.payload).toMatchObject({ kind: 'submit', committedByOrchestrator: true });
    expect(gitIn(h.repo, 'log', '-1', '--format=%an', launch!.branch)).toBe('orchestrator');
    expect(gitIn(h.repo, 'show', `${launch!.branch}:T1.txt`)).toBe('T1 uncommitted');
    expect(gitIn(h.repo, 'show', '--name-only', '--format=', launch!.branch).split('\n')).toEqual(['T1.txt']);
  });

  it('killByLaunchId ends the fake', async () => {
    h = await makeSlice({ graph: single('hang'), kind: 'codex' });
    await h.orch.tick();
    const launch = h.launchOf('T1');
    await readArgs(h, launch.worktree);
    expect(pidAlive(launch.pid!)).toBe(true);
    await h.runner.killByLaunchId(launch.launchId);
    expect(pidAlive(launch.pid!)).toBe(false);
    // No process carrying the launch id is left: neither the shell nor the fake's node, whose -C names the worktree.
    expect(() => execFileSync('pgrep', ['-f', launch.launchId])).toThrow();
  });
});

describe('fake codex on its own', () => {
  it('honours -C, reads stdin, writes the -o file, prints the fixture on stdout and a progress line on stderr', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fake-codex-'));
    try {
      const wt = path.join(dir, 'wt');
      const elsewhere = path.join(dir, 'elsewhere');
      mkdirSync(path.join(wt, '.orchestrator'), { recursive: true });
      mkdirSync(elsewhere);
      const brief = { launchId: 'L1', taskId: 'T1', token: 'tok', apiBaseUrl: 'http://127.0.0.1:9', worktree: wt, branch: 'b', baseSha: 's', retryWindowMs: 100, fallbackPath: path.join(wt, '.orchestrator', 'report.json'), attempt: 1, launchNo: 1, task: { behavior: 'exitSilently' }, acceptanceCriteria: [] };
      writeFileSync(path.join(wt, '.orchestrator', 'brief.json'), JSON.stringify(brief));
      const outFile = path.join(dir, 'last.txt');
      const res = spawnSync('node', ['--import', tsxLoader, fakeCodex, 'exec', '--json', '-C', wt, '-c', 'k="v"', '-o', outFile, '-'], { cwd: elsewhere, input: 'the prompt', encoding: 'utf8' });
      expect(res.status).toBe(0);

      const fixture = readFileSync(path.resolve(fakeCodex, '../../fixtures/codex/git-events.jsonl'), 'utf8').trimEnd().split('\n');
      const lines = res.stdout.trimEnd().split('\n');
      expect(lines).toEqual(fixture);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ type: 'turn.completed' });
      expect(res.stderr.split('\n').some((l) => l.trim() && !l.trim().startsWith('{'))).toBe(true);
      expect(readFileSync(outFile, 'utf8')).toBe('Created probe.txt; git add failed under workspace-write.\n');

      const args = JSON.parse(readFileSync(path.join(wt, '.orchestrator', 'fake-codex-args.json'), 'utf8')) as FakeArgs;
      expect(args.cwd).toBe(realpathSync(wt));
      expect(args.promptBytes).toBe('the prompt'.length);
      expect(args.overrides).toEqual({ k: 'v' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
