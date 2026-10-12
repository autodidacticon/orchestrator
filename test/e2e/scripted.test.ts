/**
 * End to end through the real daemon (main.ts), operator CLI, and scripted agents.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/operator/cli.js';
import { pidAlive } from '../../src/runner/subprocess.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import { setupCrashRun } from '../crash/harness.js';
import { gitIn } from '../slice/harness.js';

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

  it('plain restart adopts a mid-task agent; --reap-on-exit stops it', async () => {
    const run = await setupCrashRun();
    try {
      writeFileSync(path.join(run.dir, 'graph.yaml'), `nodes:\n  - { id: T1, deps: [], behavior: "slowSubmit:2500", description: d, acceptanceCriteria: [a] }\n`);
      const child = run.start();
      const deadline = Date.now() + 15_000;
      let pid: number | undefined;
      while (Date.now() < deadline && !pid) {
        await new Promise((r) => setTimeout(r, 150));
        try {
          const store = new SqliteStore(path.join(run.dataDir, 'store.sqlite'));
          pid = store.listLaunches({ status: 'live' })[0]?.pid;
          store.close();
        } catch {
          /* store not ready */
        }
      }
      expect(pid).toBeDefined();
      await run.stop(child);
      expect(pidAlive(pid!)).toBe(true);
      const resumed = run.start();
      const until = Date.now() + 30_000;
      while (Date.now() < until && run.entries().get('T1')?.status.kind !== 'done') await new Promise((r) => setTimeout(r, 200));
      expect(run.entries().get('T1')?.status.kind).toBe('done');
      const store = new SqliteStore(path.join(run.dataDir, 'store.sqlite'));
      expect(store.listLaunches({ taskId: 'T1' })).toHaveLength(1);
      store.close();
      await run.stop(resumed);

      // --reap-on-exit on a hung agent
      writeFileSync(path.join(run.dir, 'graph.yaml'), `nodes:\n  - { id: T1, deps: [], behavior: "slowSubmit:2500", description: d, acceptanceCriteria: [a] }\n  - { id: T9, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }\n`);
      const reaper = run.start({ ORCH_ARGS: '--reap-on-exit' });
      let pid9: number | undefined;
      const d2 = Date.now() + 15_000;
      while (Date.now() < d2 && !pid9) {
        await new Promise((r) => setTimeout(r, 150));
        const s = new SqliteStore(path.join(run.dataDir, 'store.sqlite'));
        pid9 = s.listLaunches({ status: 'live', taskId: 'T9' })[0]?.pid;
        s.close();
      }
      expect(pid9).toBeDefined();
      await run.stop(reaper);
      for (let i = 0; i < 40 && pidAlive(pid9!); i++) await new Promise((r) => setTimeout(r, 50));
      expect(pidAlive(pid9!)).toBe(false);
      const s2 = new SqliteStore(path.join(run.dataDir, 'store.sqlite'));
      const reaped = s2.listEvents({ kind: 'transition', taskId: 'T9' }).some((e) => e.payload?.['to'] === 'failed');
      s2.close();
      expect(reaped).toBe(true);
    } finally {
      run.cleanup();
    }
  }, 120_000);
});
