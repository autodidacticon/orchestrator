/**
 * Mixed mode end to end: one scripted worker claims what it can while the daemon
 * spawns whatever nobody claims within the window.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../../src/state/sqlite.js';
import { setupCrashRun } from '../crash/harness.js';
import { gitIn } from '../slice/harness.js';

const graph = `nodes:
  - { id: T1, title: One,   description: d, acceptanceCriteria: [a], deps: [],   behavior: commitAndSubmit }
  - { id: T2, title: Two,   description: d, acceptanceCriteria: [a], deps: [T1], behavior: commitAndSubmit }
  - { id: T3, title: Three, description: d, acceptanceCriteria: [a], deps: [],   behavior: commitAndSubmit }
`;

describe('e2e: mixed mode with a scripted worker', () => {
  it('the worker takes what it can and the daemon spawns the rest; one trailer commit per task', async () => {
    const run = await setupCrashRun({ graph, runner: { mode: 'mixed', claimWindowMs: 1500 }, workers: 1, workerEnv: { ORCH_WORKER_SLEEP_MS: '3000' } });
    try {
      const child = run.start();
      await run.waitUntil(() => {
        const e = run.entries();
        return ['T1', 'T2', 'T3'].every((t) => e.get(t)?.status.kind === 'done');
      }, 90_000);
      await run.stop(child);
      const trailers = gitIn(run.repo, 'log', '--first-parent', '--format=%(trailers:key=Orchestrator-Task,valueonly)', 'main').split('\n').filter(Boolean).sort();
      expect(trailers).toEqual(['T1', 'T2', 'T3']);
      const store = new SqliteStore(path.join(run.dataDir, 'store.sqlite'));
      try {
        const launches = store.listLaunches();
        expect(launches.some((l) => l.worker)).toBe(true);
        expect(launches.some((l) => l.pid !== undefined && !l.worker)).toBe(true);
        expect(launches.filter((l) => l.status === 'claimable')).toEqual([]);
      } finally {
        store.close();
      }
      expect(readFileSync(path.join(run.dir, 'worker-events.log'), 'utf8')).toMatch(/report T\d 200/);
    } finally {
      run.cleanup();
    }
  }, 150_000);
});
