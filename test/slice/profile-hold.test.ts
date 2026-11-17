import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { health, startDaemon, stopDaemon } from '../../src/runs/lifecycle.js';
import { makeRepo, makeSlice, type SliceHarness } from './harness.js';

// See specs/model-selection "Profile hold at admission", specs/operator-control "Status report: profiles"
// and specs/operator-mcp "Wait digest: profileHeld".

let h: SliceHarness | undefined;
const daemons: Array<{ repo: string; env: NodeJS.ProcessEnv }> = [];
const dirs: string[] = [];

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  for (const d of daemons.splice(0)) await stopDaemon({ ...d, reap: true }).catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function http(url: string, method: 'GET' | 'PUT', route: string, body?: unknown) {
  const res = await fetch(`${url}${route}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const digestAt = async (url: string) => (await http(url, 'GET', '/v1/events?after=0&limit=1')).body['digest'] as Record<string, unknown>;

/** A daemon spawned on a fresh repository whose orchestrator.yaml holds `lines`. */
async function daemonWith(lines: string[]): Promise<string> {
  const home = mkdtempSync(path.join(tmpdir(), 'orch-profile-home-'));
  const base = mkdtempSync(path.join(tmpdir(), 'orch-profile-repo-'));
  dirs.push(home, base);
  const repo = realpathSync(makeRepo(base));
  writeFileSync(path.join(repo, 'orchestrator.yaml'), lines.join('\n'));
  const env = { ...process.env, ORCH_HOME: home };
  daemons.push({ repo, env });
  const started = await startDaemon({ repo, env });
  expect(started.started).toBe(true);
  return started.url!;
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('profile hold over HTTP', () => {
  it('criterion 14: a pull-mode slice holds the task out of claimable until model and effort are set', async () => {
    h = await makeSlice({
      graph: 'nodes:\n  - { id: T1, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }\n',
      config: { leaseTtlMs: 60_000, runner: { mode: 'pull', claimWindowMs: 60_000, confirmProfile: true } },
    });
    const url = h.orch.apiBaseUrl;
    await h.orch.tick();
    await h.orch.tick();
    let status = (await http(url, 'GET', '/v1/status')).body;
    expect(status['runner']).toMatchObject({ mode: 'pull', confirmProfile: true });
    expect(status['claimable']).toEqual([]);
    expect(status['profiles']).toEqual([
      { runner: 'claude-code', model: 'claude-opus-5-5', effort: 'medium', modelSource: 'default', effortSource: 'default', held: true, missing: ['model', 'effort'], tasks: 1, sample: ['T1'] },
    ]);
    expect((await digestAt(url))['profileHeld']).toEqual([{ runner: 'claude-code', missing: ['model', 'effort'], tasks: 1 }]);
    expect(h.store.listLaunches({ taskId: 'T1' })).toEqual([]);

    const put = await http(url, 'PUT', '/v1/config', { model: 'claude-opus-5-5', effort: 'medium' });
    expect(put.status).toBe(200);
    await h.orch.tick();
    status = (await http(url, 'GET', '/v1/status')).body;
    expect(status['claimable']).toEqual(['T1']);
    expect(status['profiles']).toEqual([]);
    expect((await digestAt(url))['profileHeld']).toEqual([]);
  });

  it('criterion 15: without a graph the status body carries the key and an empty profiles list, and the digest an empty profileHeld', async () => {
    const url = await daemonWith(['checkCommand: "true"', 'runner: { confirmProfile: true }']);
    const body = await health(url);
    expect(body?.['error']).toBe('graph not loaded');
    expect(body?.['runner']).toMatchObject({ confirmProfile: true });
    expect(body?.['profiles']).toEqual([]);
    const digest = await digestAt(url);
    expect(digest['graphLoaded']).toBe(false);
    expect(digest['profileHeld']).toEqual([]);
  }, 60_000);

  it('criterion 16: a file value equal to the built-in one confirms', async () => {
    const url = await daemonWith([
      'checkCommand: "true"',
      'tickIntervalMs: 150',
      'runner: { mode: pull, confirmProfile: true, claude: { model: claude-opus-5-5, effort: medium } }',
    ]);
    const content = 'nodes:\n  - { id: T1, deps: [], description: d, acceptanceCriteria: [a] }\n  - { id: T2, deps: [T1], description: d, acceptanceCriteria: [a] }\n';
    const put = await http(url, 'PUT', '/v1/graph', { content });
    expect(put.status).toBe(200);
    const status = await until(
      async () => (await http(url, 'GET', '/v1/status')).body,
      (s) => JSON.stringify(s['claimable']) === '["T1"]',
    );
    expect(status['claimable']).toEqual(['T1']);
    expect(status['runner']).toMatchObject({ mode: 'pull', confirmProfile: true });
    expect(status['profiles']).toEqual([
      { runner: 'claude-code', model: 'claude-opus-5-5', effort: 'medium', modelSource: 'file', effortSource: 'file', held: false, missing: [], tasks: 1, sample: ['T2'] },
    ]);
    expect((await digestAt(url))['profileHeld']).toEqual([]);
  }, 60_000);
});
