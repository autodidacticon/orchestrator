/**
 * End to end through the real daemon (main.ts), operator CLI, and scripted agents.
 */
import type { ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/operator/cli.js';
import { pidAlive } from '../../src/runner/subprocess.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import { type CrashRun, setupCrashRun } from '../crash/harness.js';
import { gitIn } from '../slice/harness.js';

/**
 * The pid of `taskId`'s launch once its `launch.live` event is recorded, asserting the launch is
 * still live (mid-task). `waitUntil` opens the store only after the daemon has created it, and a
 * daemon that exits fails the wait at once with its log instead of after the deadline.
 */
async function livePid(run: CrashRun, daemon: ChildProcess, taskId: string): Promise<number> {
  let pid: number | undefined;
  await run.waitUntil(() => {
    if (daemon.exitCode !== null) throw new Error(`daemon exited ${daemon.exitCode}; log:\n${readFileSync(run.daemonLog, 'utf8').slice(-4000)}`);
    const s = new SqliteStore(path.join(run.dataDir, 'store.sqlite'));
    try {
      pid = s.listEvents({ kind: 'launch.live', taskId }).at(-1)?.payload?.['pid'] as number | undefined;
      return pid !== undefined;
    } finally {
      s.close();
    }
  }, 30_000);
  const s = new SqliteStore(path.join(run.dataDir, 'store.sqlite'));
  try {
    expect(s.listLaunches({ taskId, status: 'live' }).map((l) => l.pid), JSON.stringify(s.listEvents({ taskId }))).toEqual([pid]);
  } finally {
    s.close();
  }
  return pid!;
}

describe('e2e with scripted agents', () => {
  it('daemon + CLI: one trailer commit per task, milestone tag, accept via CLI, status finished', async () => {
    const run = await setupCrashRun();
    try {
      const child = run.start();
      await run.waitTerminal();
      const store = new SqliteStore(path.join(run.dataDir, 'store.sqlite'));
      const url = store.getKv('apiBaseUrl')!;
      store.close();
      const status = await runCli(['status', '--url', url]);
      expect(status.body).toMatchObject({ byStatus: { done: ['T1', 'T2', 'T3', 'T4', 'T5'], submitted: ['MVP'] }, finished: false, stalled: false, awaitingReview: ['MVP'] });
      const mvp = run.entries().get('MVP')!;
      expect(gitIn(run.repo, 'rev-parse', 'milestone/MVP/v1^{commit}')).toBe(mvp.integrationSha);
      expect((await runCli(['accept', 'MVP', '--sha', mvp.integrationSha!, '--version', '1', '--url', url])).body).toEqual({ ok: true });
      await new Promise((r) => setTimeout(r, 500));
      expect((await runCli(['status', '--url', url])).body).toMatchObject({ finished: true });
      expect(gitIn(run.repo, 'rev-list', '--count', `${run.baseline}..main`)).toBe('5');
      await run.stop(child);
      expect(readFileSync(run.daemonLog, 'utf8')).toContain('shutting down');
    } finally {
      run.cleanup();
    }
  }, 120_000);

  it('a scripted agent proposes a follow-up; accepting it through the CLI appends the node, which runs after the proposer', async () => {
    const run = await setupCrashRun();
    writeFileSync(path.join(run.dir, 'graph.yaml'), 'nodes:\n  - { id: T1, deps: [], behavior: "proposeThenSubmit:1", description: d, acceptanceCriteria: [a] }\n');
    try {
      const child = run.start();
      await run.waitUntil(() => run.entries().get('T1')?.status.kind === 'done', 60_000);
      const url = run.url();
      const listed = await runCli(['proposals', '--url', url]);
      expect(listed.body).toMatchObject({ proposals: [{ id: 'T1-p1', status: 'pending', payload: { title: 'Follow-up 1 from T1', labels: ['follow-up'] } }] });
      const accepted = await runCli(['accept-proposal', 'T1-p1', '--url', url]);
      expect(accepted.body).toMatchObject({ ok: true, nodeId: 'T1-p1', accepted: true });
      expect(readFileSync(path.join(run.dir, 'graph.yaml'), 'utf8')).toContain('id: T1-p1');
      await run.waitUntil(() => run.entries().get('T1-p1')?.status.kind === 'done', 60_000);
      expect(gitIn(run.repo, 'log', '--format=%(trailers:key=Orchestrator-Task,valueonly)', 'main').split('\n').filter(Boolean).sort()).toEqual(['T1', 'T1-p1']);
      expect((await runCli(['status', '--url', url])).body).toMatchObject({ proposals: [] });
      await run.stop(child);
    } finally {
      run.cleanup();
    }
  }, 120_000);

  it('plain restart adopts a mid-task agent; --reap-on-exit stops it', async () => {
    const run = await setupCrashRun();
    try {
      writeFileSync(path.join(run.dir, 'graph.yaml'), `nodes:\n  - { id: T1, deps: [], behavior: "slowSubmit:4000", description: d, acceptanceCriteria: [a] }\n`);
      const child = run.start();
      const pid = await livePid(run, child, 'T1');
      await run.stop(child);
      expect(pidAlive(pid)).toBe(true);
      const resumed = run.start();
      await run.waitUntil(() => run.entries().get('T1')?.status.kind === 'done', 30_000);
      const store = new SqliteStore(path.join(run.dataDir, 'store.sqlite'));
      expect(store.listLaunches({ taskId: 'T1' })).toHaveLength(1);
      store.close();
      await run.stop(resumed);

      // --reap-on-exit on a hung agent
      writeFileSync(path.join(run.dir, 'graph.yaml'), `nodes:\n  - { id: T1, deps: [], behavior: "slowSubmit:2500", description: d, acceptanceCriteria: [a] }\n  - { id: T9, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }\n`);
      const reaper = run.start({ ORCH_ARGS: '--reap-on-exit' });
      const pid9 = await livePid(run, reaper, 'T9');
      await run.stop(reaper);
      for (let i = 0; i < 40 && pidAlive(pid9); i++) await new Promise((r) => setTimeout(r, 50));
      expect(pidAlive(pid9)).toBe(false);
      const s2 = new SqliteStore(path.join(run.dataDir, 'store.sqlite'));
      const reaped = s2.listEvents({ kind: 'transition', taskId: 'T9' }).some((e) => e.payload?.['to'] === 'failed');
      s2.close();
      expect(reaped).toBe(true);
    } finally {
      run.cleanup();
    }
  }, 120_000);
});
