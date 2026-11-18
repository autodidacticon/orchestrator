/**
 * Run-level access mode: a remote run prepares no worktree, keeps the brief on the launch row, and refuses workers of
 * the other access. See specs/pull-runner "Access modes" and specs/remote-workspace.
 */
import { existsSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig, remoteAccessProblems } from '../../src/config.js';
import { listRuns, startDaemon, stopDaemon } from '../../src/runs/lifecycle.js';
import { resolveLayers } from '../../src/runs/resolve.js';
import type { Launch } from '../../src/state/store.js';
import { RemoteWorkspace, workspaceByAccess } from '../../src/workspace/remote-workspace.js';
import { FakeWorkspace } from '../../src/workspace/fake.js';
import { gitIn, makeRepo, makeSlice, single, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** A temp dir with the daemon's clone and a bare origin cloned from it. */
function fixture(): { dir: string; repo: string; bare: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-remote-'));
  const repo = makeRepo(dir);
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  return { dir, repo, bare };
}

const health = { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0 };
const remoteRun = (bare: string) => ({
  leaseTtlMs: 60_000,
  runner: { mode: 'pull' as const, access: 'remote' as const, claimWindowMs: 60_000 },
  git: { pushIntegration: true, originUrl: bare, fetchIntervalMs: 0 },
  health,
});

const worktreesUnder = (h: SliceHarness) => {
  const root = path.join(h.config.dataDir, 'worktrees');
  return existsSync(root) ? readdirSync(root) : [];
};

describe('config: runner.access', () => {
  it('accepts local and remote, defaults to local, and names the key for any other value', () => {
    expect(defaultConfig({}).runner.access).toBe('local');
    expect(defaultConfig({ runner: { access: 'local' } }).runner.access).toBe('local');
    expect(defaultConfig({ runner: { access: 'remote' } }).runner.access).toBe('remote');
    expect(() => defaultConfig({ runner: { access: 'cloud' as never } })).toThrow(/runner\.access/);
  });

  it('a config file sets it, and the resolved configuration keeps it; a bad value fails loading naming the key', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-access-'));
    const file = path.join(dir, 'orchestrator.yaml');
    writeFileSync(file, 'runner:\n  mode: pull\n  access: remote\n');
    const cfg = await loadConfig(file);
    expect(cfg.runner.access).toBe('remote');
    expect(resolveLayers({ base: cfg }).config.runner.access).toBe('remote');
    writeFileSync(file, 'runner:\n  access: cloud\n');
    await expect(loadConfig(file)).rejects.toThrow(/runner\.access must be one of local, remote/);
  });

  it('lists every unmet condition of a remote run', () => {
    const ok = defaultConfig({ runner: { mode: 'pull', access: 'remote' }, git: { pushIntegration: true } });
    expect(remoteAccessProblems(ok)).toEqual([]);
    const bad = defaultConfig({ runner: { mode: 'spawn', access: 'remote' }, prepareCommand: 'npm ci' });
    expect(remoteAccessProblems(bad)).toEqual(['runner.mode must be pull, not spawn', 'git.pushIntegration must be true', 'prepareCommand must be unset']);
    expect(remoteAccessProblems(defaultConfig({ runner: { mode: 'spawn' }, prepareCommand: 'x' }))).toEqual([]);
  });
});

describe('startup refuses a remote run that cannot work', () => {
  const cases: Array<{ name: string; config: (bare: string) => Record<string, unknown>; message: RegExp }> = [
    { name: 'runner.mode spawn', config: (bare) => ({ ...remoteRun(bare), runner: { mode: 'spawn', access: 'remote' } }), message: /runner\.mode must be pull, not spawn/ },
    { name: 'runner.mode mixed', config: (bare) => ({ ...remoteRun(bare), runner: { mode: 'mixed', access: 'remote' } }), message: /runner\.mode must be pull, not mixed/ },
    { name: 'git.pushIntegration false', config: (bare) => ({ ...remoteRun(bare), git: { pushIntegration: false } }), message: /git\.pushIntegration must be true/ },
    { name: 'prepareCommand set', config: (bare) => ({ ...remoteRun(bare), prepareCommand: 'true' }), message: /prepareCommand must be unset/ },
  ];
  for (const c of cases) {
    it(`with ${c.name}`, async () => {
      const f = fixture();
      h = await makeSlice({ graph: single('hang'), dir: f.dir, repo: f.repo, config: c.config(f.bare) });
      await expect(h.orch.start()).rejects.toThrow(c.message);
      expect(h.store.listLaunches()).toEqual([]);
    });
  }

  it('names each unmet condition at once', async () => {
    const f = fixture();
    h = await makeSlice({ graph: single('hang'), dir: f.dir, repo: f.repo, config: { runner: { mode: 'spawn', access: 'remote' }, prepareCommand: 'true' } });
    await expect(h.orch.start()).rejects.toThrow('runner.access remote refused: runner.mode must be pull, not spawn; git.pushIntegration must be true; prepareCommand must be unset');
  });

  it('a mode override to spawn on a remote run counts, and the mode route refuses to switch away from pull', async () => {
    const f = fixture();
    h = await makeSlice({ graph: single('hang'), dir: f.dir, repo: f.repo, config: remoteRun(f.bare) });
    const put = async (mode: string) => {
      const res = await fetch(`${h!.orch.apiBaseUrl}/v1/runner`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect(await put('spawn')).toMatchObject({ status: 409, body: { access: 'remote', mode: 'spawn' } });
    expect(await put('pull')).toMatchObject({ status: 200 });
    h.store.setKv('runner.mode', 'mixed');
    await expect(h.orch.start()).rejects.toThrow(/runner\.mode must be pull, not mixed/);
  });
});

describe('the daemon process', () => {
  it('exits at startup naming each unmet condition, before it listens', async () => {
    const env = { ...process.env, ORCH_HOME: mkdtempSync(path.join(tmpdir(), 'orch-remote-home-')) };
    const repo = realpathSync(makeRepo(mkdtempSync(path.join(tmpdir(), 'orch-remote-repo-'))));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), 'checkCommand: "true"\nprepareCommand: "true"\nrunner:\n  mode: mixed\n  access: remote\n');
    try {
      await expect(startDaemon({ repo, env })).rejects.toThrow(/runner\.access remote refused: runner\.mode must be pull, not mixed; git\.pushIntegration must be true; prepareCommand must be unset/);
    } finally {
      for (const r of await listRuns(env)) if (r.alive && r.repo) await stopDaemon({ repo: r.repo, env, reap: true });
    }
  }, 60_000);
});

describe('slice: a remote run', () => {
  it('admission parks a launch with the brief on its row and no worktree; a restart leaves it as it is', async () => {
    const f = fixture();
    h = await makeSlice({ graph: single('hang', ', description: d, acceptanceCriteria: [a]'), dir: f.dir, repo: f.repo, config: remoteRun(f.bare) });
    await h.orch.tick();
    const [l] = h.store.listLaunches({ taskId: 'T1' });
    expect(l).toMatchObject({ access: 'remote', worktree: '', status: 'claimable', branch: 'task/T1/l1' });
    expect(l!.briefMarkdown).toContain('# Task T1');
    expect(l!.briefJson).toMatchObject({ taskId: 'T1', launchId: l!.launchId });
    expect(worktreesUnder(h)).toEqual([]);
    expect(gitIn(f.repo, 'worktree', 'list', '--porcelain').split('\n').filter((x) => x.startsWith('worktree '))).toHaveLength(1);
    expect(h.store.listEvents({ kind: 'launch.created', launchId: l!.launchId })[0]?.payload).toMatchObject({ access: 'remote' });

    // Restart on the same store: the parked launch keeps its id and token and is not prepared again.
    await h.restart();
    const after = h.store.getLaunch(l!.launchId)!;
    expect(after).toMatchObject({ status: 'claimable', token: l!.token, worktree: '' });
    expect(h.store.listLaunches({ taskId: 'T1' })).toHaveLength(1);
    expect(h.store.listEvents({ kind: 'launch.reprepared', launchId: l!.launchId })).toHaveLength(0);
    expect(worktreesUnder(h)).toEqual([]);

    // A local worker (named or by default) is refused with both accesses named, and nothing changes.
    for (const access of ['local', undefined]) {
      const c = await h.orch.claim({ workerId: 'w1', ...(access ? { access } : {}) });
      expect(c.status).toBe(409);
      expect(c.body).toMatchObject({ ok: false, access: 'local', runAccess: 'remote' });
      expect(String(c.body['reason'])).toMatch(/remote/);
      expect(h.store.getLaunch(l!.launchId)).toMatchObject({ status: 'claimable' });
      expect(h.store.getLaunch(l!.launchId)!.worker).toBeUndefined();
    }
    expect(h.store.listEvents({ kind: 'launch.claimed' })).toHaveLength(0);

    // A remote worker claims it.
    const ok = await h.orch.claim({ workerId: 'w1', access: 'remote' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ launchId: l!.launchId, token: l!.token });
    expect(h.store.getLaunch(l!.launchId)).toMatchObject({ status: 'live', worker: { id: 'w1' } });
    expect(worktreesUnder(h)).toEqual([]);
  }, 30_000);
});

describe('slice: a local run', () => {
  it('rows carry access local, and a remote worker is refused with both accesses named', async () => {
    h = await makeSlice({ graph: single('hang'), config: { leaseTtlMs: 60_000, runner: { mode: 'pull', claimWindowMs: 60_000 }, health } });
    await h.orch.tick();
    const [l] = h.store.listLaunches({ taskId: 'T1' });
    expect(l).toMatchObject({ access: 'local', status: 'claimable' });
    expect(l!.worktree).not.toBe('');
    expect(l!.briefMarkdown).toBeUndefined();
    const c = await h.orch.claim({ workerId: 'w1', access: 'remote' });
    expect(c.status).toBe(409);
    expect(c.body).toMatchObject({ ok: false, access: 'remote', runAccess: 'local' });
    expect(h.store.getLaunch(l!.launchId)).toMatchObject({ status: 'claimable' });
    expect((await h.orch.claim({ workerId: 'w1', access: 'other' })).status).toBe(400);
  });
});

describe('RemoteWorkspace', () => {
  const launch = (worktree: string): Launch => ({
    launchId: 'L-remote-1',
    taskId: 'T1',
    attempt: 1,
    launchNo: 1,
    status: 'claimable',
    token: 't',
    branch: 'task/T1/l1',
    worktree,
    baseSha: 'base0',
    graphRev: 'r',
    createdAt: 0,
    access: 'remote',
  });

  it('prepare, remove, fingerprint and exists resolve without touching the filesystem', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-remote-ws-'));
    const where = path.join(dir, 'would-be-worktree');
    const l = launch(where);
    const ws = new RemoteWorkspace();
    await expect(ws.prepare(l, {} as never)).resolves.toBeUndefined();
    await expect(ws.remove(l)).resolves.toBe(true);
    await expect(ws.fingerprint(l)).resolves.toBe('base0:remote');
    await expect(ws.exists(l)).resolves.toBe(true);
    await expect(ws.listWorktrees()).resolves.toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    // Nothing is read either: an empty worktree (a real remote row) behaves the same.
    await expect(ws.exists(launch(''))).resolves.toBe(true);
  });

  it('seal, preserve and readFallback reject naming the remote launch', async () => {
    const ws = new RemoteWorkspace();
    const l = launch('');
    await expect(ws.seal(l)).rejects.toThrow(/remote launch has no worktree: L-remote-1/);
    await expect(ws.preserve(l)).rejects.toThrow(/remote launch has no worktree: L-remote-1/);
    await expect(ws.readFallback(l)).rejects.toThrow(/remote launch has no worktree: L-remote-1/);
  });

  it('workspaceByAccess routes launch calls by access and keeps the integration side local', async () => {
    const local = new FakeWorkspace();
    const ws = workspaceByAccess(local);
    expect(ws).toBeInstanceOf(FakeWorkspace);
    const remote = launch('');
    const { access: _a, ...legacy } = { ...launch('/x'), launchId: 'L-local-1' };
    await ws.prepare(remote, {} as never);
    await ws.prepare(legacy, {} as never);
    expect([...local.worktrees]).toEqual(['L-local-1']);
    expect(await ws.exists(remote)).toBe(true);
    expect(await ws.exists({ ...legacy, launchId: 'none' })).toBe(false);
    await expect(ws.seal(remote)).rejects.toThrow(/remote launch has no worktree/);
    await expect(ws.seal(legacy)).resolves.toMatchObject({ ok: true });
    expect(await ws.integrationHead()).toBe('head0');
  });
});
