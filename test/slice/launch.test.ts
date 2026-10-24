import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPENSPEC_CHANGE_RULE } from '../../src/brief/compose.js';
import { recover } from '../../src/launch/recovery.js';
import { DEFAULT_OPENCODE_COMMAND, OpenCodeRunner } from '../../src/runner/opencode.js';
import { pidAlive } from '../../src/runner/subprocess.js';
import { commitTrailers } from '../../src/workspace/git.js';
import { gitIn, makeRepo, makeSlice, scriptedAgent, single, tsxLoader, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('slice: launch, API, recovery', () => {
  it('commitAndSubmit: worktree created and removed, branch retained, task done, launch ended', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit') });
    await h.orch.tick();
    const l = h.launchOf('T1');
    expect(existsSync(l.worktree)).toBe(true);
    expect(existsSync(path.join(l.worktree, '.orchestrator', 'brief.md'))).toBe(true);
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    expect(h.store.getLaunch(l.launchId)?.status).toBe('ended');
    expect(existsSync(l.worktree)).toBe(false);
    expect(gitIn(h.repo, 'rev-parse', '--verify', l.branch)).toMatch(/^[0-9a-f]{40}$/);
    expect(gitIn(h.repo, 'log', '--format=%s', l.branch)).toContain('T1: T1.txt');
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    expect(job.sealedSha).toBe(gitIn(h.repo, 'rev-parse', l.branch));
    expect(existsSync(path.join(h.config.dataDir, 'logs', `${l.launchId}.log`))).toBe(true);
    expect(h.pidEvents().some((e) => e.includes('exit'))).toBe(true);
  });

  it('dirty submit gets 409, then succeeds with the same seq', async () => {
    h = await makeSlice({ graph: single('submitDirtyThenFix') });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    expect(h.store.listEvents({ kind: 'agent.report' })).toHaveLength(1);
  });

  // See specs/worker-runners "Sandbox and commit policy".
  it('under commit: daemon a dirty submit is committed by the orchestrator and reaches done', async () => {
    h = await makeSlice({ graph: single('submitDirty'), config: { runner: { claude: { commit: 'daemon' } } } });
    await h.orch.tick();
    const l = h.launchOf('T1');
    expect(l.commitPolicy).toBe('daemon');
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    expect(job.sealedSha).not.toBe(l.baseSha);
    expect(gitIn(h.repo, 'rev-parse', l.branch)).toBe(job.sealedSha);
    expect(gitIn(h.repo, 'log', '-1', '--format=%an', l.branch)).toBe('orchestrator');
    expect(gitIn(h.repo, 'log', '-1', '--format=%s', l.branch)).toBe('T1: daemon-committed');
    const reports = h.store.listEvents({ kind: 'agent.report', taskId: 'T1' });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.payload).toMatchObject({ kind: 'submit', sealedSha: job.sealedSha, committedByOrchestrator: true });
  });

  // The opencode kind through the real OpenCodeRunner and its default template, with a fake `opencode` on PATH running the scripted agent.
  it('under runner.opencode.commit: daemon a dirty opencode submit is committed by the orchestrator and reaches done', async () => {
    h = await makeSlice({ graph: single('submitDirty'), config: { runner: { kind: 'opencode', opencode: { commit: 'daemon' } } } });
    const bin = path.join(h.dir, 'bin');
    const argvLog = path.join(h.dir, 'opencode-argv.txt');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh\necho "$@" > ${argvLog}\n[ -n "$OPENCODE_CONFIG_CONTENT" ] || exit 3\nexec ${process.execPath} --import ${tsxLoader} ${scriptedAgent}\n`, { mode: 0o755 });
    const orch = h.orch;
    const runner = new OpenCodeRunner({
      command: () => orch.effective().config.runner.opencode.command ?? DEFAULT_OPENCODE_COMMAND,
      settings: () => orch.effective().config.runner.opencode,
      allowedTools: () => orch.effective().allowedTools.value,
      maxWaitMs: h.config.maxWaitMs,
      logDir: path.join(h.config.dataDir, 'logs'),
      retryWindowMs: h.config.retryWindowMs,
      graceMs: 500,
      extraEnv: { PATH: `${bin}:${process.env['PATH']}`, ORCH_PIDLOG: h.pidlog },
    });
    (orch as unknown as { runner: unknown }).runner = runner;
    await orch.tick();
    const l = h.launchOf('T1');
    expect(l).toMatchObject({ runner: 'opencode', commitPolicy: 'daemon' });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    expect(readFileSync(argvLog, 'utf8')).toMatch(/^run --format json /);
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    expect(job.sealedSha).not.toBe(l.baseSha);
    expect(gitIn(h.repo, 'rev-parse', l.branch)).toBe(job.sealedSha);
    // The daemon's commit: the orchestrator identity and the summary as the whole message; it adds no git trailer.
    expect(gitIn(h.repo, 'log', '-1', '--format=%an <%ae> %cn <%ce>', l.branch)).toBe('orchestrator <orchestrator@localhost> orchestrator <orchestrator@localhost>');
    expect(gitIn(h.repo, 'log', '-1', '--format=%B', l.branch)).toBe('T1: daemon-committed');
    expect(await commitTrailers(h.repo, job.sealedSha!)).toEqual({});
    expect(gitIn(h.repo, 'show', `${l.branch}:T1.txt`)).toBe('T1 uncommitted');
    expect(gitIn(h.repo, 'show', '--name-only', '--format=', l.branch)).toBe('T1.txt');
    const reports = h.store.listEvents({ kind: 'agent.report', taskId: 'T1' });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.payload).toMatchObject({ kind: 'submit', sealedSha: job.sealedSha, committedByOrchestrator: true });
  });

  it('under commit: daemon a clean worktree without noChanges still fails emptySubmission', async () => {
    h = await makeSlice({ graph: single('hang'), config: { runner: { claude: { commit: 'daemon' } } } });
    await h.orch.tick();
    const l = h.launchOf('T1');
    const res = await h.orch.agentCall(l.launchId, l.token, 'report', { seq: 1, kind: 'submit', summary: 's' });
    expect(res.body).toMatchObject({ accepted: false, outcome: 'failed', reason: 'emptySubmission' });
    expect(gitIn(l.worktree, 'rev-parse', 'HEAD')).toBe(l.baseSha);
    const report = h.store.listEvents({ kind: 'agent.report', taskId: 'T1' })[0];
    expect(report?.payload?.['committedByOrchestrator']).toBeUndefined();
  });

  it('sealing ignores later commits', async () => {
    h = await makeSlice({ graph: single('hang') });
    await h.orch.tick();
    const l = h.launchOf('T1');
    gitIn(l.worktree, 'commit', '-q', '--allow-empty', '-m', 'first');
    const first = gitIn(l.worktree, 'rev-parse', 'HEAD');
    const res = await h.orch.agentCall(l.launchId, l.token, 'report', { seq: 1, kind: 'submit', summary: 's' });
    expect(res.body).toMatchObject({ accepted: true, sealedSha: first });
    gitIn(l.worktree, 'commit', '-q', '--allow-empty', '-m', 'second');
    expect(h.store.listJobs({ taskId: 'T1' })[0]?.sealedSha).toBe(first);
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    expect(h.store.listJobs({ taskId: 'T1' })[0]?.publishedSha).toBe(first);
  });

  it('undeclared no-op fails and declared no-op passes', async () => {
    h = await makeSlice({ graph: `nodes:\n  - { id: A, deps: [], behavior: noopUndeclared }\n  - { id: B, deps: [], behavior: noopDeclared }` });
    await h.waitFor(() => h!.orch.entry('B').status.kind === 'done' && h!.orch.entry('A').attempts >= 1);
    expect(h.store.listEvents({ kind: 'transition', taskId: 'A' }).some((e) => e.payload?.['to'] === 'failed')).toBe(true);
  });

  it('missing acceptance evidence fails the submission', async () => {
    h = await makeSlice({ graph: single('submitNoEvidence', ', acceptanceCriteria: [works]') });
    await h.waitFor(() => h!.orch.entry('T1').attempts >= 1);
    const r = h.store.getReport(h.store.listLaunches({ taskId: 'T1' })[0]!.launchId);
    expect(r?.kind).toBe('submit');
    const failed = h.store.listEvents({ kind: 'transition', taskId: 'T1' }).find((e) => e.payload?.['to'] === 'failed');
    expect(failed).toBeDefined();
    expect(h.orch.entry('T1').status.kind === 'running' || h.orch.entry('T1').status.kind === 'unstarted').toBe(true);
  });

  it('HTTP: token scoping and same-seq replay', async () => {
    h = await makeSlice({ graph: single('hang') });
    await h.orch.tick();
    const l = h.launchOf('T1');
    const url = `${h.orch.apiBaseUrl}/v1/launches/${l.launchId}/heartbeat`;
    const bad = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
    expect(bad.status).toBe(401);
    const ok = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${l.token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(ok.status).toBe(200);
    gitIn(l.worktree, 'commit', '-q', '--allow-empty', '-m', 'x');
    const post = () =>
      fetch(`${h!.orch.apiBaseUrl}/v1/launches/${l.launchId}/report`, {
        method: 'POST',
        headers: { authorization: `Bearer ${l.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ seq: 1, kind: 'submit', summary: 'via http' }),
      }).then((r) => r.json());
    const a = await post();
    const b = await post();
    expect(a).toEqual(b);
    expect(h.store.listEvents({ kind: 'agent.report' })).toHaveLength(1);
  });

  it('block, answer, admission, resume through the real long-poll', async () => {
    h = await makeSlice({ graph: single('blockAndWait:which db?') });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'waiting');
    expect(h.orch.status().openQuestions).toEqual(['T1']);
    expect(h.orch.answer('T1', 'postgres')).toEqual({ ok: true });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    const l = h.store.listLaunches({ taskId: 'T1' })[0]!;
    expect(gitIn(h.repo, 'show', `${l.branch}:T1.txt`)).toBe('answer: postgres');
    expect(h.orch.entry('T1').launches).toBe(1);
  });

  it('maxWait degrades to blocked; a later answer becomes a new launch with the answer in its brief', async () => {
    h = await makeSlice({ graph: single('blockAndWait:pick'), config: { maxWaitMs: 500 } });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'waiting');
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'blocked');
    expect(h.orch.entry('T1').status).toMatchObject({ kind: 'blocked', reason: { message: 'pick' } });
    await h.waitFor(() => h!.pidEvents().some((e) => e.includes('timeout')));
    expect(h.orch.answer('T1', 'b')).toEqual({ ok: true });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    const launches = h.store.listLaunches({ taskId: 'T1' });
    expect(launches).toHaveLength(2);
    const l2 = launches[1]!;
    expect(l2.launchNo).toBe(2);
    expect(JSON.parse(gitIn(h.repo, 'show', `${l2.branch}:T1.txt`).length ? '{}' : '{}')).toEqual({});
    expect(gitIn(h.repo, 'show', `${l2.branch}:T1.txt`)).toBe('answer: b');
  });

  it('offline submission via the fallback file is applied on process exit', async () => {
    h = await makeSlice({ graph: single('offlineSubmit') });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    expect(h.store.listEvents({ kind: 'agent.fallback' })).toHaveLength(1);
    expect(h.store.getCompletionReport('T1')?.body['summary']).toBe('offline submission');
  });

  it('fallback block becomes blocked with the question', async () => {
    h = await makeSlice({ graph: single('blockThenExit') });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'blocked');
    expect(h.orch.entry('T1').status).toMatchObject({ kind: 'blocked', reason: { kind: 'needsAccess', message: 'need credentials' } });
  });

  it('exit without report fails the attempt; lease expiry reaps a hung agent only when the runner cannot observe it', async () => {
    h = await makeSlice({ graph: `nodes:\n  - { id: A, deps: [], behavior: exitSilently }`, config: { leaseTtlMs: 800, maxAttempts: 1 } });
    await h.orch.tick();
    await h.waitFor(() => h!.orch.entry('A').status.kind === 'blocked', 20_000);
    expect(h.orch.entry('A').status).toMatchObject({ kind: 'blocked', reason: { message: expect.stringContaining('exitedWithoutReport') } });

    const h2 = await makeSlice({ graph: `nodes:\n  - { id: B, deps: [], behavior: hang }`, config: { leaseTtlMs: 800, maxAttempts: 1 }, unobserved: true });
    try {
      await h2.orch.tick();
      const lb = h2.launchOf('B');
      await h2.waitFor(() => h2.orch.entry('B').status.kind === 'blocked', 20_000);
      expect(h2.orch.entry('B').status).toMatchObject({ kind: 'blocked', reason: { message: expect.stringContaining('leaseExpired') } });
      expect(pidAlive(lb.pid!)).toBe(false);
    } finally {
      await h2.cleanup();
    }
  });

  it('heartbeats keep a slow agent alive past the TTL', async () => {
    h = await makeSlice({ graph: single('heartbeatThenSubmit:1500'), config: { leaseTtlMs: 700 } });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 20_000);
    expect(h.orch.entry('T1').attempts).toBe(0);
  });

  it('revoked launch: calls get 401, commits stay on its branch, nothing changes', async () => {
    h = await makeSlice({ graph: single('ignore401') });
    await h.orch.tick();
    const l = h.launchOf('T1');
    const before = h.orch.entry('T1');
    // Revoke before the agent's first call, as recovery does for a launch whose spawn it could not confirm.
    h.store.updateLaunch(l.launchId, { status: 'revoked' });
    const mainBefore = gitIn(h.repo, 'rev-parse', 'main');
    const deadline = Date.now() + 20_000;
    while (!h.pidEvents().some((e) => e.includes('got401')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 500));
    expect(h.pidEvents().filter((e) => e.includes('got401')).length).toBeGreaterThan(0);
    expect(h.orch.entry('T1')).toEqual(before);
    expect(gitIn(h.repo, 'rev-parse', 'main')).toBe(mainBefore);
    expect(h.store.listEvents({ kind: 'agent.report' })).toHaveLength(0);
    expect(Number(gitIn(h.repo, 'rev-list', '--count', `${l.branch}`))).toBeGreaterThan(1);
    await h.runner.reap(l);
  });

  // See specs/toolchain-discovery "Runner command composition".
  it('fills the {allowedTools} slot at spawn from the effective list; a rule added through setConfig reaches the next launch only', async () => {
    const graph = 'nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a], effort: low }\n  - { id: T2, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }';
    h = await makeSlice({ graph, config: { capacity: 1, leaseTtlMs: 60_000, runnerCommand: `echo {allowedTools} > {worktree}/.orchestrator/tools.txt && echo {model} {effort} > {worktree}/.orchestrator/selection.txt && echo "$ORCH_HOME" "\${ORCH_URL:-unset}" "\${ORCH_REPO:-unset}" > {worktree}/.orchestrator/env.txt && node --import ${tsxLoader} ${scriptedAgent} {briefJson}` } });
    expect(h.orch.configReport().config.allowedTools.applied).toBe(true);
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    const tools = (worktree: string) => readFileSync(path.join(worktree, '.orchestrator', 'tools.txt'), 'utf8').trim();
    await h.waitFor(() => existsSync(path.join(l1.worktree, '.orchestrator', 'tools.txt')));
    expect(tools(l1.worktree)).toBe('Bash(git:*) mcp__orchestrator__heartbeat mcp__orchestrator__report mcp__orchestrator__block mcp__orchestrator__inbox mcp__orchestrator__log');
    // The task's selector and the run default fill {model} and {effort}. See specs/model-selection "Runners and workers receive the values".
    expect(h.orch.configReport().config.model.applied).toBe(true);
    expect(readFileSync(path.join(l1.worktree, '.orchestrator', 'selection.txt'), 'utf8').trim()).toBe('claude-opus-5-5 low');
    // The agent's ORCH_HOME is inside the run's data directory and the client-side variables are gone. See specs/agent-protocol "Agent environment".
    expect(readFileSync(path.join(l1.worktree, '.orchestrator', 'env.txt'), 'utf8').trim()).toBe(`${path.join(h.orch.config.dataDir, 'child-home')} unset unset`);
    // The brief of a launch the daemon spawns lists the Bash rules in force.
    expect(readFileSync(path.join(l1.worktree, '.orchestrator', 'brief.md'), 'utf8')).toContain('these Bash rules are in force: `Bash(git:*)`');
    expect(h.orch.setConfig({ allowedTools: ['Bash(docker:*)'] })).toMatchObject({ ok: true, applied: ['allowedTools'] });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done' && h!.store.listLaunches({ taskId: 'T2', status: 'live' }).length === 1);
    const l2 = h.launchOf('T2');
    await h.waitFor(() => existsSync(path.join(l2.worktree, '.orchestrator', 'tools.txt')));
    expect(tools(l2.worktree)).toBe('Bash(git:*) mcp__orchestrator__heartbeat mcp__orchestrator__report mcp__orchestrator__block mcp__orchestrator__inbox mcp__orchestrator__log Bash(docker:*)');
    expect(readFileSync(path.join(l2.worktree, '.orchestrator', 'selection.txt'), 'utf8').trim()).toBe('claude-opus-5-5 medium');
    expect(readFileSync(path.join(l2.worktree, '.orchestrator', 'brief.md'), 'utf8')).toContain('`Bash(docker:*)`');
    await h.runner.reap(l2);
  });

  // ORC-74's rule reaches a real launch: GitWorkspace.prepare composes the brief in the worktree, which holds what the repository committed.
  it('a launch in a repository with an openspec/ root gets the change-directory rule in its brief; one without does not', async () => {
    const briefOf = async (openspec: boolean) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'orch-slice-'));
      const repo = makeRepo(dir);
      if (openspec) {
        mkdirSync(path.join(repo, 'openspec', 'specs'), { recursive: true });
        writeFileSync(path.join(repo, 'openspec', 'project.md'), '# toy\n');
        gitIn(repo, 'add', '.');
        gitIn(repo, 'commit', '-q', '-m', 'openspec');
      }
      h = await makeSlice({ graph: single('hang'), dir, repo, config: { leaseTtlMs: 60_000, runner: { mode: 'pull', claimWindowMs: 60_000 } } });
      await h.orch.tick();
      const [l] = h.store.listLaunches({ taskId: 'T1' });
      expect(existsSync(path.join(l!.worktree, 'openspec'))).toBe(openspec);
      const md = readFileSync(path.join(l!.worktree, '.orchestrator', 'brief.md'), 'utf8');
      await h.cleanup();
      h = undefined;
      return md;
    };
    expect(await briefOf(true)).toContain(OPENSPEC_CHANGE_RULE);
    expect(await briefOf(false)).not.toContain(OPENSPEC_CHANGE_RULE);
  });

  it('pull mode parks the launch as claimable with its brief; a claim makes it live with a worker and no pid', async () => {
    h = await makeSlice({ graph: single('hang'), config: { leaseTtlMs: 60_000, runner: { mode: 'pull', claimWindowMs: 60_000 } } });
    await h.orch.tick();
    const [l] = h.store.listLaunches({ taskId: 'T1' });
    expect(l?.status).toBe('claimable');
    expect(l?.pid).toBeUndefined();
    expect(l?.worker).toBeUndefined();
    expect(existsSync(path.join(l!.worktree, '.orchestrator', 'brief.json'))).toBe(true);
    expect(h.orch.entry('T1').status.kind).toBe('running');
    expect((await h.orch.agentCall(l!.launchId, l!.token, 'heartbeat')).status).toBe(401);
    const claim = await h.orch.claim({ workerId: 'w1' });
    expect(claim.status).toBe(200);
    expect(claim.body).toMatchObject({ launchId: l!.launchId, taskId: 'T1', token: l!.token, worktree: l!.worktree, baseSha: l!.baseSha, apiUrl: h.orch.apiBaseUrl });
    expect((claim.body['brief'] as { taskId: string }).taskId).toBe('T1');
    expect(h.store.getLaunch(l!.launchId)).toMatchObject({ status: 'live', worker: { id: 'w1' } });
    expect(h.store.getLaunch(l!.launchId)?.pid).toBeUndefined();
    expect((await h.orch.agentCall(l!.launchId, l!.token, 'heartbeat')).status).toBe(200);
    expect(h.store.listEvents({ launchId: l!.launchId }).map((e) => e.kind)).toEqual(['launch.created', 'launch.claimable', 'launch.claimed', 'agent.heartbeat']);
  });

  it('mixed mode spawns a parked launch after its claim window', async () => {
    h = await makeSlice({ graph: single('hang'), config: { leaseTtlMs: 60_000, runner: { mode: 'mixed', claimWindowMs: 300 } } });
    await h.orch.tick();
    const [l] = h.store.listLaunches({ taskId: 'T1' });
    expect(l?.status).toBe('claimable');
    await h.orch.tick();
    expect(h.store.getLaunch(l!.launchId)?.status).toBe('claimable');
    await new Promise((r) => setTimeout(r, 400));
    await h.orch.tick();
    const spawned = h.store.getLaunch(l!.launchId)!;
    expect(spawned.status).toBe('live');
    expect(spawned.worker).toBeUndefined();
    expect(spawned.pid).toBeGreaterThan(0);
    expect(pidAlive(spawned.pid!)).toBe(true);
    expect(h.store.listEvents({ launchId: l!.launchId }).map((e) => e.kind)).toEqual(['launch.created', 'launch.claimable', 'launch.live']);
  });

  it('recovery: launch stuck in launching is revoked, killed by launch id, and relaunched on the same attempt', async () => {
    h = await makeSlice({ graph: single('hang') });
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    // Simulate a crash between spawn and pid record.
    h.store.updateLaunch(l1.launchId, { status: 'launching', pid: undefined, spawnedAt: undefined });
    await h.restart();
    expect(h.store.getLaunch(l1.launchId)?.status).toBe('revoked');
    expect(existsSync(l1.worktree)).toBe(false);
    for (let i = 0; i < 40 && pidAlive(l1.pid!); i++) await new Promise((r) => setTimeout(r, 50));
    expect(pidAlive(l1.pid!)).toBe(false);
    const l2 = h.launchOf('T1');
    expect(l2.launchId).not.toBe(l1.launchId);
    expect(l2.attempt).toBe(1);
    expect(l2.launchNo).toBe(2);
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 0, launches: 2, status: { kind: 'running' } });
  });

  it('recovery: a live launch with a surviving process is adopted', async () => {
    h = await makeSlice({ graph: single('slowSubmit:1500') });
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    await h.restart();
    expect(h.store.getLaunch(l1.launchId)?.status).toBe('live');
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 20_000);
    expect(h.store.listLaunches({ taskId: 'T1' })).toHaveLength(1);
  });

  it('recovery: stray worktree is swept', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit') });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    const l = h.store.listLaunches({ taskId: 'T1' })[0]!;
    mkdirSync(path.dirname(l.worktree), { recursive: true });
    gitIn(h.repo, 'worktree', 'add', '--detach', l.worktree, 'main');
    expect(await h.workspace.listWorktrees()).toEqual([l.launchId]);
    await recover(h.orch);
    expect(await h.workspace.listWorktrees()).toEqual([]);
  });
});
