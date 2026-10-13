/**
 * Opt-in: a real Claude Code session drives a run through the plugin.
 *   ORCH_E2E_CLAUDE_PLUGIN=1 npx vitest run test/e2e/plugin.test.ts
 * Agents are scripted (free); only the operating session is a real model.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { health, listRuns, stopDaemon } from '../../src/runs/lifecycle.js';
import { runPaths } from '../../src/runs/runDir.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import { gitIn, makeRepo } from '../slice/harness.js';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const enabled = process.env['ORCH_E2E_CLAUDE_PLUGIN'] === '1';

describe('plugin skills', () => {
  it('the run skill drains the outbox with a marker check and relays comment answers; the import skill records the tracker', () => {
    const run = readFileSync(path.join(root, 'hosts/claude-code/skills/run/SKILL.md'), 'utf8');
    for (const needle of ['`outbox`', '`ack { id, result: { commentId } }`', '`ack { id, error: "<message>" }`', 'marker', 'state TYPE', 'answersFromComments', '`answer`', '409']) {
      expect(run, needle).toContain(needle);
    }
    const imp = readFileSync(path.join(root, 'hosts/claude-code/skills/import/SKILL.md'), 'utf8');
    expect(imp).toContain('{ root, issues, tracker, options? }');
    expect(imp).toContain('kind: "linear"');
    expect(imp).toContain('kind: "atlassian"');
  });
});

describe.skipIf(!enabled)('e2e: Claude Code session operates a run through the plugin', () => {
  // The default experience: nothing on PATH, the plugin's launcher runs the checkout, the run skill works the
  // launches with the session's own subagents (pull mode), relays the question, and reviews the milestone.
  it('runs the graph to completion with session subagents and reviews the milestone', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-plugin-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-plugin-repo-'));
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), ['checkCommand: "true"', 'tickIntervalMs: 200', 'leaseTtlMs: 600000', 'capacity: 2'].join('\n'));
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ORCH_HOME: home };
    delete env['CLAUDECODE'];
    delete env['CLAUDE_CODE_ENTRYPOINT'];
    // Pre-import a graph with a question so the session has to relay it, then review the milestone.
    const paths = runPaths(repo, env);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.graphPath, [
      'nodes:',
      '  - { id: T1, title: Pick a database, deps: [], description: "Before writing anything, ask the operator with launch_block (kind needsDecision) which database to use, sqlite or postgres, and wait for the answer. Then create T1.txt at the repository root containing the one-word answer, and commit it.", acceptanceCriteria: ["T1.txt contains the operator answer"] }',
      '  - { id: T2, title: Write the changelog, deps: [T1], description: "Create T2.txt at the repository root containing the line changelog: initial, and commit it.", acceptanceCriteria: ["T2.txt exists"] }',
      '  - { id: MVP, kind: milestone, gated: true, deps: [T2], acceptanceCriteria: ["both files are committed on main"] }',
      '',
    ].join('\n'));
    try {
      const prompt = [
        'You are operating an orchestrated run in this repository using the orchestrator plugin.',
        'Use the run skill: start the daemon and follow the skill, including working the run with the bundled workflow since the mode is pull. When a worker asks which database to use, answer "sqlite".',
        'When the MVP milestone awaits review, use the review skill: fetch the bundle and accept it if T1.txt and T2.txt are on main.',
        'Stop looping once the run is finished, then stop the daemon (without reaping). Reply with one line: FINISHED or NOT FINISHED and why.',
      ].join(' ');
      const { stdout } = await execFileP(
        'claude',
        ['-p', prompt, '--plugin-dir', path.join(root, 'hosts/claude-code'), '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__plugin_orchestrator_operator__*', 'Bash(git:*)', 'Workflow', 'Agent', '--no-session-persistence'],
        { cwd: repo, env, maxBuffer: 16 * 1024 * 1024, timeout: 20 * 60_000 },
      );
      const result = JSON.parse(stdout) as { result?: string; is_error?: boolean };
      expect(result.is_error, stdout.slice(0, 2000)).toBeFalsy();
      const store = new SqliteStore(path.join(paths.runDir, 'store.sqlite'));
      try {
        const entries = store.allEntries();
        const picture = JSON.stringify({ reply: result.result, statuses: Object.fromEntries([...entries].map(([k, v]) => [k, v.status.kind])), launches: store.listLaunches().map((l) => ({ task: l.taskId, status: l.status, worker: l.worker?.id, pid: l.pid })) });
        expect(String(result.result), picture).toMatch(/FINISHED/i);
        expect(entries.get('T1')?.status.kind, picture).toBe('done');
        expect(entries.get('T2')?.status.kind, picture).toBe('done');
        expect(entries.get('MVP')?.status.kind, picture).toBe('done');
        // Every launch was held by a session worker, never spawned by the daemon.
        for (const l of store.listLaunches()) {
          expect(l.worker, picture).toBeDefined();
          expect(l.pid, picture).toBeUndefined();
        }
        const kinds = store.listEvents().map((e) => e.kind);
        expect(kinds, picture).toContain('agent.block');
        expect(kinds, picture).toContain('operator.answer');
        expect(kinds, picture).toContain('operator.accept');
      } finally {
        store.close();
      }
      expect(gitIn(repo, 'show', 'main:T1.txt').trim()).toMatch(/sqlite/i);
      expect(await health((await listRuns(env)).find((r) => r.repo === repo)?.url ?? 'http://127.0.0.1:1')).toBeUndefined();
    } finally {
      await stopDaemon({ repo, env, reap: true }).catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  }, 20 * 60_000);
});
