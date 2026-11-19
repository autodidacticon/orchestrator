/**
 * Release and lease expiry of a remote launch: the worker commits and pushes its work in progress and releases with
 * `headSha` (and `wipCommit`); the daemon checks the tip at origin and keeps nothing on this host. On lease expiry the
 * daemon reads the branch tip at origin. See specs/pull-runner "Release" and "Lease expiry", specs/remote-workspace.
 */
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Launch } from '../../src/state/store.js';
import { gitIn, makeRepo, makeSlice, single, type SliceHarness, tsxLoader } from './harness.js';

const harnesses: SliceHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

type Fixture = { dir: string; repo: string; bare: string };

/** A temp dir with the daemon's clone and a bare origin cloned from it. */
function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-remote-release-'));
  const repo = makeRepo(dir);
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  return { dir, repo, bare };
}

const TTL = 60_000;
const health = { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0 };
const remoteRun = (bare: string, maxKeptReleases?: number) => ({
  leaseTtlMs: TTL,
  runner: { mode: 'pull' as const, access: 'remote' as const, claimWindowMs: 60_000 },
  git: { pushIntegration: true, originUrl: bare, fetchIntervalMs: 0 },
  health,
  ...(maxKeptReleases !== undefined ? { daemon: { maxKeptReleases } } : {}),
});
const GRAPH = single('hang', ', description: d, acceptanceCriteria: [a]');

async function http(h: SliceHarness, route: string, body: Record<string, unknown>, token?: string) {
  const res = await fetch(`${h.orch.apiBaseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function start(f: Fixture, maxKeptReleases?: number): Promise<SliceHarness> {
  const h = await makeSlice({ graph: GRAPH, dir: f.dir, repo: f.repo, config: remoteRun(f.bare, maxKeptReleases) });
  harnesses.push(h);
  return h;
}

/** Admit T1 (a tick) and claim its launch as a remote worker. */
async function claim(h: SliceHarness): Promise<{ launch: Launch; body: Record<string, unknown> }> {
  await h.orch.tick();
  const c = await http(h, '/v1/claims', { workerId: 'w1', access: 'remote' });
  expect(c.status).toBe(200);
  const launch = h.store.getLaunch(String(c.body['launchId']))!;
  expect(launch).toMatchObject({ access: 'remote', worktree: '', status: 'live' });
  expect(h.orch.entry('T1').status.kind).toBe('running');
  return { launch, body: c.body };
}

/** The worker's own clone of origin, on the launch branch at its base. */
function workerClone(f: Fixture, launch: Launch): string {
  const clone = path.join(f.dir, `worker-${launch.launchNo}`);
  gitIn(f.dir, 'clone', '-q', f.bare, clone);
  gitIn(clone, 'checkout', '-q', '-b', launch.branch, launch.baseSha);
  return clone;
}

function commit(clone: string, file: string): string {
  writeFileSync(path.join(clone, file), `${file}\n`);
  gitIn(clone, 'add', file);
  gitIn(clone, 'commit', '-q', '-m', `add ${file}`);
  return gitIn(clone, 'rev-parse', 'HEAD');
}

const push = (clone: string, branch: string) => gitIn(clone, 'push', '-q', '-f', 'origin', `HEAD:refs/heads/${branch}`);
const release = (h: SliceHarness, launch: Launch, body: Record<string, unknown>) => http(h, `/v1/launches/${launch.launchId}/release`, { workerId: 'w1', reason: 'handing back', ...body });

/** Count the launch-side workspace calls the loop makes, whatever the launch's access. */
function countCalls(h: SliceHarness): Record<'fingerprint' | 'preserve' | 'remove', number> {
  const counts = { fingerprint: 0, preserve: 0, remove: 0 };
  const ws = h.orch.workspace as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const m of ['fingerprint', 'preserve', 'remove'] as const) {
    const original = ws[m]!.bind(ws);
    ws[m] = (...a: unknown[]) => {
      counts[m]++;
      return original(...a);
    };
  }
  return counts;
}

/** Expire a claim as the tick does, again while the tick's bounded read of origin is still running. */
async function settleExpiry(h: SliceHarness, launch: Launch): Promise<'kept' | 'failed' | 'skipped'> {
  for (const deadline = Date.now() + 15_000; ; await new Promise((r) => setTimeout(r, 50))) {
    const outcome = await h.orch.expireClaim(h.store.getLaunch(launch.launchId)!);
    if (outcome !== 'skipped' || Date.now() > deadline) return outcome;
  }
}

/** Make T1's lease have expired `agoMs` ago, as if the worker went silent. */
function expireLease(h: SliceHarness, agoMs: number): void {
  const e = h.orch.entry('T1');
  h.store.setEntry('T1', { ...e, lease: { ...e.lease!, expiresAt: h.orch.now() - agoMs } });
}

describe('slice: remote release with keep', () => {
  it('a pushed tip is kept at no cost and the next remote claim carries it', async () => {
    const f = fixture();
    const h = await start(f);
    const { launch } = await claim(h);
    const clone = workerClone(f, launch);
    commit(clone, 'part1.txt');
    const tip = commit(clone, 'wip.txt');
    push(clone, launch.branch);
    const res = await release(h, launch, { keep: true, headSha: tip, wipCommit: tip });
    expect(res).toMatchObject({ status: 200, body: { ok: true, outcome: 'unstarted', progressed: true, kept: true, branch: launch.branch, headSha: tip, wipCommit: tip } });
    expect(h.store.getLaunch(launch.launchId)).toMatchObject({ status: 'ended', endReason: 'released' });
    expect(h.orch.entry('T1')).toMatchObject({ status: { kind: 'unstarted' }, attempts: 0, interruptions: 1 });
    expect(h.orch.entry('T1').carry?.interrupted).toEqual({ priorLaunchId: launch.launchId, priorBranch: launch.branch, headSha: tip, wipCommit: tip, reason: 'handing back', interruptions: 1 });
    // The kept tip is in the daemon's clone too.
    expect(gitIn(f.repo, 'cat-file', '-t', tip)).toBe('commit');

    const next = await claim(h);
    expect(next.launch.launchId).not.toBe(launch.launchId);
    expect(next.body['carry']).toMatchObject({ interrupted: { headSha: tip, priorBranch: launch.branch, wipCommit: tip } });
    expect(String(next.body['briefMarkdown'])).toContain(tip);
  }, 30_000);

  it('a headSha that is not the branch tip at origin answers 409 and the launch stays live', async () => {
    const f = fixture();
    const h = await start(f);
    const { launch } = await claim(h);
    const clone = workerClone(f, launch);
    const first = commit(clone, 'one.txt');

    // Nothing pushed yet.
    const notPushed = await release(h, launch, { keep: true, headSha: first });
    expect(notPushed).toMatchObject({ status: 409, body: { reason: 'branchNotPushed', branch: launch.branch } });

    // Pushed a later tip than the one released.
    const second = commit(clone, 'two.txt');
    push(clone, launch.branch);
    const mismatch = await release(h, launch, { keep: true, headSha: first });
    expect(mismatch).toMatchObject({ status: 409, body: { reason: 'shaMismatch', branch: launch.branch, expected: first, actual: second } });

    expect(h.store.getLaunch(launch.launchId)?.status).toBe('live');
    expect(h.orch.entry('T1')).toMatchObject({ status: { kind: 'running' }, attempts: 0 });
    expect(h.store.listEvents({ kind: 'launch.released' })).toHaveLength(0);

    // Malformed shas are refused before origin is asked.
    expect(await release(h, launch, { keep: true, headSha: 'abc123' })).toMatchObject({ status: 400, body: { field: 'headSha' } });
    expect(await release(h, launch, { keep: true, headSha: second, wipCommit: 'nope' })).toMatchObject({ status: 400, body: { field: 'wipCommit' } });
    expect(h.store.getLaunch(launch.launchId)?.status).toBe('live');

    // The right tip is then kept.
    expect(await release(h, launch, { keep: true, headSha: second })).toMatchObject({ status: 200, body: { kept: true, headSha: second } });
  }, 30_000);

  it('without an API call and with headSha at the base, a keep is not kept, as for a local launch without progress', async () => {
    const f = fixture();
    const h = await start(f);
    const { launch } = await claim(h);
    const clone = workerClone(f, launch);
    push(clone, launch.branch);
    const res = await release(h, launch, { keep: true, headSha: launch.baseSha });
    expect(res).toMatchObject({ status: 200, body: { ok: true, outcome: 'unstarted', progressed: false, kept: false } });
    expect(res.body).not.toHaveProperty('keepError');
    expect(h.orch.entry('T1')).toMatchObject({ status: { kind: 'unstarted' }, attempts: 0 });
    expect(h.orch.entry('T1').interruptions ?? 0).toBe(0);
    expect(h.orch.entry('T1').carry?.interrupted).toBeUndefined();
  }, 30_000);

  it('calls neither Workspace.fingerprint, preserve nor remove', async () => {
    const f = fixture();
    const h = await start(f);
    const { launch } = await claim(h);
    const clone = workerClone(f, launch);
    const tip = commit(clone, 'T1.txt');
    push(clone, launch.branch);
    // A worker call first: progress by call as well as by tip.
    expect((await h.orch.agentCall(launch.launchId, launch.token, 'heartbeat', { progress: 'pushed' })).status).toBe(200);
    const counts = countCalls(h);
    const res = await release(h, launch, { keep: true, headSha: tip });
    expect(res).toMatchObject({ status: 200, body: { kept: true, headSha: tip } });
    expect(counts).toEqual({ fingerprint: 0, preserve: 0, remove: 0 });
    // The counters are live: a direct call is counted.
    await h.orch.workspace.fingerprint(launch);
    expect(counts.fingerprint).toBe(1);
  }, 30_000);

  it('daemon.maxKeptReleases bounds remote keeps: past it a keep answers kept false with keepError naming the bound', async () => {
    const f = fixture();
    const h = await start(f, 1);
    const { launch: first } = await claim(h);
    const c1 = workerClone(f, first);
    const tip1 = commit(c1, 'one.txt');
    push(c1, first.branch);
    expect(await release(h, first, { keep: true, headSha: tip1 })).toMatchObject({ status: 200, body: { kept: true } });
    expect(h.orch.entry('T1')).toMatchObject({ interruptions: 1, attempts: 0 });

    const { launch: second } = await claim(h);
    const c2 = workerClone(f, second);
    const tip2 = commit(c2, 'two.txt');
    push(c2, second.branch);
    const res = await release(h, second, { keep: true, headSha: tip2 });
    expect(res).toMatchObject({ status: 200, body: { kept: false, progressed: true, outcome: 'failed' } });
    expect(String(res.body['keepError'])).toMatch(/kept releases exhausted \(1 of 1\)/);
    expect(h.orch.entry('T1')).toMatchObject({ interruptions: 1, attempts: 1 });
  }, 30_000);
});

describe('slice: remote lease expiry', () => {
  it('a branch pushed one commit ahead of base is a kept release at the pushed tip; nothing pushed fails the attempt', async () => {
    const f = fixture();
    const h = await start(f);
    const { launch } = await claim(h);
    const clone = workerClone(f, launch);
    const tip = commit(clone, 'T1.txt');
    push(clone, launch.branch);
    const counts = countCalls(h);
    expireLease(h, 1);
    expect(await settleExpiry(h, launch)).toBe('kept');
    expect(counts.preserve).toBe(0);
    expect(counts.remove).toBe(0);
    expect(h.store.listEvents({ kind: 'launch.released', launchId: launch.launchId }).map((e) => e.payload)).toEqual([
      expect.objectContaining({ kept: true, reasonCode: 'leaseExpired', headSha: tip, progressed: true }),
    ]);
    expect(h.store.listEvents({ kind: 'launch.ended', launchId: launch.launchId }).map((e) => e.payload)).toEqual([{ endReason: 'leaseExpired', kept: true }]);
    expect(h.orch.entry('T1')).toMatchObject({ status: { kind: 'unstarted' }, attempts: 0, interruptions: 1 });
    expect(h.orch.entry('T1').carry?.interrupted).toMatchObject({ priorLaunchId: launch.launchId, priorBranch: launch.branch, headSha: tip, reason: 'leaseExpired' });

    // The retry pushes nothing and falls silent: a failed attempt, through the tick.
    const { launch: second } = await claim(h);
    expireLease(h, 1);
    await h.waitFor(() => h.store.getLaunch(second.launchId)?.status === 'ended');
    expect(h.store.getLaunch(second.launchId)).toMatchObject({ status: 'ended', endReason: 'leaseExpired' });
    expect(h.orch.entry('T1').attempts).toBe(1);
    expect(h.orch.entry('T1').carry?.priorFailure).toMatchObject({ kind: 'leaseExpired' });
  }, 30_000);

  it('nothing pushed: the task is failed with reason leaseExpired', async () => {
    const f = fixture();
    const h = await start(f);
    const { launch } = await claim(h);
    expireLease(h, 1);
    expect(await settleExpiry(h, launch)).toBe('failed');
    // A failed attempt: attempts spent and the retry carries the failure (the task is then retried, as for a local launch).
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1 });
    expect(h.orch.entry('T1').carry?.priorFailure).toMatchObject({ kind: 'leaseExpired' });
    expect(h.store.getLaunch(launch.launchId)).toMatchObject({ status: 'ended', endReason: 'leaseExpired' });
    expect(h.store.listEvents({ kind: 'launch.released', launchId: launch.launchId })).toHaveLength(0);
  }, 30_000);

  it('with origin unreachable nothing fails on the first tick; once twice the lease TTL has passed the attempt fails with leaseExpired', async () => {
    const f = fixture();
    const h = await start(f);
    const { launch } = await claim(h);
    const clone = workerClone(f, launch);
    commit(clone, 'T1.txt');
    push(clone, launch.branch);
    renameSync(f.bare, `${f.bare}.away`);

    expireLease(h, 1);
    await h.orch.tick();
    expect(h.store.getLaunch(launch.launchId)?.status).toBe('live');
    expect(h.orch.entry('T1')).toMatchObject({ status: { kind: 'running' }, attempts: 0 });

    // Still short of twice the TTL since the last renewal.
    expireLease(h, TTL - 5_000);
    await h.orch.tick();
    expect(h.store.getLaunch(launch.launchId)?.status).toBe('live');

    expireLease(h, TTL + 1);
    await h.orch.tick();
    expect(h.store.getLaunch(launch.launchId)).toMatchObject({ status: 'ended', endReason: 'leaseExpired' });
    expect(h.orch.entry('T1').attempts).toBe(1);
    expect(h.orch.entry('T1').carry?.priorFailure).toMatchObject({ kind: 'leaseExpired' });
    expect(h.store.listEvents({ kind: 'launch.released', launchId: launch.launchId })).toHaveLength(0);
  }, 30_000);
});

describe('the tick never waits for origin on a remote expiry', () => {
  it('while origin is busy the expiry is skipped without waiting, and a later tick takes the tip', async () => {
    const f = fixture();
    const h = await start(f);
    const { launch } = await claim(h);
    const clone = workerClone(f, launch);
    const tip = commit(clone, 'T1.txt');
    push(clone, launch.branch);
    // Another remote command holds origin's queue for a while.
    const origin = h.orch.origin as unknown as { serial: (fn: () => Promise<void>) => Promise<void> };
    let releaseQueue!: () => void;
    const held = origin.serial(() => new Promise<void>((r) => (releaseQueue = r)));
    expireLease(h, 1);
    const t0 = Date.now();
    expect(await h.orch.expireClaim(h.store.getLaunch(launch.launchId)!)).toBe('skipped');
    expect(Date.now() - t0).toBeLessThan(900);
    expect(h.store.getLaunch(launch.launchId)?.status).toBe('live');
    releaseQueue();
    await held;
    expect(await settleExpiry(h, launch)).toBe('kept');
    expect(h.orch.entry('T1').carry?.interrupted).toMatchObject({ headSha: tip, reason: 'leaseExpired' });
  }, 30_000);
});

type QueuedOrigin = { serial: (fn: () => Promise<void>) => Promise<void>; tipReads: Map<string, unknown> };
const originOf = (h: SliceHarness) => h.orch.origin as unknown as QueuedOrigin;
const heartbeat = (h: SliceHarness, launch: Launch) => http(h, `/v1/launches/${launch.launchId}/heartbeat`, { progress: 'still here' }, launch.token);
const submit = (h: SliceHarness, launch: Launch, extra: Record<string, unknown>, seq = 1) =>
  http(h, `/v1/launches/${launch.launchId}/report`, { kind: 'submit', seq, summary: 'did it', acceptance: [{ criterion: 'a', evidence: 'e' }], ...extra }, launch.token);

/**
 * With origin's queue held, an expiry starts a read of the branch tip and is skipped; the worker then renews its lease
 * by a heartbeat; the queue is released and a no-op queued behind the read is awaited, so the read has settled with
 * what origin held then. The read stays cached in `tipReads`.
 */
async function expiryLeavesRead(h: SliceHarness, launch: Launch): Promise<void> {
  const origin = originOf(h);
  let releaseQueue!: () => void;
  const held = origin.serial(() => new Promise<void>((r) => (releaseQueue = r)));
  expireLease(h, 1);
  expect(await h.orch.expireClaim(h.store.getLaunch(launch.launchId)!)).toBe('skipped');
  expect(origin.tipReads.has(launch.branch)).toBe(true);
  expect((await heartbeat(h, launch)).status).toBe(200);
  expect(h.orch.entry('T1').lease!.expiresAt).toBeGreaterThan(h.orch.now());
  releaseQueue();
  await held;
  await origin.serial(async () => undefined);
  expect(h.store.getLaunch(launch.launchId)?.status).toBe('live');
}

describe('a read of the branch tip belongs to one lease expiry', () => {
  it('an old "no tip" read from before a renewed lease does not fail the next expiry: it is kept at the pushed tip', async () => {
    const f = fixture();
    const h = await start(f);
    const { launch } = await claim(h);
    const clone = workerClone(f, launch);
    await expiryLeavesRead(h, launch);
    // The first read found no branch at origin; the worker pushes only now.
    const tip = commit(clone, 'T1.txt');
    push(clone, launch.branch);
    expireLease(h, 1);
    expect(await settleExpiry(h, launch)).toBe('kept');
    expect(h.store.listEvents({ kind: 'launch.released', launchId: launch.launchId }).map((e) => e.payload)).toEqual([
      expect.objectContaining({ kept: true, reasonCode: 'leaseExpired', headSha: tip }),
    ]);
    expect(h.orch.entry('T1')).toMatchObject({ status: { kind: 'unstarted' }, attempts: 0 });
    expect(h.orch.entry('T1').carry?.interrupted).toMatchObject({ headSha: tip, reason: 'leaseExpired' });
  }, 30_000);

  it('an old sha from before a renewed lease is not kept: the release is kept at the commit pushed after it', async () => {
    const f = fixture();
    const h = await start(f);
    const { launch } = await claim(h);
    const clone = workerClone(f, launch);
    const first = commit(clone, 'one.txt');
    push(clone, launch.branch);
    await expiryLeavesRead(h, launch);
    // The first read saw `first`; the worker pushes a second commit after it.
    const second = commit(clone, 'two.txt');
    expect(second).not.toBe(first);
    push(clone, launch.branch);
    expireLease(h, 1);
    expect(await settleExpiry(h, launch)).toBe('kept');
    expect(h.orch.entry('T1').carry?.interrupted?.headSha, `the first commit is ${first}`).toBe(second);
    expect(h.orch.entry('T1').carry?.interrupted).toMatchObject({ headSha: second, reason: 'leaseExpired' });
    expect(h.store.listEvents({ kind: 'launch.released', launchId: launch.launchId }).map((e) => e.payload)).toEqual([
      expect.objectContaining({ kept: true, reasonCode: 'leaseExpired', headSha: second }),
    ]);
  }, 30_000);

  it('a launch that ends by an accepted submit drops its read', async () => {
    const f = fixture();
    const h = await start(f);
    const { launch } = await claim(h);
    const clone = workerClone(f, launch);
    await expiryLeavesRead(h, launch);
    const tip = commit(clone, 'T1.txt');
    push(clone, launch.branch);
    expect(originOf(h).tipReads.has(launch.branch)).toBe(true);
    expect(await submit(h, launch, { sealedSha: tip })).toMatchObject({ status: 200 });
    await h.orch.tick();
    expect(h.store.getLaunch(launch.launchId)?.status).toBe('ended');
    expect(originOf(h).tipReads.has(launch.branch)).toBe(false);
  }, 30_000);

  it('a launch that ends by a release drops its read', async () => {
    const f = fixture();
    const h = await start(f);
    const { launch } = await claim(h);
    const clone = workerClone(f, launch);
    await expiryLeavesRead(h, launch);
    const tip = commit(clone, 'T1.txt');
    push(clone, launch.branch);
    expect(originOf(h).tipReads.has(launch.branch)).toBe(true);
    expect(await release(h, launch, { keep: true, headSha: tip })).toMatchObject({ status: 200, body: { kept: true } });
    expect(h.store.getLaunch(launch.launchId)?.status).toBe('ended');
    expect(originOf(h).tipReads.has(launch.branch)).toBe(false);
  }, 30_000);

  it('a launch that ends by an operator cancel drops its read', async () => {
    const f = fixture();
    const h = await start(f);
    const { launch } = await claim(h);
    await expiryLeavesRead(h, launch);
    expect(originOf(h).tipReads.has(launch.branch)).toBe(true);
    expect(h.orch.cancel('T1', 'not needed')).toEqual({ ok: true });
    await h.orch.tick();
    expect(h.store.getLaunch(launch.launchId)).toMatchObject({ status: 'ended', endReason: 'cancelled' });
    expect(originOf(h).tipReads.has(launch.branch)).toBe(false);
  }, 30_000);
});

describe('release on the operator MCP server', () => {
  it('declares headSha and wipCommit, so they reach the daemon', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-remote-release-mcp-'));
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/operator/mcp.ts');
    const client = new Client({ name: 'test', version: '0' });
    try {
      await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env: { ...(process.env as Record<string, string>), ORCH_HOME: home }, stderr: 'pipe' }));
      const tool = (await client.listTools()).tools.find((t) => t.name === 'release')!;
      const props = (tool.inputSchema as { properties: Record<string, { type?: string }> }).properties;
      expect(props['headSha']).toMatchObject({ type: 'string' });
      expect(props['wipCommit']).toMatchObject({ type: 'string' });
      expect(tool.description).toMatch(/headSha/);
    } finally {
      await client.close().catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
