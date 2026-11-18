/**
 * The seal of a remote submit: the worker pushes the launch branch to origin and reports the tip as `sealedSha`; the
 * daemon fetches the branch into its clone and compares. See specs/remote-workspace "Seal" and specs/agent-protocol
 * "Submission sealing".
 */
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sealRefusal } from '../../src/loop/orchestrator.js';
import type { Launch } from '../../src/state/store.js';
import { type Origin, OriginConfigError, OriginFetchError } from '../../src/workspace/origin.js';
import { RemoteWorkspace } from '../../src/workspace/remote-workspace.js';
import { gitIn, makeRepo, makeSlice, single, type SliceHarness, tsxLoader } from './harness.js';

const harnesses: SliceHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

/** A temp dir with the daemon's clone and a bare origin cloned from it. */
function fixture(): { dir: string; repo: string; bare: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-remote-seal-'));
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
const GRAPH = single('hang', ', description: d, acceptanceCriteria: [a]');

async function http(h: SliceHarness, route: string, body: Record<string, unknown>, token?: string) {
  const res = await fetch(`${h.orch.apiBaseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Start a run, admit T1 and claim its launch as a remote worker. */
async function claimed(f: { dir: string; repo: string; bare: string }, realVerifier = false): Promise<{ h: SliceHarness; launch: Launch }> {
  const h = await makeSlice({ graph: GRAPH, dir: f.dir, repo: f.repo, realVerifier, config: remoteRun(f.bare) });
  harnesses.push(h);
  await h.orch.tick();
  const c = await http(h, '/v1/claims', { workerId: 'w1', access: 'remote' });
  expect(c.status).toBe(200);
  const launch = h.store.getLaunch(String(c.body['launchId']))!;
  expect(launch).toMatchObject({ access: 'remote', worktree: '', status: 'live' });
  expect(h.orch.entry('T1').status.kind).toBe('running');
  return { h, launch };
}

/** The worker's own clone of origin, on the launch branch at its base. */
function workerClone(f: { dir: string; bare: string }, launch: Launch): string {
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

const push = (clone: string, branch: string) => gitIn(clone, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
const submit = (h: SliceHarness, launch: Launch, extra: Record<string, unknown>, seq = 1) =>
  http(h, `/v1/launches/${launch.launchId}/report`, { kind: 'submit', seq, summary: 'did it', acceptance: [{ criterion: 'a', evidence: 'e' }], ...extra }, launch.token);
const reports = (h: SliceHarness, launch: Launch) => h.store.listEvents({ kind: 'agent.report', launchId: launch.launchId });

describe('slice: remote seal on submit', () => {
  it('refuses a branch not on origin and another tip, keeps the task running, then accepts the pushed tip and publishes it', async () => {
    const f = fixture();
    const { h, launch } = await claimed(f, true);
    const clone = workerClone(f, launch);
    const tip = commit(clone, 'T1.txt');

    // Not pushed: origin has no launch branch.
    const notPushed = await submit(h, launch, { sealedSha: tip });
    expect(notPushed).toMatchObject({ status: 409, body: { reason: 'branchNotPushed', branch: launch.branch } });
    expect(h.orch.entry('T1').status.kind).toBe('running');
    expect(reports(h, launch)).toHaveLength(0);

    // Pushed, but the report names the tip's parent.
    push(clone, launch.branch);
    const parent = gitIn(clone, 'rev-parse', 'HEAD^');
    expect(parent).toBe(launch.baseSha);
    const mismatch = await submit(h, launch, { sealedSha: parent });
    expect(mismatch).toMatchObject({ status: 409, body: { reason: 'shaMismatch', branch: launch.branch, expected: parent, actual: tip } });
    expect(h.orch.entry('T1').status.kind).toBe('running');
    expect(reports(h, launch)).toHaveLength(0);

    // The same seq again with the pushed tip: refusals recorded nothing, so it is accepted.
    const ok = await submit(h, launch, { sealedSha: tip });
    expect(ok).toMatchObject({ status: 200, body: { accepted: true, outcome: 'submitted', sealedSha: tip } });
    expect(reports(h, launch)).toHaveLength(1);
    expect(reports(h, launch)[0]!.payload).toMatchObject({ kind: 'submit', seq: 1, sealedSha: tip });
    // The daemon's clone holds the commit on the launch branch.
    expect(gitIn(f.repo, 'cat-file', '-t', tip)).toBe('commit');
    expect(gitIn(f.repo, 'rev-parse', `refs/heads/${launch.branch}`)).toBe(tip);

    // The verifier rebases the sealed sha from the clone and publishes it to origin with the trailers.
    await h.waitFor(() => h.store.listJobs({ status: 'published' }).some((j) => j.taskId === 'T1'), 30_000);
    const job = h.store.listJobs({ status: 'published' }).find((j) => j.taskId === 'T1')!;
    expect(job.sealedSha).toBe(tip);
    expect(gitIn(f.bare, 'rev-parse', 'main')).toBe(job.publishedSha);
    expect(gitIn(f.bare, 'show', '-s', '--format=%(trailers:key=Orchestrator-Task,valueonly)', 'main')).toBe('T1');
    expect(gitIn(f.bare, 'show', '--format=', '--name-only', 'main')).toBe('T1.txt');
  }, 60_000);

  it('a remote submit without sealedSha answers 400 naming the field, and a malformed one too', async () => {
    const f = fixture();
    const { h, launch } = await claimed(f);
    const clone = workerClone(f, launch);
    commit(clone, 'T1.txt');
    push(clone, launch.branch);
    const missing = await submit(h, launch, {});
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ field: 'sealedSha' });
    expect(String(missing.body['error'])).toMatch(/sealedSha/);
    const short = await submit(h, launch, { sealedSha: 'abc123' });
    expect(short).toMatchObject({ status: 400, body: { field: 'sealedSha' } });
    expect(h.orch.entry('T1').status.kind).toBe('running');
    expect(reports(h, launch)).toHaveLength(0);
  }, 30_000);

  it('origin unreachable answers 503 originUnreachable, records nothing, and the task stays running until origin is back', async () => {
    const f = fixture();
    const { h, launch } = await claimed(f);
    const clone = workerClone(f, launch);
    const tip = commit(clone, 'T1.txt');
    push(clone, launch.branch);
    const away = `${f.bare}.away`;
    renameSync(f.bare, away);
    const res = await submit(h, launch, { sealedSha: tip });
    expect(res).toMatchObject({ status: 503, body: { reason: 'originUnreachable' } });
    expect(reports(h, launch)).toHaveLength(0);
    expect(h.store.listEvents({ kind: 'agent.report' })).toHaveLength(0);
    expect(h.orch.entry('T1').status.kind).toBe('running');
    expect(h.store.listJobs({})).toHaveLength(0);

    // Origin back: the worker retries the same seq and is accepted.
    renameSync(away, f.bare);
    expect(await submit(h, launch, { sealedSha: tip })).toMatchObject({ status: 200, body: { accepted: true, outcome: 'submitted' } });
  }, 30_000);

  it('a pushed tip equal to baseSha without noChanges answers emptySubmission, as a local submit does', async () => {
    const f = fixture();
    const { h, launch } = await claimed(f);
    const clone = workerClone(f, launch);
    push(clone, launch.branch);
    const remote = await submit(h, launch, { sealedSha: launch.baseSha });
    expect(remote).toMatchObject({ status: 200, body: { accepted: false, outcome: 'failed', reason: 'emptySubmission' } });
    // The attempt is spent and the task is no longer running, as for a local empty submission.
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1 });
    expect(h.orch.entry('T1').status.kind).not.toBe('running');

    // The same submit from a local worker on a clean worktree at its base.
    const local = await makeSlice({ graph: GRAPH, config: { leaseTtlMs: 60_000, runner: { mode: 'pull', claimWindowMs: 60_000 }, health } });
    harnesses.push(local);
    await local.orch.tick();
    const c = await http(local, '/v1/claims', { workerId: 'w1' });
    const localLaunch = local.store.getLaunch(String(c.body['launchId']))!;
    const localRes = await submit(local, localLaunch, {});
    expect(remote).toEqual(localRes);
    expect(local.orch.entry('T1')).toMatchObject({ attempts: 1, status: h.orch.entry('T1').status });
  }, 30_000);

  it('a local submit ignores sealedSha', async () => {
    const h = await makeSlice({ graph: GRAPH, config: { leaseTtlMs: 60_000, runner: { mode: 'pull', claimWindowMs: 60_000 }, health } });
    harnesses.push(h);
    await h.orch.tick();
    const c = await http(h, '/v1/claims', { workerId: 'w1' });
    const launch = h.store.getLaunch(String(c.body['launchId']))!;
    const tip = commit(launch.worktree, 'T1.txt');
    const res = await submit(h, launch, { sealedSha: 'not a sha' });
    expect(res).toMatchObject({ status: 200, body: { accepted: true, outcome: 'submitted', sealedSha: tip } });
  }, 30_000);
});

describe('RemoteWorkspace.seal', () => {
  const launch = { launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'live', token: 't', branch: 'task/T1/l1', worktree: '', baseSha: 'b'.repeat(40), graphRev: 'r', createdAt: 0, access: 'remote' } as Launch;
  const failing = (err: Error) => new RemoteWorkspace({ fetchBranch: async () => Promise.reject(err) } as unknown as Origin);

  it('maps a refused fetch to originRefused and a missing remote to originUnreachable, both answered 503', async () => {
    const refused = await failing(new OriginFetchError('denied', 'refused')).seal(launch, { sealedSha: 'a'.repeat(40) });
    expect(refused).toMatchObject({ ok: false, reason: 'originRefused', branch: 'task/T1/l1' });
    const config = await failing(new OriginConfigError('no remote')).seal(launch, { sealedSha: 'a'.repeat(40) });
    expect(config).toMatchObject({ ok: false, reason: 'originUnreachable' });
    for (const r of [refused, config]) if (!r.ok) expect(sealRefusal(r).status).toBe(503);
    await expect(failing(new Error('boom')).seal(launch, { sealedSha: 'a'.repeat(40) })).rejects.toThrow('boom');
  });

  it('without a sealedSha or an origin it rejects as a tree-bound call', async () => {
    await expect(failing(new Error('never')).seal(launch)).rejects.toThrow(/remote launch has no worktree: L1/);
    await expect(new RemoteWorkspace().seal(launch, { sealedSha: 'a'.repeat(40) })).rejects.toThrow(/remote launch has no worktree: L1/);
  });
});

describe('launch_report on the operator MCP server', () => {
  it('carries sealedSha through to the daemon', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-remote-seal-mcp-'));
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/operator/mcp.ts');
    const client = new Client({ name: 'test', version: '0' });
    try {
      await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, entry], env: { ...(process.env as Record<string, string>), ORCH_HOME: home }, stderr: 'pipe' }));
      const report = (await client.listTools()).tools.find((t) => t.name === 'launch_report')!;
      const props = (report.inputSchema as { properties: Record<string, { type?: string }> }).properties;
      expect(props['sealedSha']).toMatchObject({ type: 'string' });
      expect(report.description).toMatch(/sealedSha/);
    } finally {
      await client.close().catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
