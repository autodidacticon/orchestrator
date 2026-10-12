/**
 * Opt-in end to end with real Claude Code agents: ORCH_E2E_CLAUDE=1 npm test -- test/e2e/claude
 * Costs tokens and needs a logged-in `claude`. Three tasks in a toy repo.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitTrailers } from '../../src/workspace/git.js';
import { DEFAULT_CLAUDE_COMMAND, ClaudeCodeRunner } from '../../src/runner/claude-code.js';
import { makeSlice, gitIn, makeRepo } from '../slice/harness.js';

const enabled = process.env['ORCH_E2E_CLAUDE'] === '1';

const graph = `nodes:
  - id: T1
    title: Create greeting file
    description: Create a file named hello.txt at the repository root containing exactly the single line "hello". Commit it.
    acceptanceCriteria: ["hello.txt exists at the repo root", "its content is the line hello"]
    deps: []
  - id: T2
    title: Create shout script
    description: Create shout.sh at the repository root. It must print the contents of hello.txt in upper case (use tr). Make it executable and commit it.
    acceptanceCriteria: ["shout.sh exists and is executable", "running ./shout.sh prints HELLO"]
    deps: [T1]
  - id: T3
    title: Add a README section
    description: Append a section "## Usage" to README.md explaining to run ./shout.sh. Commit it.
    acceptanceCriteria: ["README.md contains a Usage section mentioning shout.sh"]
    deps: [T2]
`;

describe.skipIf(!enabled)('e2e with Claude Code', () => {
  it('three dependent tasks land as three trailer commits', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-claude-'));
    const repo = makeRepo(dir);
    mkdirSync(path.join(dir, 'run'), { recursive: true });
    const h = await makeSlice({
      graph,
      dir,
      repo,
      realVerifier: true,
      config: {
        capacity: 1,
        leaseTtlMs: 10 * 60_000,
        checkCommand: 'test -f hello.txt',
        runnerCommand: DEFAULT_CLAUDE_COMMAND,
      },
    });
    // Use the Claude Code runner so mcp.json is written for every launch.
    const runner = new ClaudeCodeRunner({ command: DEFAULT_CLAUDE_COMMAND, logDir: path.join(h.config.dataDir, 'logs'), retryWindowMs: 60_000 });
    (h.orch as unknown as { runner: unknown }).runner = runner;
    try {
      await h.waitFor(() => h.orch.status().finished || h.orch.status().stalled, 20 * 60_000);
      const s = h.orch.status();
      expect(s.stalled, JSON.stringify(s)).toBe(false);
      expect(s.byStatus.done.sort()).toEqual(['T1', 'T2', 'T3']);
      const commits = gitIn(repo, 'rev-list', '--first-parent', 'main').split('\n').filter(Boolean);
      expect(commits).toHaveLength(4);
      const tasks = await Promise.all(commits.slice(0, 3).map((c) => commitTrailers(repo, c).then((t) => t['Orchestrator-Task'])));
      expect(tasks.sort()).toEqual(['T1', 'T2', 'T3']);
      expect(gitIn(repo, 'show', 'main:hello.txt').trim()).toBe('hello');
    } finally {
      await h.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 25 * 60_000);
});
