/**
 * The MCP shim in remote mode (`ORCH_ACCESS=remote`, `ORCH_WORKTREE`, `ORCH_BRANCH`): its `report` tool checks the
 * worker's clone, pushes the launch branch to origin and names the pushed commit as `sealedSha` before it calls the
 * daemon. Runs the shim as an MCP server against a remote launch claimed over HTTP, with a bare origin and a clone made
 * by the test. See specs/agent-protocol "MCP façade".
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Launch } from '../../src/state/store.js';
import { gitIn, makeRepo, makeSlice, single, type SliceHarness, tsxLoader } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const shim = path.resolve(here, '../../src/agent/mcp-shim.ts');

/** The report tool's description at c5471a4, without ORCH_ACCESS. */
const LOCAL_DESCRIPTION = 'Final report. kind=submit requires a committed, clean worktree; kind=fail gives up. seq must increase per call.';

const harnesses: SliceHarness[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  for (const h of harnesses.splice(0)) await h.cleanup();
});

type Fixture = { dir: string; repo: string; bare: string };

/** A temp dir (its real path) with the daemon's clone and a bare origin cloned from it. */
function fixture(): Fixture {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-shim-remote-')));
  const repo = makeRepo(dir);
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  return { dir, repo, bare };
}

const remoteRun = (bare: string) => ({
  leaseTtlMs: 60_000,
  runner: { mode: 'pull' as const, access: 'remote' as const, claimWindowMs: 60_000 },
  git: { pushIntegration: true, originUrl: bare, fetchIntervalMs: 0 },
  health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0 },
});
const GRAPH = single('hang', ', description: d, acceptanceCriteria: [a]');

async function http(h: SliceHarness, route: string, body: Record<string, unknown>, token?: string) {
  const res = await fetch(`${h.orch.apiBaseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Start a remote run, admit T1 and claim its launch over HTTP as a remote worker. */
async function claimed(f: Fixture): Promise<{ h: SliceHarness; launch: Launch }> {
  const h = await makeSlice({ graph: GRAPH, dir: f.dir, repo: f.repo, config: remoteRun(f.bare) });
  harnesses.push(h);
  await h.orch.tick();
  const c = await http(h, '/v1/claims', { workerId: 'w1', access: 'remote' });
  expect(c.status).toBe(200);
  const launch = h.store.getLaunch(String(c.body['launchId']))!;
  expect(launch).toMatchObject({ access: 'remote', worktree: '', status: 'live', lastSignal: 'claimed' });
  return { h, launch };
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

/** The tip of the launch branch at origin, or undefined when origin has no such branch. */
function originTip(f: Fixture, branch: string): string | undefined {
  const out = gitIn(f.bare, 'for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`);
  return out || undefined;
}

/** The shim's environment, built explicitly: the remote variables only when the case sets them. */
function shimEnvFor(api: string, launch: Pick<Launch, 'launchId' | 'token'>, vars: Record<string, string> = {}): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  for (const k of ['ORCH_ACCESS', 'ORCH_WORKTREE', 'ORCH_BRANCH', 'ORCH_COMMIT_POLICY']) delete env[k];
  return { ...env, ORCH_API: api, ORCH_LAUNCH_ID: launch.launchId, ORCH_TOKEN: launch.token, ORCH_RETRY_WINDOW_MS: '8000', ...vars };
}

async function connect(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  clients.push(client);
  await client.connect(new StdioClientTransport({ command: 'node', args: ['--import', tsxLoader, shim], env, stderr: 'pipe' }));
  return client;
}

/** A client of the shim in remote mode for `launch`, with `worktree` as ORCH_WORKTREE. */
const remoteShim = (h: SliceHarness, launch: Launch, worktree: string) => connect(shimEnvFor(h.orch.apiBaseUrl, launch, { ORCH_ACCESS: 'remote', ORCH_WORKTREE: worktree, ORCH_BRANCH: launch.branch }));

function parse(r: unknown): Record<string, unknown> {
  const content = (r as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

const SUBMIT = { kind: 'submit', summary: 'via the remote shim', acceptance: [{ criterion: 'a', evidence: 'e' }] };
const report = async (client: Client, args: Record<string, unknown>) => {
  const r = await client.callTool({ name: 'report', arguments: args });
  return { isError: Boolean((r as { isError?: boolean }).isError), body: parse(r) };
};
const reports = (h: SliceHarness, launch: Launch) => h.store.listEvents({ kind: 'agent.report', launchId: launch.launchId });
const lastSignal = (h: SliceHarness, launch: Launch) => h.store.getLaunch(launch.launchId)!.lastSignal;

describe('slice: the MCP shim in remote mode', () => {
  it('an accepted submit: pushes the unpushed commit, names HEAD as sealedSha, and the task is submitted', async () => {
    const f = fixture();
    const { h, launch } = await claimed(f);
    const clone = workerClone(f, launch);
    const head = commit(clone, 'work.txt');
    expect(originTip(f, launch.branch)).toBeUndefined();
    const client = await remoteShim(h, launch, clone);

    const r = await report(client, { seq: 1, ...SUBMIT });
    expect(r).toMatchObject({ isError: false, body: { status: 200, accepted: true } });
    expect(originTip(f, launch.branch)).toBe(head);
    const events = reports(h, launch);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ kind: 'submit', seq: 1, sealedSha: head });
    expect(h.orch.entry('T1').status.kind).toBe('submitted');
  }, 60_000);

  it('a dirty clone answers 409 dirtyWorktree without a round trip; .orchestrator/ alone does not count', async () => {
    const f = fixture();
    const { h, launch } = await claimed(f);
    const clone = workerClone(f, launch);
    const head = commit(clone, 'work.txt');
    const client = await remoteShim(h, launch, clone);

    // A changed tracked file.
    writeFileSync(path.join(clone, 'README.md'), '# changed\n');
    const tracked = await report(client, { seq: 1, ...SUBMIT });
    expect(tracked).toMatchObject({ isError: true, body: { status: 409, error: 'dirtyWorktree', files: ['README.md'] } });
    expect(originTip(f, launch.branch)).toBeUndefined();
    expect(lastSignal(h, launch)).toBe('claimed');

    // An untracked file.
    gitIn(clone, 'checkout', '--', 'README.md');
    writeFileSync(path.join(clone, 'new.txt'), 'new\n');
    const untracked = await report(client, { seq: 1, ...SUBMIT });
    expect(untracked).toMatchObject({ isError: true, body: { status: 409, error: 'dirtyWorktree', files: ['new.txt'] } });
    expect(originTip(f, launch.branch)).toBeUndefined();
    expect(lastSignal(h, launch)).toBe('claimed');
    expect(reports(h, launch)).toHaveLength(0);

    // Only files under .orchestrator/ (not excluded in this clone): clean, and the same seq is accepted.
    gitIn(clone, 'clean', '-fq', '--', 'new.txt');
    mkdirSync(path.join(clone, '.orchestrator'), { recursive: true });
    writeFileSync(path.join(clone, '.orchestrator', 'brief.md'), 'brief\n');
    expect(gitIn(clone, 'status', '--porcelain', '--untracked-files=all')).toBe('?? .orchestrator/brief.md');
    const clean = await report(client, { seq: 1, ...SUBMIT });
    expect(clean).toMatchObject({ isError: false, body: { status: 200, accepted: true } });
    expect(originTip(f, launch.branch)).toBe(head);
    expect(reports(h, launch)[0]!.payload).toMatchObject({ sealedSha: head });
  }, 60_000);

  it('a failed push answers 503 pushFailed without a round trip; with origin back, the same seq is accepted', async () => {
    const f = fixture();
    const { h, launch } = await claimed(f);
    const clone = workerClone(f, launch);
    const head = commit(clone, 'work.txt');
    const client = await remoteShim(h, launch, clone);

    const away = `${f.bare}.away`;
    renameSync(f.bare, away);
    const failed = await report(client, { seq: 1, ...SUBMIT });
    expect(failed).toMatchObject({ isError: true, body: { status: 503, error: 'pushFailed' } });
    expect(String(failed.body['message'])).not.toBe('');
    expect(lastSignal(h, launch)).toBe('claimed');
    expect(reports(h, launch)).toHaveLength(0);

    renameSync(away, f.bare);
    const ok = await report(client, { seq: 1, ...SUBMIT });
    expect(ok).toMatchObject({ isError: false, body: { status: 200, accepted: true } });
    expect(originTip(f, launch.branch)).toBe(head);
    expect(reports(h, launch)[0]!.payload).toMatchObject({ seq: 1, sealedSha: head });
  }, 60_000);

  it('a git failure answers 500 gitFailed without a round trip', async () => {
    const f = fixture();
    const { h, launch } = await claimed(f);
    const notARepo = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-shim-not-a-repo-')));
    expect(spawnSync('git', ['rev-parse', '--git-dir'], { cwd: notARepo }).status).not.toBe(0);
    const client = await remoteShim(h, launch, notARepo);

    const r = await report(client, { seq: 1, ...SUBMIT });
    expect(r).toMatchObject({ isError: true, body: { status: 500, error: 'gitFailed' } });
    expect(String(r.body['message'])).toMatch(/git/);
    expect(lastSignal(h, launch)).toBe('claimed');
    expect(reports(h, launch)).toHaveLength(0);
  }, 60_000);

  it('a rewritten branch: after a shaMismatch refusal, the amended commit is pushed (forced) and accepted with the same seq', async () => {
    const f = fixture();
    const { h, launch } = await claimed(f);
    const clone = workerClone(f, launch);
    const a = commit(clone, 'a.txt');
    gitIn(clone, 'push', '-q', 'origin', `HEAD:refs/heads/${launch.branch}`);
    const mismatch = await http(h, `/v1/launches/${launch.launchId}/report`, { seq: 1, ...SUBMIT, sealedSha: launch.baseSha }, launch.token);
    expect(mismatch).toMatchObject({ status: 409, body: { reason: 'shaMismatch', expected: launch.baseSha, actual: a } });
    // The daemon fetched A into its clone.
    expect(gitIn(f.repo, 'cat-file', '-t', a)).toBe('commit');

    gitIn(clone, 'commit', '-q', '--amend', '-m', 'add a.txt, amended');
    const a2 = gitIn(clone, 'rev-parse', 'HEAD');
    expect(a2).not.toBe(a);
    const client = await remoteShim(h, launch, clone);
    const r = await report(client, { seq: 1, ...SUBMIT });
    expect(r).toMatchObject({ isError: false, body: { status: 200, accepted: true } });
    expect(originTip(f, launch.branch)).toBe(a2);
    expect(reports(h, launch)).toHaveLength(1);
    expect(reports(h, launch)[0]!.payload).toMatchObject({ kind: 'submit', seq: 1, sealedSha: a2 });
  }, 60_000);

  it('a fail report is forwarded as it is: nothing is pushed and no sealedSha is sent', async () => {
    const f = fixture();
    const { h, launch } = await claimed(f);
    const clone = workerClone(f, launch);
    commit(clone, 'work.txt');
    const client = await remoteShim(h, launch, clone);

    const r = await report(client, { seq: 1, kind: 'fail', tried: 'everything', why: 'impossible', whatWouldUnblock: 'nothing' });
    expect(r).toMatchObject({ isError: false, body: { status: 200, outcome: 'failed' } });
    const events = reports(h, launch);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ kind: 'fail', seq: 1 });
    expect(events[0]!.payload).not.toHaveProperty('sealedSha');
    expect(h.orch.entry('T1').attempts).toBe(1);
    expect(originTip(f, launch.branch)).toBeUndefined();
  }, 60_000);

  it('at start: remote mode needs ORCH_BRANCH and ORCH_WORKTREE; the description and --help name the remote mode', async () => {
    const launch = { launchId: 'L1', token: 't' };
    const api = 'http://127.0.0.1:1';
    for (const [missing, vars] of [
      ['ORCH_BRANCH', { ORCH_ACCESS: 'remote', ORCH_WORKTREE: '/tmp' }],
      ['ORCH_WORKTREE', { ORCH_ACCESS: 'remote', ORCH_BRANCH: 'task/T1/l1' }],
    ] as const) {
      const r = spawnSync('node', ['--import', tsxLoader, shim], { env: shimEnvFor(api, launch, vars), encoding: 'utf8', input: '', timeout: 20_000 });
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain(missing);
    }

    const remote = await connect(shimEnvFor(api, launch, { ORCH_ACCESS: 'remote', ORCH_WORKTREE: '/tmp', ORCH_BRANCH: 'task/T1/l1' }));
    const remoteDescription = (await remote.listTools()).tools.find((t) => t.name === 'report')?.description ?? '';
    expect(remoteDescription).toContain('origin');
    expect(remoteDescription).toContain('same seq');
    // Any other ORCH_ACCESS is c5471a4's shim; ORCH_WORKTREE alone (a spawned agent's environment) changes nothing.
    for (const vars of [{}, { ORCH_WORKTREE: '/tmp' }, { ORCH_ACCESS: 'local', ORCH_WORKTREE: '/tmp' }] as Record<string, string>[]) {
      const local = await connect(shimEnvFor(api, launch, vars));
      expect((await local.listTools()).tools.find((t) => t.name === 'report')?.description).toBe(LOCAL_DESCRIPTION);
    }

    const help = spawnSync('node', ['--import', tsxLoader, shim, '--help'], { encoding: 'utf8', timeout: 20_000 });
    expect(help.status).toBe(0);
    for (const name of ['ORCH_ACCESS', 'ORCH_WORKTREE', 'ORCH_BRANCH']) expect(help.stdout).toContain(name);
  }, 60_000);
});
