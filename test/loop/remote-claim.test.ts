/**
 * The claim response of a remote launch: no daemon path, the URL to clone, the integration branch and the brief from
 * the launch row; a kept release's `interrupted` context as `carry`; no baseline fingerprint. See specs/pull-runner "Claim".
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config.js';
import { chooseRunId, runIdInputOf } from '../../src/runs/runDir.js';
import type { Launch } from '../../src/state/store.js';
import { gitIn, makeRepo, makeSlice, single, type SliceHarness } from '../slice/harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const API = 'http://orchestrator.example:8080';
const health = { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0 };
const task = ', description: d, acceptanceCriteria: [a]';

/** A temp dir with the daemon's clone and a bare origin cloned from it; `origin` also adds it as the clone's origin remote. */
function fixture(opts: { origin?: boolean } = {}): { dir: string; repo: string; bare: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-remote-claim-'));
  const repo = makeRepo(dir);
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  if (opts.origin) gitIn(repo, 'remote', 'add', 'origin', bare);
  return { dir, repo, bare };
}

const remoteRun = (git: Record<string, unknown>) => ({
  leaseTtlMs: 60_000,
  apiBaseUrl: API,
  runner: { mode: 'pull' as const, access: 'remote' as const, claimWindowMs: 60_000 },
  git: { pushIntegration: true, fetchIntervalMs: 0, ...git },
  health,
});

async function parked(git: (f: { bare: string }) => Record<string, unknown>, opts: { origin?: boolean } = {}): Promise<{ f: ReturnType<typeof fixture>; l: Launch }> {
  const f = fixture(opts);
  h = await makeSlice({ graph: single('hang', task), dir: f.dir, repo: f.repo, config: remoteRun(git(f)) });
  await h.orch.tick();
  const [l] = h.store.listLaunches({ taskId: 'T1' });
  expect(l).toMatchObject({ access: 'remote', worktree: '', status: 'claimable' });
  return { f, l: l! };
}

describe('config: git.workerOriginUrl', () => {
  it('is an optional non-empty string, and git.originUrl keeps its meaning', () => {
    expect(defaultConfig({}).git.workerOriginUrl).toBeUndefined();
    expect(defaultConfig({ git: { workerOriginUrl: 'https://git.example/r.git' } }).git.workerOriginUrl).toBe('https://git.example/r.git');
    expect(() => defaultConfig({ git: { workerOriginUrl: '' } })).toThrow(/workerOriginUrl/);
    const cfg = defaultConfig({ git: { originUrl: 'https://git.example/daemon.git', workerOriginUrl: 'https://git.example/worker.git' } });
    expect(cfg.git.originUrl).toBe('https://git.example/daemon.git');
    // The run id under Postgres still hashes git.originUrl; the worker URL never enters it.
    const pg = (git: Record<string, unknown>) => chooseRunId(runIdInputOf(defaultConfig({ store: { kind: 'postgres' }, git }), '/r', {}));
    expect(pg({ originUrl: 'https://git.example/daemon.git', workerOriginUrl: 'https://git.example/worker.git' })).toEqual(pg({ originUrl: 'https://git.example/daemon.git' }));
  });
});

describe('remote claim response', () => {
  it('answers 200 with the remote fields and no worktree or briefPath', async () => {
    const { f, l } = await parked((f) => ({ originUrl: f.bare }));
    const c = await h!.orch.claim({ workerId: 'w1', access: 'remote' });
    expect(c.status).toBe(200);
    const b = c.body;
    expect(b).toMatchObject({
      ok: true,
      repeated: false,
      access: 'remote',
      launchId: l.launchId,
      taskId: 'T1',
      token: l.token,
      branch: 'task/T1/l1',
      baseSha: l.baseSha,
      repoUrl: f.bare,
      integrationBranch: 'main',
      apiUrl: h!.orch.apiBaseUrl,
      workerId: 'w1',
      leaseTtlMs: 60_000,
      runner: 'claude-code',
      commitPolicy: 'agent',
    });
    expect(b['brief']).toEqual(l.briefJson);
    expect(typeof b['brief']).toBe('object');
    expect(b['briefMarkdown']).toBe(l.briefMarkdown);
    expect(String(b['briefMarkdown'])).toContain('# Task T1');
    expect(b).not.toHaveProperty('worktree');
    expect(b).not.toHaveProperty('briefPath');
    expect(b).not.toHaveProperty('carry');
  }, 30_000);

  it('repoUrl is git.workerOriginUrl when set, passed through as written', async () => {
    const url = 'https://x-access-token:secret@git.example/acme/repo.git';
    await parked((f) => ({ originUrl: f.bare, workerOriginUrl: url }));
    const c = await h!.orch.claim({ workerId: 'w1', access: 'remote' });
    expect(c.body['repoUrl']).toBe(url);
  }, 30_000);

  it('repoUrl is git.originUrl when only that is set', async () => {
    const { f } = await parked((f) => ({ originUrl: f.bare }));
    const c = await h!.orch.claim({ workerId: 'w1', access: 'remote' });
    expect(c.body['repoUrl']).toBe(f.bare);
  }, 30_000);

  it("repoUrl is the clone's origin URL when neither is set", async () => {
    const { f } = await parked(() => ({}), { origin: true });
    expect(h!.config.git.originUrl).toBeUndefined();
    expect(h!.config.git.workerOriginUrl).toBeUndefined();
    const c = await h!.orch.claim({ workerId: 'w1', access: 'remote' });
    expect(c.status).toBe(200);
    expect(c.body['repoUrl']).toBe(gitIn(f.repo, 'remote', 'get-url', 'origin'));
    expect(c.body['repoUrl']).toBe(f.bare);
  }, 30_000);

  it('a second claim by the same worker answers the same launch with repeated: true', async () => {
    const { l } = await parked((f) => ({ originUrl: f.bare }));
    const first = await h!.orch.claim({ workerId: 'w1', access: 'remote' });
    const again = await h!.orch.claim({ workerId: 'w1', access: 'remote' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ launchId: l.launchId, token: l.token, repeated: true, access: 'remote' });
    const strip = (b: Record<string, unknown>) => {
      const { repeated: _r, leaseExpiresAt: _e, lease: _l, ...rest } = b;
      return rest;
    };
    expect(strip(again.body)).toEqual(strip(first.body));
  }, 30_000);

  it('a task whose carry holds interrupted gets it back as carry, on the first and a repeated claim', async () => {
    const f = fixture();
    h = await makeSlice({ graph: single('hang', task), dir: f.dir, repo: f.repo, config: remoteRun({ originUrl: f.bare }) });
    // A kept release leaves `interrupted` in the task's carry; the next launch is composed from it.
    const interrupted = { priorLaunchId: 'L-prev', priorBranch: 'task/T1/l0', headSha: 'cafe1234', reason: 'leaseExpired', interruptions: 1 };
    h.store.setEntry('T1', { ...h.orch.entry('T1'), carry: { interrupted }, interruptions: 1 });
    await h.orch.tick();
    const c = await h.orch.claim({ workerId: 'w1', access: 'remote' });
    expect(c.status).toBe(200);
    expect(c.body['carry']).toMatchObject({ interrupted: { headSha: 'cafe1234', priorBranch: 'task/T1/l0' } });
    // The claim clears the entry's carry; the repeated claim still answers it from the stored brief.
    expect(h.orch.entry('T1').carry).toBeUndefined();
    const again = await h.orch.claim({ workerId: 'w1', access: 'remote' });
    expect(again.body['carry']).toMatchObject({ interrupted: { headSha: 'cafe1234', priorBranch: 'task/T1/l0' } });
  }, 30_000);

  it('records no fingerprint and does not call Workspace.fingerprint', async () => {
    const { l } = await parked((f) => ({ originUrl: f.bare }));
    const ws = h!.orch.workspace as { fingerprint: (launch: Launch) => Promise<string> };
    const original = ws.fingerprint.bind(ws);
    let calls = 0;
    ws.fingerprint = (launch: Launch) => {
      calls++;
      return original(launch);
    };
    const c = await h!.orch.claim({ workerId: 'w1', access: 'remote' });
    expect(c.status).toBe(200);
    expect(calls).toBe(0);
    expect(h!.store.getLaunch(l.launchId)).toMatchObject({ status: 'live' });
    expect(h!.store.getLaunch(l.launchId)!.fingerprint).toBeUndefined();
    // The wrapper is live: a release does read the fingerprint.
    await h!.orch.release(l.launchId, 'done here');
    expect(calls).toBe(1);
  }, 30_000);
});
