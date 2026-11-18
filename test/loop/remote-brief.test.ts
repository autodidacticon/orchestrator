/**
 * The brief of a remote launch: the clone, branch, base commit and integration branch instead of a daemon path, the
 * API at apiBaseUrl, a fallback path relative to the clone, and push-to-origin before submit. A remote run refuses at
 * startup without apiBaseUrl or with a default kind whose commit policy is daemon, and blocks a task labelled to such a
 * kind at admission. See specs/agent-protocol "Standalone brief" and specs/pull-runner "Remote run requirements".
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeBrief, OPENSPEC_CHANGE_RULE } from '../../src/brief/compose.js';
import { remoteBrief } from '../../src/launch/launch.js';
import { gitIn, makeRepo, makeSlice, single, type SliceHarness } from '../slice/harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const API = 'http://orchestrator.example:8080';

/** A temp dir with the daemon's clone and a bare origin cloned from it; `openspec` adds an `openspec/` root first. */
function fixture(opts: { openspec?: boolean } = {}): { dir: string; repo: string; bare: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-remote-brief-'));
  const repo = makeRepo(dir);
  if (opts.openspec) {
    mkdirSync(path.join(repo, 'openspec', 'specs'), { recursive: true });
    gitIn(repo, 'commit', '-q', '--allow-empty', '-m', 'openspec root');
  }
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  return { dir, repo, bare };
}

const health = { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0 };
const remoteRun = (bare: string, extra: Record<string, unknown> = {}) => ({
  leaseTtlMs: 60_000,
  apiBaseUrl: `${API}/`,
  runner: { mode: 'pull' as const, access: 'remote' as const, claimWindowMs: 60_000 },
  git: { pushIntegration: true, originUrl: bare, fetchIntervalMs: 0 },
  health,
  ...extra,
});

const task = ', description: d, acceptanceCriteria: [a]';

async function remoteLaunch(opts: { openspec?: boolean } = {}) {
  const f = fixture(opts);
  h = await makeSlice({ graph: single('hang', task), dir: f.dir, repo: f.repo, config: remoteRun(f.bare) });
  await h.orch.tick();
  const [l] = h.store.listLaunches({ taskId: 'T1' });
  expect(l).toMatchObject({ access: 'remote', worktree: '' });
  return l!;
}

describe('remote brief', () => {
  it('names the branch, base commit, integration branch, apiBaseUrl and the relative fallback path, and no daemon path or loopback address', async () => {
    const l = await remoteLaunch();
    const md = l.briefMarkdown!;
    expect(md).toContain(`- Branch: \`${l.branch}\`, which the worker loop creates at the base commit`);
    expect(md).toContain(`- Base commit: \`${l.baseSha}\``);
    expect(md).toContain('- Integration branch: `main`');
    expect(md).toContain('- Clone: the current directory, a clone of the repository that the worker loop made');
    expect(md).toContain(`\`${API}/v1/launches/${l.launchId}/...\``);
    expect(md).toContain('write your report to `.orchestrator/report.json`, relative to the root of your clone,');
    expect(md).not.toContain(h!.config.dataDir);
    expect(md).not.toContain(path.join(h!.config.dataDir, 'worktrees'));
    expect(md).not.toContain(h!.config.repoPath);
    expect(md).not.toContain('127.0.0.1');
    expect(md).not.toContain('- Worktree:');
    expect(JSON.stringify(l.briefJson)).not.toContain('127.0.0.1');
    expect(JSON.stringify(l.briefJson)).not.toContain(h!.config.dataDir);
  }, 30_000);

  it('tells the agent to commit on the branch and push it to origin before submitting', async () => {
    const l = await remoteLaunch();
    expect(l.briefMarkdown).toContain(
      `- Submit: commit all work on branch \`${l.branch}\` and push it to \`origin\` (\`git push origin ${l.branch}\`) before you call \`report\` with kind submit.`,
    );
  }, 30_000);

  it('briefJson carries the same branch, base commit, API URL and fallback path as the markdown', async () => {
    const l = await remoteLaunch();
    const json = l.briefJson as Record<string, unknown>;
    expect(json).toMatchObject({ branch: l.branch, baseSha: l.baseSha, apiBaseUrl: API, fallbackPath: path.join('.orchestrator', 'report.json'), integrationBranch: 'main', worktree: '' });
    for (const v of [json['branch'], json['baseSha'], json['apiBaseUrl'], json['fallbackPath']]) expect(l.briefMarkdown).toContain(String(v));
  }, 30_000);

  it('carries the OpenSpec change rule for a repository with an openspec/ root, and not without one', async () => {
    const withRoot = await remoteLaunch({ openspec: true });
    expect(withRoot.briefMarkdown).toContain(OPENSPEC_CHANGE_RULE);
    await h!.cleanup();
    h = undefined;
    const without = await remoteLaunch();
    expect(without.briefMarkdown).not.toContain('OpenSpec');
  }, 60_000);

  it('for an interrupted carry, names carry.interrupted.headSha as where the branch starts', async () => {
    const l = await remoteLaunch();
    const interrupted = { priorLaunchId: 'L-prev', priorBranch: 'task/T1/l0', headSha: 'cafe1234', wipCommit: 'beef5678', reason: 'leaseExpired', interruptions: 1 };
    h!.store.setEntry('T1', { ...h!.orch.entry('T1'), carry: { interrupted } });
    const { briefMarkdown, briefJson } = remoteBrief(h!.orch, l);
    expect(briefMarkdown).toContain(`- Branch: \`${l.branch}\`, which the worker loop creates at \`cafe1234\`, the head of your previous launch's work, not at the base commit`);
    expect(briefMarkdown).toContain(`Your branch \`${l.branch}\` starts at \`cafe1234\` (the worker loop creates it there), not at the base commit`);
    expect(briefMarkdown).toContain('squash the work-in-progress commit before submitting');
    expect(briefMarkdown).not.toContain('merging or cherry-picking it onto your base');
    expect(briefJson['context']).toMatchObject({ interrupted: { headSha: 'cafe1234' } });
  }, 30_000);
});

describe('local briefs keep the worktree text', () => {
  it('a launch without access remote names the worktree and the absolute fallback path, with no push line', () => {
    const launch = { launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'live', token: 't', branch: 'task/T1/l1', worktree: '/w', baseSha: 'b', graphRev: 'r', createdAt: 1 };
    const { markdown } = composeBrief(
      {
        launch: launch as never,
        node: { id: 'T1', kind: 'task', payload: { title: 'x', description: 'd', acceptanceCriteria: ['a'] }, deps: [] },
        depReports: [],
        apiBaseUrl: 'http://127.0.0.1:1',
        retryWindowMs: 1000,
        checkCommand: 'true',
        integrationBranch: 'main',
      } as never,
      { fallbackPath: '/w/.orchestrator/report.json', openspec: false },
    );
    expect(markdown).toContain('- Worktree: `/w`');
    expect(markdown).toContain('write your report to `/w/.orchestrator/report.json` and exit');
    expect(markdown).not.toContain('git push origin');
  });
});

describe('a remote run refuses what a remote worker cannot do', () => {
  it('startup without apiBaseUrl fails naming apiBaseUrl', async () => {
    const f = fixture();
    const { apiBaseUrl: _a, ...config } = remoteRun(f.bare);
    h = await makeSlice({ graph: single('hang', task), dir: f.dir, repo: f.repo, config });
    await expect(h.orch.start()).rejects.toThrow(/apiBaseUrl must be set/);
    expect(h.store.listLaunches()).toEqual([]);
  }, 30_000);

  it('startup with runner.kind codex and the default codex.commit fails naming the commit policy', async () => {
    const f = fixture();
    h = await makeSlice({ graph: single('hang', task), dir: f.dir, repo: f.repo, config: remoteRun(f.bare, { runner: { mode: 'pull', access: 'remote', kind: 'codex' } }) });
    await expect(h.orch.start()).rejects.toThrow(/the commit policy of runner\.kind codex must be agent, not daemon \(set runner\.codex\.commit: agent\)/);
    expect(h.store.listLaunches()).toEqual([]);
  }, 30_000);

  it('startup accepts runner.kind codex when runner.codex.commit is agent', async () => {
    const f = fixture();
    h = await makeSlice({ graph: single('hang', task), dir: f.dir, repo: f.repo, config: remoteRun(f.bare, { runner: { mode: 'pull', access: 'remote', kind: 'codex', codex: { commit: 'agent' } } }) });
    await expect(h.orch.start()).resolves.toBeUndefined();
  }, 30_000);

  it('a task labelled runner:codex on a remote claude-code run is blocked at admission with remoteNeedsAgentCommit and gets no launch', async () => {
    const f = fixture();
    h = await makeSlice({ graph: single('hang', `${task}, runner: codex`), dir: f.dir, repo: f.repo, config: remoteRun(f.bare) });
    await h.orch.tick();
    const e = h.orch.entry('T1');
    expect(e.status).toMatchObject({ kind: 'blocked', reason: { kind: 'remoteNeedsAgentCommit' } });
    expect(String((e.status as { reason: { message: string } }).reason.message)).toMatch(/commit policy daemon/);
    expect(h.store.listLaunches()).toEqual([]);
  }, 30_000);
});
