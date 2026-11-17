import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pidAlive } from '../../src/runner/subprocess.js';
import { daemonState, health, listRuns, reviveDaemon, startDaemon, stopDaemon } from '../../src/runs/lifecycle.js';
import { cleanExit, describeExit, ensureRunDir, exitStoreFields, readDaemonJson, resolveRepoPath, resolveRunConfig, runDirFor, runPaths, writeDaemonJson } from '../../src/runs/runDir.js';
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
    const cfg = (await resolveRunConfig(fromSub, env)).config;
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

  // See specs/operator-control "Shutdown" (caller recorded) and "Exit record".
  it('a shutdown through the route records its caller in the event log and the exit record, and the revival refusal names it', async () => {
    home = fresh();
    env = { ...process.env, ORCH_HOME: home };
    const repo = realpathSync(makeRepo(fresh()));
    configFor(repo);
    const paths = runPaths(repo, env);
    const first = await startDaemon({ repo, env });
    const res = await fetch(`${first.url}/v1/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orch-attachment': 'a1', 'user-agent': 'lifecycle-test' }, body: JSON.stringify({ reap: false }) });
    expect(await res.json()).toMatchObject({ ok: true, reap: false, by: { attachment: 'a1', userAgent: 'lifecycle-test' } });
    await waitFor(async () => !pidAlive(first.pid));
    const state = await daemonState(paths.runDir);
    expect(state.exit).toMatchObject({ reason: 'stop', reap: false, by: { attachment: 'a1', userAgent: 'lifecycle-test' } });
    expect(String(state.exit?.by?.remote)).toMatch(/127\.0\.0\.1|::1/);
    // The store closed with nothing unflushed: a clean record, written after the close, with the digest taken before it.
    expect(cleanExit(state.exit!)).toBe(true);
    expect(state.exit).not.toHaveProperty('unflushedBatches');
    expect(state.exit).not.toHaveProperty('storeClosed');
    expect(state.exit?.digest).toMatchObject({ graphLoaded: expect.any(Boolean) });
    const store = new SqliteStore(path.join(paths.runDir, 'store.sqlite'));
    try {
      const ev = store.listEvents({ kind: 'operator.shutdown' });
      expect(ev).toHaveLength(1);
      expect(ev[0]?.payload).toMatchObject({ reap: false, by: { attachment: 'a1' } });
    } finally {
      store.close();
    }
    await expect(reviveDaemon({ repo, env })).rejects.toThrow(/stop by attachment a1/);
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

  // ORC-91: a Postgres run keeps no store file; one started from this run directory is revived like a local run.
  it('a Postgres run never started here is remote; one a local daemon left stopped is refused as stopped, and one that exited idle is started again', async () => {
    home = fresh();
    env = { ...process.env, ORCH_HOME: home, ORCH_URL: undefined, DATABASE_URL: undefined };
    const repo = realpathSync(makeRepo(fresh()));
    configFor(repo);
    writeFileSync(path.join(repo, 'orchestrator.yaml'), `${readFileSync(path.join(repo, 'orchestrator.yaml'), 'utf8')}store:\n  kind: postgres\n`);
    const paths = ensureRunDir(repo, env);
    await expect(reviveDaemon({ repo, env })).rejects.toThrow(/keeps its state in Postgres and is remote/);

    const info = { pid: 2 ** 22 + 7, url: 'http://127.0.0.1:9', port: 9, startedAt: 1, repo };
    writeDaemonJson(paths.runDir, { ...info, exit: { at: 1_000, reason: 'stop', reap: false, digest: {} } });
    await expect(reviveDaemon({ repo, env })).rejects.toThrow(/was stopped at .*\(stop\); call start/);
    // A stop that lost batches is not described as a clean one.
    writeDaemonJson(paths.runDir, { ...info, exit: { at: 1_000, reason: 'stop', reap: false, digest: {}, unflushedBatches: 3 } });
    await expect(reviveDaemon({ repo, env })).rejects.toThrow(/was stopped at .*\(stop, losing 3 unflushed batches\); call start/);

    // Idle: revived by starting the daemon, which here refuses for want of a database URL, not as a remote run.
    writeDaemonJson(paths.runDir, { ...info, exit: { at: 1_000, reason: 'idle', reap: false, digest: {} } });
    const err = await reviveDaemon({ repo, env, timeoutMs: 15_000 }).then(
      () => undefined,
      (e: unknown) => String(e),
    );
    expect(err).toMatch(/daemon did not become healthy[\s\S]*no database URL is set/);
  }, 60_000);

  // See specs/operator-control "Start arguments".
  it('passes configuration arguments as --set flags, applies them through the route on a running daemon, and rejects start-only keys there', async () => {
    home = fresh();
    env = { ...process.env, ORCH_HOME: home };
    const repo = realpathSync(makeRepo(fresh()));
    configFor(repo);
    const first = await startDaemon({ repo, env, overrides: { capacity: 3, allowedTools: ['Bash(docker:*)'] } });
    expect(first.started).toBe(true);
    expect(first.config?.capacity).toEqual({ value: 3, source: 'argument' });
    expect(first.config?.checkCommand).toEqual({ value: 'true', source: 'file' });
    expect(first.config?.allowedTools).toMatchObject({ parts: { argument: ['Bash(docker:*)'] }, applied: false });
    expect(first.applied?.sort()).toEqual(['allowedTools', 'capacity']);
    expect(first.rejected).toEqual([]);
    expect(first.needsConfig).toEqual([]);
    const second = await startDaemon({ repo, env, overrides: { capacity: 4, integrationBranch: 'develop' } });
    expect(second).toMatchObject({ started: false, applied: ['capacity'], rejected: [{ key: 'integrationBranch' }] });
    expect(second.rejected?.[0]?.reason).toMatch(/start-only/);
    expect(second.config?.capacity).toEqual({ value: 4, source: 'argument' });
    expect(second.config?.integrationBranch).toEqual({ value: 'main', source: 'detected' });
    await expect(startDaemon({ repo, env, overrides: { capacity: 0 } })).rejects.toThrow(/capacity/);
    expect((await health(first.url))?.['config']).toMatchObject({ capacity: { value: 4, source: 'argument' } });
    await stopDaemon({ repo, env });
  }, 60_000);

  // See specs/operator-control "Configuration route: limit keys" and specs/toolchain-discovery "Runtime limit overrides".
  it('passes the limit blocks to a spawned daemon, and a pair refusal at spawn is readable from the error', async () => {
    home = fresh();
    env = { ...process.env, ORCH_HOME: home };
    const repo = realpathSync(makeRepo(fresh()));
    configFor(repo);
    const first = await startDaemon({ repo, env, overrides: { budgets: { maxLaunchMs: 10_800_000 }, health: { stuckAfterMs: 0 } } });
    expect(first.started).toBe(true);
    expect([...(first.applied ?? [])].sort()).toEqual(['budgets', 'health']);
    const res = await fetch(`${first.url}/v1/config`);
    const body = (await res.json()) as { config: Record<string, unknown>; overrides: unknown };
    expect(body.config).toMatchObject({
      budgets: { maxLaunchMs: { value: 10_800_000, source: 'argument' } },
      health: { stuckAfterMs: { value: 0, source: 'argument' }, stuckFailAfterMs: { value: 2_700_000, source: 'default' } },
    });
    expect(body.overrides).toEqual({ budgets: { maxLaunchMs: 10_800_000 }, health: { stuckAfterMs: 0 } });
    await stopDaemon({ repo, env });

    // A fresh run with the default limits: a fail limit below the flag limit is refused at spawn, and the error ends with the refusal.
    const other = realpathSync(makeRepo(fresh()));
    configFor(other);
    const err = await startDaemon({ repo: other, env, overrides: { health: { stuckFailAfterMs: 600_000 } } }).then(
      () => undefined,
      (e: unknown) => String(e),
    );
    expect(err).toMatch(/--set health\.stuckFailAfterMs: health\.stuckFailAfterMs 600000 \(argument\) must be above health\.stuckAfterMs 900000 \(default\)[^\n]*\n?$/);
    const log = readFileSync(runPaths(other, env).daemonLog, 'utf8');
    expect(log.trimEnd().split('\n').at(-1)).toMatch(/^--set health\.stuckFailAfterMs: .*600000.*900000/);
    expect((await daemonState(runPaths(other, env).runDir)).healthy).toBe(false);

    // A file whose own pair breaks the rule still starts, with one warning naming both values and their sources.
    const broken = realpathSync(makeRepo(fresh()));
    configFor(broken);
    writeFileSync(path.join(broken, 'orchestrator.yaml'), `${readFileSync(path.join(broken, 'orchestrator.yaml'), 'utf8')}health:\n  stuckFailAfterMs: 600000\n`);
    const started = await startDaemon({ repo: broken, env });
    expect(started.config).toMatchObject({ health: { stuckFailAfterMs: { value: 600_000, source: 'file' }, stuckAfterMs: { value: 900_000, source: 'default' } } });
    const warned = readFileSync(runPaths(broken, env).daemonLog, 'utf8').split('\n').filter((l) => l.includes('stuck limits:'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('health.stuckFailAfterMs 600000 (file)');
    expect(warned[0]).toContain('health.stuckAfterMs 900000 (default)');
    // A patch of another key is accepted over it.
    expect((await startDaemon({ repo: broken, env, overrides: { capacity: 3 } })).applied).toEqual(['capacity']);
    await stopDaemon({ repo: broken, env });
  }, 60_000);

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

// See specs/operator-control "Exit record": a clean record only after the store closed with nothing unflushed.
describe('exit record store fields', () => {
  const base = { at: 1, reason: 'signal' as const, reap: false, digest: {} };
  it('a close with nothing unflushed adds nothing, and the record is clean', () => {
    const fields = exitStoreFields({ closed: true, unflushedBatches: 0 });
    expect(fields).toEqual({});
    expect(cleanExit({ ...base, ...fields })).toBe(true);
    expect(describeExit({ ...base, ...fields })).toBe('signal');
  });
  it('a close that lost batches records the count', () => {
    const fields = exitStoreFields({ closed: true, unflushedBatches: 4 });
    expect(fields).toEqual({ unflushedBatches: 4 });
    expect(cleanExit({ ...base, ...fields })).toBe(false);
    expect(describeExit({ ...base, ...fields })).toBe('signal, losing 4 unflushed batches');
  });
  it('a grace exit before the store closed is never clean, even with nothing pending', () => {
    expect(exitStoreFields({ closed: false, unflushedBatches: 0 })).toEqual({ unflushedBatches: 0, storeClosed: false });
    expect(cleanExit({ ...base, ...exitStoreFields({ closed: false, unflushedBatches: 0 }) })).toBe(false);
    expect(describeExit({ ...base, ...exitStoreFields({ closed: false, unflushedBatches: 2 }) })).toBe('signal, losing 2 unflushed batches, before the store closed');
  });
  it('a batch rejected at shutdown is recorded with its cause', () => {
    const rejected = { error: 'batch rejected by the sink: table kv, key {"key":"a"}, SQLSTATE 22021', sqlstate: '22021', table: 'kv', key: { key: 'a' } };
    const fields = exitStoreFields({ closed: true, unflushedBatches: 1, rejected });
    expect(fields).toEqual({ unflushedBatches: 1, rejected });
    expect(describeExit({ ...base, ...fields })).toContain('a batch rejected: batch rejected by the sink');
  });
});
