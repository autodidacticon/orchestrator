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
import { ALLOWED_TOOLS_SLOT } from '../../src/runner/command.js';
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
        // The toy repository has no manifest, so detection derives nothing; the file layer adds the rule the check command needs.
        runner: { claude: { allowedTools: ['Bash(test:*)'] } },
      },
    });
    // The Claude Code runner writes mcp.json per launch and fills {allowedTools} from the effective list at every spawn. See specs/toolchain-discovery "Runner command composition".
    const runner = new ClaudeCodeRunner({
      command: () => h.orch.effective().config.runnerCommand,
      allowedTools: () => h.orch.effective().allowedTools.value,
      logDir: path.join(h.config.dataDir, 'logs'),
      retryWindowMs: 60_000,
    });
    (h.orch as unknown as { runner: unknown }).runner = runner;
    expect(DEFAULT_CLAUDE_COMMAND).toContain(ALLOWED_TOOLS_SLOT);
    expect(h.orch.configReport().config.allowedTools).toMatchObject({ applied: true, parts: { file: ['Bash(test:*)'] } });
    // The test stands in for the session: a needsAccess question gets the answer the run skill would give (an allowed alternative), any other question a decision.
    const questions: Array<{ id: string; kind: string; message: string }> = [];
    const answered = new Set<string>();
    const respond = () => {
      const s = h.orch.status();
      for (const id of s.openQuestions) {
        const e = h.orch.entry(id);
        const q = e.status.kind === 'waiting' ? e.status.question : e.status.kind === 'blocked' ? e.status.reason : undefined;
        if (!q || answered.has(`${id}:${q.message}`)) continue;
        answered.add(`${id}:${q.message}`);
        questions.push({ id, kind: q.kind, message: q.message });
        const text =
          q.kind === 'needsAccess'
            ? 'That command is not allowed for this launch. Use an allowed alternative: git sets the executable bit with `git update-index --chmod=+x <file>` (then commit), and `test` checks files. If nothing allowed can verify a step, skip that verification, state it in your report, and submit.'
            : 'Decide yourself, keep it minimal, and proceed.';
        if (e.status.kind === 'waiting') h.orch.answer(id, text);
        else h.orch.unblock(id, { answer: text });
      }
      return s.finished || s.stalled;
    };
    try {
      await h.waitFor(respond, 20 * 60_000);
      const s = h.orch.status();
      const log = h.store.listLaunches().at(-1);
      const tail = log ? (await import('node:fs/promises')).readFile(path.join(h.config.dataDir, 'logs', `${log.launchId}.log`), 'utf8').then((t) => t.slice(-3000)).catch(() => '') : Promise.resolve('');
      expect(s.stalled, JSON.stringify({ questions, status: s, lastLog: await tail })).toBe(false);
      expect(s.byStatus.done.sort()).toEqual(['T1', 'T2', 'T3']);
      const commits = gitIn(repo, 'rev-list', '--first-parent', 'main').split('\n').filter(Boolean);
      expect(commits).toHaveLength(4);
      const tasks = await Promise.all(commits.slice(0, 3).map((c) => commitTrailers(repo, c).then((t) => t['Orchestrator-Task'])));
      expect(tasks.sort()).toEqual(['T1', 'T2', 'T3']);
      expect(gitIn(repo, 'show', 'main:hello.txt').trim()).toBe('hello');
      // The composed allow list covered the check command: no agent asked for access to run it.
      expect(questions.filter((q) => q.kind === 'needsAccess' && /test -f/.test(q.message)), JSON.stringify(questions)).toEqual([]);
      console.log('e2e questions asked by agents:', JSON.stringify(questions));
    } finally {
      await h.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 25 * 60_000);
});
