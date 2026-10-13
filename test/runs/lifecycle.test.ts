import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pidAlive } from '../../src/runner/subprocess.js';
import { daemonState, health, listRuns, reviveDaemon, startDaemon, stopDaemon } from '../../src/runs/lifecycle.js';
import { readDaemonJson, resolveRepoPath, resolveRunConfig, runDirFor, runPaths } from '../../src/runs/runDir.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import { makeRepo, scriptedAgent, tsxLoader } from '../slice/harness.js';

let dirs: string[] = [];
let env: NodeJS.ProcessEnv;
let home: string;

function fresh(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'orch-runs-'));
  dirs.push(d);
  return d;
}

function configFor(repo: string, extra: Record<string, string | number> = {}): void {
  const lines = [
    `runnerCommand: "node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`,
    'checkCommand: "true"',
    'tickIntervalMs: 150',
    'leaseTtlMs: 8000',
    'retryWindowMs: 10000',
    'capacity: 2',
    ...Object.entries(extra).map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`),
  ];
  writeFileSync(path.join(repo, 'orchestrator.yaml'), `${lines.join('\n')}\n`);
}

async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('waitFor timed out');
}

afterEach(async () => {
  for (const r of await listRuns(env ?? process.env)) if (r.alive && r.repo) await stopDaemon({ repo: r.repo, env, reap: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('run directory and daemon lifecycle', () => {
  it('resolves one run from a subdirectory and a symlinked path', async () => {
    home = fresh();
    env = { ...process.env, ORCH_HOME: home };
    const base = fresh();
    const repo = makeRepo(base);
    mkdirSync(path.join(repo, 'sub/dir'), { recursive: true });
    const link = path.join(base, 'link-to-repo');
    symlinkSync(repo, link);
    const fromSub = await resolveRepoPath({ cwd: path.join(repo, 'sub/dir'), env });
    const fromLink = await resolveRepoPath({ repo: link, env });
    expect(fromSub).toBe(fromLink);
    expect(runDirFor(fromSub, env)).toBe(runDirFor(fromLink, env));
    expect(runDirFor(fromSub, env).startsWith(path.join(home, 'runs'))).toBe(true);
    const cfg = await resolveRunConfig(fromSub, env);
    expect(cfg.dataDir).toBe(runPaths(fromSub, env).runDir);
    expect(cfg.graphPath).toBe(path.join(cfg.dataDir, 'graph.yaml'));
    expect(cfg.repoPath).toBe(fromSub);
    await expect(resolveRepoPath({ cwd: tmpdir(), env: { ...env, ORCH_REPO: undefined } })).rejects.toThrow(/not inside a git repository/);
  });

  it('start is idempotent, stale pid files are ignored, and the repository stays untouched', async () => {
    home = fresh();
    env = { ...process.env, ORCH_HOME: home };
    const repo = realpathSync(makeRepo(fresh()));
    configFor(repo);
    const paths = runPaths(repo, env);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.daemonPid, '999999\n');
    const first = await startDaemon({ repo, env });
    expect(first.started).toBe(true);
    expect(first.pid).not.toBe(999999);
    expect(readFileSync(paths.daemonPid, 'utf8').trim()).toBe(String(first.pid));
    const second = await startDaemon({ repo, env });
    expect(second.started).toBe(false);
    expect(second.pid).toBe(first.pid);
    expect(second.url).toBe(first.url);
    expect((await daemonState(paths.runDir)).healthy).toBe(true);
    // a graph appears later; the daemon picks it up and finishes
    writeFileSync(paths.graphPath, 'nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }\n');
    await waitFor(async () => Boolean((await health(first.url))?.['finished']));
    const inRepo = readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(inRepo).toContain('.orchestrator/');
    expect(existsSync(path.join(repo, '.orchestrator-run'))).toBe(false);
    const stopped = await stopDaemon({ repo, env });
    expect(stopped.stopped).toBe(true);
    expect(pidAlive(first.pid)).toBe(false);
  });

  it('reuses its port across a graceful restart so a mid-task agent stays on the live channel', async () => {
    home = fresh();
    env = { ...process.env, ORCH_HOME: home };
    const repo = realpathSync(makeRepo(fresh()));
    configFor(repo);
    const paths = runPaths(repo, env);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.graphPath, 'nodes:\n  - { id: T1, deps: [], behavior: "slowSubmit:2500", description: d, acceptanceCriteria: [a] }\n');
    const first = await startDaemon({ repo, env });
    await waitFor(async () => ((await health(first.url))?.['byStatus'] as Record<string, string[]> | undefined)?.['running']?.includes('T1') ?? false);
    const stopped = await stopDaemon({ repo, env });
    expect(stopped.stopped).toBe(true);
    const second = await startDaemon({ repo, env });
    expect(second.started).toBe(true);
    expect(second.port).toBe(first.port);
    expect(second.url).toBe(first.url);
    await waitFor(async () => Boolean((await health(second.url))?.['finished']), 40_000);
    await stopDaemon({ repo, env });
    // The node:sqlite ExperimentalWarning never reaches the daemon log. See specs/host-integration "Quiet SQLite binding".
    expect(readFileSync(paths.daemonLog, 'utf8')).not.toContain('ExperimentalWarning');
    const store = new SqliteStore(path.join(paths.runDir, 'store.sqlite'));
    try {
      expect(store.listLaunches({ taskId: 'T1' })).toHaveLength(1);
      expect(store.listEvents({ kind: 'agent.fallback' })).toEqual([]);
      expect(store.listEvents({ kind: 'agent.report' })).toHaveLength(1);
      expect(store.getKv('apiPort')).toBe(String(first.port));
    } finally {
      store.close();
    }
  });

  it('runs lists every run with its repository and liveness', async () => {
    home = fresh();
    env = { ...process.env, ORCH_HOME: home };
    const repoA = realpathSync(makeRepo(fresh()));
    const repoB = realpathSync(makeRepo(fresh()));
    configFor(repoA);
    configFor(repoB);
    const a = await startDaemon({ repo: repoA, env });
    const dirB = runPaths(repoB, env).runDir;
    mkdirSync(dirB, { recursive: true });
    writeFileSync(path.join(dirB, 'repo'), `${repoB}\n`);
    const runs = await listRuns(env);
    expect(runs).toHaveLength(2);
    const byRepo = Object.fromEntries(runs.map((r) => [r.repo, r]));
    expect(byRepo[repoA]).toMatchObject({ alive: true, healthy: true, url: a.url, pid: a.pid });
    expect(byRepo[repoA]?.digest).toMatchObject({ finished: false });
    expect(byRepo[repoB]).toMatchObject({ alive: false, healthy: false });
    expect(readDaemonJson(runPaths(repoA, env).runDir)?.repo).toBe(repoA);
    await stopDaemon({ repo: repoA, env });
  });

  it('exits on its own when idle, records why, and is revived with its state intact', async () => {
    home = fresh();
    env = { ...process.env, ORCH_HOME: home };
    const repo = realpathSync(makeRepo(fresh()));
    configFor(repo);
    writeFileSync(path.join(repo, 'orchestrator.yaml'), `${readFileSync(path.join(repo, 'orchestrator.yaml'), 'utf8')}daemon: { idleExitMs: 1500 }\n`);
    const paths = runPaths(repo, env);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.graphPath, 'nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }\n');
    const first = await startDaemon({ repo, env });
    expect(first.mode).toBe('spawn');
    await waitFor(async () => Boolean((await health(first.url))?.['finished']), 40_000);
    // Probes do not delay the exit: keep probing while the window elapses.
    await waitFor(async () => !pidAlive(first.pid), 15_000);
    const state = await daemonState(paths.runDir);
    expect(state.alive).toBe(false);
    expect(state.exit).toMatchObject({ reason: 'idle', reap: false, digest: { finished: true } });
    expect(readDaemonJson(paths.runDir)?.exit?.reason).toBe('idle');
    const listed = (await listRuns(env)).find((r) => r.repo === repo);
    expect(listed).toMatchObject({ alive: false, exit: { reason: 'idle' } });
    const store = new SqliteStore(path.join(paths.runDir, 'store.sqlite'));
    const events = store.listEvents().length;
    expect(store.listEvents({ kind: 'daemon.idleExit' })).toHaveLength(1);
    store.close();

    const revived = await reviveDaemon({ repo, env });
    expect(revived).toMatchObject({ started: true, port: first.port, url: first.url });
    expect(readDaemonJson(paths.runDir)?.exit).toBeUndefined();
    const s = await health(first.url);
    expect(s?.['finished']).toBe(true);
    const again = new SqliteStore(path.join(paths.runDir, 'store.sqlite'));
    expect(again.listEvents().length).toBeGreaterThanOrEqual(events);
    expect(again.getEntry('T1')?.status.kind).toBe('done');
    again.close();
    expect(await reviveDaemon({ repo, env })).toBeUndefined(); // healthy: nothing to revive

    const stopped = await stopDaemon({ repo, env });
    expect(stopped.stopped).toBe(true);
    expect((await daemonState(paths.runDir)).exit?.reason).toBe('stop');
    await expect(reviveDaemon({ repo, env })).rejects.toThrow(/stopped at .*start/);
    expect(await reviveDaemon({ repo: realpathSync(makeRepo(fresh())), env })).toBeUndefined(); // no store: nothing to revive
  }, 90_000);

  it('adopts --default-mode only when nothing chose a mode, and keeps it across restarts', async () => {
    home = fresh();
    env = { ...process.env, ORCH_HOME: home };
    const repo = realpathSync(makeRepo(fresh()));
    configFor(repo);
    const paths = runPaths(repo, env);
    mkdirSync(paths.runDir, { recursive: true });
    const first = await startDaemon({ repo, env, defaultMode: 'pull' });
    expect(first.mode).toBe('pull');
    await stopDaemon({ repo, env });
    const second = await startDaemon({ repo, env });
    expect(second.mode).toBe('pull'); // durable
    await stopDaemon({ repo, env });

    const chosen = realpathSync(makeRepo(fresh()));
    configFor(chosen);
    const third = await startDaemon({ repo: chosen, env, mode: 'spawn' });
    expect(third.mode).toBe('spawn');
    await stopDaemon({ repo: chosen, env });
    expect((await startDaemon({ repo: chosen, env, defaultMode: 'pull' })).mode).toBe('spawn'); // the store's choice wins
    await stopDaemon({ repo: chosen, env });

    const configured = realpathSync(makeRepo(fresh()));
    configFor(configured);
    writeFileSync(path.join(configured, 'orchestrator.yaml'), `${readFileSync(path.join(configured, 'orchestrator.yaml'), 'utf8')}runner: { mode: spawn }\n`);
    expect((await startDaemon({ repo: configured, env, defaultMode: 'pull' })).mode).toBe('spawn'); // the file wins
    await stopDaemon({ repo: configured, env });
  }, 90_000);
});
