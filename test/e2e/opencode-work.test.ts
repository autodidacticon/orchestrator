/**
 * Opt-in end to end for the work loop with real OpenCode agents: ORCH_E2E_OPENCODE_WORK=1 npx vitest run test/e2e/opencode-work.test.ts
 * Needs `opencode` on PATH; the default model is the free opencode/big-pickle (ORCH_E2E_OPENCODE_MODEL
 * overrides it). A pull-mode opencode run: two loops of `hosts/codex/bin/work.mjs --runner opencode`
 * claim the three launches, run `opencode run` for each with the per-launch config, and post usage;
 * the daemon spawns nothing. Both agents share the user's data directory, so a `startupContended`
 * start may be released and claimed again. See specs/host-integration "Work loop by runner kind".
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gitIn, makeRepo, makeSlice, tsxLoader } from '../slice/harness.js';

const enabled = process.env['ORCH_E2E_OPENCODE_WORK'] === '1';
const MODEL = process.env['ORCH_E2E_OPENCODE_MODEL'] ?? 'opencode/big-pickle';
const workMjs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../hosts/codex/bin/work.mjs');

// Under the agent commit policy (the opencode default) the brief tells the agent to commit.
const graph = `nodes:
  - id: T1
    title: Create greeting file
    description: Create a file named hello.txt at the repository root containing exactly the single line "hello".
    acceptanceCriteria: ["hello.txt exists at the repo root", "its content is the line hello"]
    deps: []
  - id: T2
    title: Create shout script
    description: Create shout.sh at the repository root. It must print the contents of hello.txt in upper case (use tr). Make it executable.
    acceptanceCriteria: ["shout.sh exists and is executable", "running ./shout.sh prints HELLO"]
    deps: [T1]
  - id: T3
    title: Create a notes file
    description: Create notes.txt at the repository root containing exactly the single line "notes".
    acceptanceCriteria: ["notes.txt exists at the repo root"]
    deps: []
`;

function opencodeOnPath(): boolean {
  try {
    execFileSync('opencode', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return false;
  }
}

describe.skipIf(!enabled)('e2e: OpenCode work loop', () => {
  it('two opencode loops drain a three-task pull-mode graph; one trailer commit per task', async () => {
    if (!opencodeOnPath()) {
      console.warn('opencode CLI not installed; opencode work-loop e2e skipped');
      return;
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-opencode-work-'));
    const repo = makeRepo(dir);
    const h = await makeSlice({
      graph,
      dir,
      repo,
      realVerifier: true,
      // ignoreUserConfig keeps the user's plugins and config out of the run; the shared data dir keeps auth available.
      // permission allow: under derived, opencode 1.18.30 rejects its `write` tool and chained `git add && git commit` commands,
      // which the derived ruleset does not cover (a runner follow-up). ORCH_E2E_OPENCODE_PERMISSION=derived exercises it.
      config: {
        capacity: 2,
        leaseTtlMs: 10 * 60_000,
        maxWaitMs: 2 * 60_000,
        checkCommand: 'true',
        runner: { mode: 'pull', kind: 'opencode', opencode: { model: MODEL, ignoreUserConfig: true, permission: process.env['ORCH_E2E_OPENCODE_PERMISSION'] === 'derived' ? 'derived' : 'allow' } },
      },
    });
    let stderr = '';
    const child = spawn(process.execPath, ['--import', tsxLoader, workMjs, '--runner', 'opencode', '--url', h.orch.apiBaseUrl, '--workers', '2', '--run-tag', 'e2e', '--capacity', '2', '--max-failures', '5'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((r) => child.on('close', r));
    try {
      await h.waitFor(() => {
        const s = h.orch.status();
        return s.finished || s.stalled;
      }, 20 * 60_000);
      const s = h.orch.status();
      expect(s.stalled, JSON.stringify({ status: s, stderr: stderr.slice(-4000) })).toBe(false);
      expect(s.byStatus.done.sort()).toEqual(['T1', 'T2', 'T3']);

      const trailers = gitIn(repo, 'log', '--first-parent', '--format=%(trailers:key=Orchestrator-Task,valueonly)', 'main').split('\n').filter(Boolean).sort();
      expect(trailers).toEqual(['T1', 'T2', 'T3']);
      expect(gitIn(repo, 'show', 'main:hello.txt').trim()).toBe('hello');

      // Every launch was claimed by a loop, none was spawned by the daemon, and the loop posted the usage of every launch that ran a turn.
      const timer = setInterval(() => void h.orch.tick(), 200);
      expect(await exited.finally(() => clearInterval(timer)), stderr.slice(-4000)).toBe(0);
      const claimed = h.store.listLaunches().filter((x) => x.worker);
      for (const l of claimed) {
        expect(l.runner).toBe('opencode');
        expect(l.pid).toBeUndefined();
        expect(l.worker?.id).toMatch(/^e2e-[12]$/);
      }
      for (const t of ['T1', 'T2', 'T3']) {
        const done = claimed.filter((l) => l.taskId === t && l.tokens);
        expect(done.length, t).toBeGreaterThan(0);
        for (const l of done) {
          expect(l.usageSource, l.launchId).toBe('worker');
          expect(l.tokens?.output, l.launchId).toBeGreaterThan(0);
        }
      }
      expect(h.store.listLaunches().every((l) => l.pid === undefined)).toBe(true);
      console.info(`opencode work e2e: ${claimed.length} launches; contended releases: ${(stderr.match(/startupContended/g) ?? []).length}`);
    } finally {
      child.kill('SIGTERM');
      await h.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30 * 60_000);
});
