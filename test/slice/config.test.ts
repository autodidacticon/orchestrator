import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/operator/cli.js';
import { digestOf } from '../../src/operator/routes.js';
import { health, listRuns, startDaemon, stopDaemon } from '../../src/runs/lifecycle.js';
import { readConfigJson, runPaths } from '../../src/runs/runDir.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import { gitIn, makeRepo, makeSlice, scriptedAgent, single, tsxLoader, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
let dirs: string[] = [];
let env: NodeJS.ProcessEnv | undefined;
const scripted = `node --import ${tsxLoader} ${scriptedAgent} {briefJson}`;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  if (env) for (const r of await listRuns(env)) if (r.alive && r.repo) await stopDaemon({ repo: r.repo, env, reap: true });
  env = undefined;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const fresh = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

async function http(base: string, method: 'GET' | 'PUT' | 'POST', route: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('waitFor timed out');
}

// See specs/integration-pipeline "Check and verified tree" and specs/toolchain-discovery "Runtime overrides and start-only keys".
describe('verification while the check command is unresolved', () => {
  it('holds a submitted task without spending an attempt, reports needsConfig everywhere, and publishes once the command is set', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true, config: { checkCommand: undefined } });
    expect(h.orch.effective().needsConfig).toEqual(['checkCommand']);
    expect(h.orch.configReport().config.checkCommand).toEqual({ value: undefined, source: 'unresolved' });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'submitted');
    const attempts = h.orch.entry('T1').attempts;
    for (let i = 0; i < 6; i++) {
      await h.orch.tick();
      await new Promise((r) => setTimeout(r, 50));
    }
    const [job] = h.store.listJobs({ taskId: 'T1' });
    expect(job?.status).toBe('queued');
    expect(job?.sealedSha).not.toBe(job?.baseSha);
    expect(h.orch.entry('T1')).toMatchObject({ status: { kind: 'submitted' }, attempts });
    expect(h.orch.status().needsConfig).toEqual(['checkCommand']);
    expect(digestOf(h.orch)['needsConfig']).toEqual(['checkCommand']);
    expect((await http(h.orch.apiBaseUrl, 'GET', '/v1/status')).body['needsConfig']).toEqual(['checkCommand']);
    expect((await http(h.orch.apiBaseUrl, 'GET', '/v1/events?after=0')).body['digest']).toMatchObject({ needsConfig: ['checkCommand'], verifying: ['T1'] });
    const shown = await http(h.orch.apiBaseUrl, 'GET', '/v1/config');
    expect(shown.body).toMatchObject({ needsConfig: ['checkCommand'], config: { checkCommand: { source: 'unresolved' } } });
    const put = await http(h.orch.apiBaseUrl, 'PUT', '/v1/config', { checkCommand: 'true' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ ok: true, applied: ['checkCommand'], needsConfig: [], config: { checkCommand: { value: 'true', source: 'argument' } }, overrides: { checkCommand: 'true' } });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    expect(h.store.listJobs({ taskId: 'T1' })[0]?.status).toBe('published');
    expect(h.orch.entry('T1').attempts).toBe(attempts);
    expect(h.store.listEvents({ kind: 'operator.config' })).toHaveLength(1);
    expect(h.store.listEvents({ kind: 'config.resolved' })).toHaveLength(1);
    expect(digestOf(h.orch)['needsConfig']).toEqual([]);
  });

  it('a declared no-op with no commits ahead of its base publishes at once while the command is unresolved', async () => {
    h = await makeSlice({ graph: single('noopDeclared'), realVerifier: true, config: { checkCommand: undefined } });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    expect(h.store.listJobs({ taskId: 'T1' })[0]).toMatchObject({ status: 'published' });
    expect(h.orch.effective().needsConfig).toEqual(['checkCommand']);
  });

  it('a job checking with command A finishes with A while B applies to the next job', async () => {
    const log = path.join(fresh('orch-check-'), 'checks.log');
    const graph = 'nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }\n  - { id: T2, deps: [], behavior: "slowSubmit:1500", description: d, acceptanceCriteria: [a] }';
    h = await makeSlice({ graph, realVerifier: true, config: { checkCommand: `sleep 1 && echo A >> ${log}` } });
    await h.waitFor(() => h!.store.listJobs({ taskId: 'T1', status: 'checking' }).length === 1);
    expect(h.orch.setConfig({ checkCommand: `echo B >> ${log}` })).toMatchObject({ ok: true });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done' && h!.orch.entry('T2').status.kind === 'done', 40_000);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['A', 'B']);
  });
});

describe('orchestrator-ctl config', () => {
  it('prints the block without flags, adds rules with --allow, sets and clears keys, and relays a refusal', async () => {
    h = await makeSlice({ graph: single('hang'), config: { leaseTtlMs: 60_000 } });
    const url = h.orch.apiBaseUrl;
    const shown = await runCli(['--url', url, 'config']);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ config: { checkCommand: { value: 'true', source: 'file' }, capacity: { value: 4, source: 'file' } }, needsConfig: [], overrides: {} });
    expect((shown.body as { toolchain?: unknown }).toolchain).toBeUndefined();
    const added = await runCli(['--url', url, 'config', '--allow', 'Bash(docker:*)']);
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ ok: true, applied: ['allowedTools'], config: { allowedTools: { parts: { argument: ['Bash(docker:*)'] } } } });
    const more = await runCli(['--url', url, 'config', '--allow', 'Bash(make:*)', '--allow', 'Bash(docker:*)', '--capacity', '3', '--check-command', 'make check']);
    expect(more.body).toMatchObject({ config: { allowedTools: { parts: { argument: ['Bash(docker:*)', 'Bash(make:*)'] } }, capacity: { value: 3, source: 'argument' }, checkCommand: { value: 'make check', source: 'argument' } } });
    const cleared = await runCli(['--url', url, 'config', '--clear', 'allowedTools', '--clear', 'capacity']);
    expect(((cleared.body as { applied: string[] }).applied).sort()).toEqual(['allowedTools', 'capacity']);
    expect(cleared.body).toMatchObject({ config: { allowedTools: { parts: { argument: [] } }, capacity: { value: 4, source: 'file' }, checkCommand: { value: 'make check', source: 'argument' } } });
    const bad = await runCli(['--url', url, 'config', '--capacity', '0']);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ key: 'capacity' });
    expect(h.orch.effective().config.checkCommand).toBe('make check');
    // See specs/operator-control "Set the effort from the CLI" and specs/toolchain-discovery "Invalid effort refused".
    const effort = await runCli(['--url', url, 'config', '--effort', 'high', '--model', 'claude-sonnet-5-5']);
    expect(effort.status).toBe(200);
    expect(effort.body).toMatchObject({ config: { effort: { value: 'high', source: 'argument', applied: false }, model: { value: 'claude-sonnet-5-5', source: 'argument', applied: false } } });
    expect(h.orch.selectionFor('T1')).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' });
    const huge = await http(url, 'PUT', '/v1/config', { effort: 'huge' });
    expect(huge.status).toBe(400);
    expect(huge.body).toMatchObject({ key: 'effort' });
    expect(h.orch.effective().effort.value).toBe('high');
  });
});

// See specs/toolchain-discovery "Resolved configuration record" and "Integration branch detection and pinning".
describe('the daemon resolves, records, and pins', () => {
  it('writes config.json at boot and after an override, keeps overrides across a restart, and keeps the pinned branch against detection but refuses an explicit change mid-run', async () => {
    env = { ...process.env, ORCH_HOME: fresh('orch-cfg-home-') };
    const repo = realpathSync(makeRepo(fresh('orch-cfg-repo-')));
    writeFileSync(path.join(repo, 'Makefile'), 'test:\n\ttrue\n');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-q', '-m', 'makefile');
    const paths = runPaths(repo, env);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.graphPath, 'nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }\n');
    // A bad selector is refused before any daemon is spawned; a good one becomes a `--set` flag. See specs/operator-control "Start arguments".
    await expect(startDaemon({ repo, env, overrides: { runnerCommand: scripted, effort: 'huge' as never } })).rejects.toThrow(/effort/);
    const first = await startDaemon({ repo, env, overrides: { runnerCommand: scripted, model: 'claude-sonnet-5-5' } });
    expect(first.started).toBe(true);
    expect(first.config?.model).toEqual({ value: 'claude-sonnet-5-5', source: 'argument', applied: false });
    expect(first.config?.effort).toEqual({ value: 'medium', source: 'default', applied: false });
    expect(first.config?.checkCommand).toEqual({ value: 'make test', source: 'detected' });
    expect(first.config?.integrationBranch).toEqual({ value: 'main', source: 'detected' });
    expect(first.config?.runnerCommand).toEqual({ value: scripted, source: 'argument' });
    expect(first.config?.allowedTools).toMatchObject({ applied: false, parts: { detected: ['Bash(make:*)'] } });
    expect(first.toolchain).toMatchObject({ kinds: ['make'], manifests: ['Makefile'], checkCommand: 'make test' });
    expect(first.needsConfig).toEqual([]);
    expect([...(first.applied ?? [])].sort()).toEqual(['model', 'runnerCommand']);
    const record = readConfigJson(paths.runDir);
    expect(record?.repo).toBe(repo);
    expect(record?.config.checkCommand).toEqual({ value: 'make test', source: 'detected' });
    expect(record?.config.capacity).toEqual({ value: 2, source: 'default' });
    expect(record?.toolchain?.kinds).toEqual(['make']);
    expect(record?.needsConfig).toEqual([]);
    await waitFor(async () => Boolean((await health(first.url))?.['finished']), 60_000);
    const put = await http(first.url, 'PUT', '/v1/config', { capacity: 3 });
    expect(put.status).toBe(200);
    expect(readConfigJson(paths.runDir)?.config.capacity).toEqual({ value: 3, source: 'argument' });
    expect((await http(first.url, 'GET', '/v1/status')).body).toMatchObject({ config: { capacity: { value: 3, source: 'argument' } }, needsConfig: [] });
    await stopDaemon({ repo, env });
    const store = new SqliteStore(path.join(paths.runDir, 'store.sqlite'));
    expect(store.listEvents().map((e) => e.kind).filter((k) => k === 'operator.config' || k === 'config.resolved')).toEqual(['config.resolved', 'operator.config', 'config.resolved']);
    expect(store.getKv('integrationBranch')).toBe('main');
    expect(store.listLaunches().length).toBeGreaterThan(0);
    store.close();

    // A restart without arguments keeps the overrides, with source argument.
    const second = await startDaemon({ repo, env });
    expect(second.config?.model).toEqual({ value: 'claude-sonnet-5-5', source: 'argument', applied: false }); // the override survives the restart; specs/model-selection
    expect(second.config?.model).toEqual({ value: 'claude-sonnet-5-5', source: 'argument', applied: false });
    expect(second.started).toBe(true);
    expect(second.config?.capacity).toEqual({ value: 3, source: 'argument' });
    expect(second.config?.runnerCommand).toEqual({ value: scripted, source: 'argument' });
    await stopDaemon({ repo, env });

    // origin/HEAD re-pointed and another branch checked out: the pin wins silently.
    gitIn(repo, 'branch', 'develop');
    gitIn(repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    gitIn(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    gitIn(repo, 'checkout', '-q', 'develop');
    const third = await startDaemon({ repo, env });
    expect(third.config?.integrationBranch).toEqual({ value: 'main', source: 'pinned' });
    await stopDaemon({ repo, env });

    // An explicit different branch is refused while the run holds a launch, and leaves no override behind.
    await expect(startDaemon({ repo, env, overrides: { integrationBranch: 'develop' } })).rejects.toThrow(/pinned to main/);
    const log = readFileSync(paths.daemonLog, 'utf8');
    expect(log).toContain('names develop');
    expect(log).toContain('fresh run directory');
    const fourth = await startDaemon({ repo, env });
    expect(fourth.config?.integrationBranch).toEqual({ value: 'main', source: 'pinned' });
    expect(readConfigJson(paths.runDir)?.overrides).toEqual({ runnerCommand: scripted, capacity: 3, model: 'claude-sonnet-5-5' });
    await stopDaemon({ repo, env });
  }, 180_000);

  it('the file naming another branch on an untouched run re-pins it with a new baselineHead', async () => {
    env = { ...process.env, ORCH_HOME: fresh('orch-pin-home-') };
    const repo = realpathSync(makeRepo(fresh('orch-pin-repo-')));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), `runnerCommand: "${scripted}"\ncheckCommand: "true"\n`);
    const paths = runPaths(repo, env);
    const first = await startDaemon({ repo, env });
    expect(first.config?.integrationBranch).toEqual({ value: 'main', source: 'detected' });
    expect(first.config?.checkCommand).toEqual({ value: 'true', source: 'file' });
    await stopDaemon({ repo, env });
    const mainHead = gitIn(repo, 'rev-parse', 'main');
    gitIn(repo, 'checkout', '-q', '-b', 'develop');
    writeFileSync(path.join(repo, 'dev.txt'), 'x\n');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-q', '-m', 'dev');
    gitIn(repo, 'checkout', '-q', 'main');
    writeFileSync(path.join(repo, 'orchestrator.yaml'), `runnerCommand: "${scripted}"\ncheckCommand: "true"\nintegrationBranch: develop\n`);
    const second = await startDaemon({ repo, env });
    expect(second.config?.integrationBranch).toEqual({ value: 'develop', source: 'file' });
    await stopDaemon({ repo, env });
    const store = new SqliteStore(path.join(paths.runDir, 'store.sqlite'));
    expect(store.getKv('integrationBranch')).toBe('develop');
    expect(store.getKv('baselineHead')).toBe(gitIn(repo, 'rev-parse', 'develop'));
    expect(store.getKv('baselineHead')).not.toBe(mainHead);
    store.close();
  }, 60_000);
});
