/**
 * Opt-in: a real Claude Code session executes a run in pull mode through the work skill.
 *   ORCH_E2E_CLAUDE_WORK=1 npx vitest run test/e2e/work.test.ts
 * Needs a logged-in `claude` and the Workflow tool available to headless sessions.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { listRuns, stopDaemon } from '../../src/runs/lifecycle.js';
import { runPaths } from '../../src/runs/runDir.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import { gitIn, makeRepo } from '../slice/harness.js';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const enabled = process.env['ORCH_E2E_CLAUDE_WORK'] === '1';

describe.skipIf(!enabled)('e2e: a Claude Code session works a run in pull mode', () => {
  it('two workers drain a three-task graph and every task lands as a trailer commit', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-work-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-work-repo-'));
    // Nothing on PATH: the plugin's launcher runs the checkout.
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), ['checkCommand: "true"', 'tickIntervalMs: 200', 'leaseTtlMs: 600000', 'capacity: 2'].join('\n'));
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ORCH_HOME: home };
    delete env['CLAUDECODE'];
    delete env['CLAUDE_CODE_ENTRYPOINT'];
    const paths = runPaths(repo, env);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.graphPath, [
      'nodes:',
      '  - { id: T1, title: Greeting file, deps: [], description: "Create hello.txt at the repository root containing the single line hello, and commit it.", acceptanceCriteria: ["hello.txt exists with the line hello"] }',
      '  - { id: T2, title: Shout script, deps: [T1], description: "Create an executable shout.sh at the repository root that prints hello.txt in upper case, and commit it.", acceptanceCriteria: ["./shout.sh prints HELLO"] }',
      '  - { id: T3, title: Notes file, deps: [], description: "Create NOTES.md at the repository root with one line describing the repository, and commit it.", acceptanceCriteria: ["NOTES.md exists"] }',
      '',
    ].join('\n'));
    try {
      const prompt = [
        'You are executing an orchestrated run in this repository with the orchestrator plugin.',
        'Use the work skill: start the daemon in pull mode, then run the bundled workflow with 2 workers and run tag "e2e".',
        'The workflow runs in the background: do not wait for its completion notice. Keep calling the wait tool (until "any") and act on the digest, answering any question sensibly, until the digest reports finished.',
        'Then stop the daemon without reaping. Reply with one line: FINISHED or NOT FINISHED and why.',
      ].join(' ');
      const { stdout } = await execFileP(
        'claude',
        ['-p', prompt, '--plugin-dir', path.join(root, 'hosts/claude-code'), '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__plugin_orchestrator_operator__*', 'Bash(git:*)', 'Workflow', 'Agent', '--no-session-persistence'],
        { cwd: repo, env, maxBuffer: 16 * 1024 * 1024, timeout: 25 * 60_000 },
      );
      const result = JSON.parse(stdout) as { result?: string; is_error?: boolean };
      expect(result.is_error, stdout.slice(0, 2000)).toBeFalsy();
      const store = new SqliteStore(path.join(paths.runDir, 'store.sqlite'));
      try {
        const entries = store.allEntries();
        const picture = JSON.stringify({ reply: result.result, statuses: Object.fromEntries([...entries].map(([k, v]) => [k, v.status.kind])), launches: store.listLaunches().map((l) => ({ task: l.taskId, status: l.status, worker: l.worker?.id, pid: l.pid })) });
        expect(String(result.result), picture).toMatch(/FINISHED/i);
        for (const t of ['T1', 'T2', 'T3']) expect(entries.get(t)?.status.kind, picture).toBe('done');
        expect(store.listLaunches().every((l) => l.worker || l.status === 'ended')).toBe(true);
      } finally {
        store.close();
      }
      const trailers = gitIn(repo, 'log', '--first-parent', '--format=%(trailers:key=Orchestrator-Task,valueonly)', 'main').split('\n').filter(Boolean).sort();
      expect(trailers).toEqual(['T1', 'T2', 'T3']);
    } finally {
      for (const r of await listRuns(env)) if (r.alive && r.repo) await stopDaemon({ repo: r.repo, env, reap: true }).catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  }, 30 * 60_000);
});
