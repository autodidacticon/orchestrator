/**
 * Opt-in end to end for the Codex work loop with real Codex agents: ORCH_E2E_CODEX_WORK=1 npm test -- test/e2e/codex-work
 * Costs tokens and needs a logged-in `codex` on PATH. A pull-mode codex run: two loops of
 * hosts/codex/bin/work.mjs claim the three launches, run `codex exec` for each, and post usage;
 * the daemon spawns nothing. See specs/host-integration "Codex work loop".
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gitIn, makeRepo, makeSlice, tsxLoader } from '../slice/harness.js';

const enabled = process.env['ORCH_E2E_CODEX_WORK'] === '1';
const workMjs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../hosts/codex/bin/work.mjs');

// Under the daemon commit policy the agent leaves its changes uncommitted, so no description asks for a commit.
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

function codexOnPath(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return false;
  }
}

describe.skipIf(!enabled)('e2e: Codex work loop', () => {
  it('two codex loops drain a three-task pull-mode graph; one trailer commit per task', async () => {
    if (!codexOnPath()) {
      console.warn('codex CLI not installed; codex work-loop e2e skipped');
      return;
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-codex-work-'));
    const repo = makeRepo(dir);
    const h = await makeSlice({
      graph,
      dir,
      repo,
      realVerifier: true,
      config: { capacity: 2, leaseTtlMs: 10 * 60_000, maxWaitMs: 2 * 60_000, checkCommand: 'true', runner: { mode: 'pull', kind: 'codex' } },
    });
    let stderr = '';
    const child = spawn(process.execPath, ['--import', tsxLoader, workMjs, '--url', h.orch.apiBaseUrl, '--workers', '2', '--run-tag', 'e2e', '--capacity', '2'], { stdio: ['ignore', 'pipe', 'pipe'] });
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

      // Every launch was claimed by a loop, none was spawned by the daemon, and the loop posted its usage.
      const timer = setInterval(() => void h.orch.tick(), 200);
      expect(await exited.finally(() => clearInterval(timer)), stderr.slice(-4000)).toBe(0);
      for (const l of h.store.listLaunches().filter((x) => x.worker)) {
        expect(l.runner).toBe('codex');
        expect(l.pid).toBeUndefined();
        expect(l.worker?.id).toMatch(/^e2e-[12]$/);
        expect(l.usageSource, l.launchId).toBe('worker');
        expect(l.tokens?.output, l.launchId).toBeGreaterThan(0);
      }
      expect(h.store.listLaunches().every((l) => l.pid === undefined)).toBe(true);
    } finally {
      child.kill('SIGTERM');
      await h.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30 * 60_000);
});
