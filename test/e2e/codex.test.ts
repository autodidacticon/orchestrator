/**
 * Opt-in end to end with real Codex agents: ORCH_E2E_CODEX=1 npm test -- test/e2e/codex
 * Costs tokens and needs a logged-in `codex` (codex-cli 0.163.0 when written). Three tasks in a toy
 * repo plus a fourth whose `block` is answered only after 90 s, so the MCP tool timeout sizing is
 * exercised. Runs under the runner's defaults: workspace-write, the daemon commit policy, and
 * --ignore-user-config (the user's notify hook and MCP servers do not fire).
 * See specs/worker-runners "Codex runner command composition", "Codex usage parsing", "Sandbox and commit policy".
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitTrailers } from '../../src/workspace/git.js';
import { DEFAULT_CODEX_COMMAND } from '../../src/runner/codex.js';
import type { Launch } from '../../src/state/store.js';
import { makeSlice, gitIn, makeRepo } from '../slice/harness.js';

const enabled = process.env['ORCH_E2E_CODEX'] === '1';

const ANSWER = 'pineapple';
const ANSWER_DELAY_MS = 90_000;

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
    title: Add a README section
    description: Append a section "## Usage" to README.md explaining to run ./shout.sh.
    acceptanceCriteria: ["README.md contains a Usage section mentioning shout.sh"]
    deps: [T2]
  - id: Q1
    title: Ask which word to write
    description: Before writing anything, call the orchestrator block tool once with kind needsDecision and the message "Which word should answer.txt contain?". The answer can take several minutes to arrive; wait for it and do not call block again unless the call itself fails. Then create answer.txt at the repository root containing exactly the single line with the word you were given.
    acceptanceCriteria: ["answer.txt exists at the repo root", "its content is the word given in the answer to the block question"]
    deps: [T1]
`;

interface Item {
  id?: string;
  type?: string;
  server?: string;
  tool?: string;
  status?: string;
  result?: unknown;
  error?: unknown;
}

/** The JSONL lines of a launch log (stdout and stderr share it; non-JSON lines are skipped). */
function events(text: string): Array<{ type?: string; item?: Item }> {
  const out: Array<{ type?: string; item?: Item }> = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      out.push(JSON.parse(t) as { type?: string; item?: Item });
    } catch {
      // a partial or non-event line
    }
  }
  return out;
}

function codexOnPath(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return false;
  }
}

describe.skipIf(!enabled)('e2e with Codex', () => {
  it('three dependent tasks and a long-blocking question are published by codex workers with tokens recorded', async () => {
    if (!codexOnPath()) {
      console.warn('codex CLI not installed; codex e2e skipped');
      return;
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-codex-'));
    const repo = makeRepo(dir);
    const h = await makeSlice({
      graph,
      dir,
      repo,
      realVerifier: true,
      kind: 'codex',
      config: {
        capacity: 2,
        leaseTtlMs: 10 * 60_000,
        // Above the 90 s answer delay, so one long poll carries the answer; the tool timeout is sized a minute above this.
        maxWaitMs: 5 * 60_000,
        checkCommand: 'test -f hello.txt',
        // The real template in place of the harness's fake; sandbox, commit policy and ignoreUserConfig stay at their defaults.
        runner: { codex: { command: DEFAULT_CODEX_COMMAND } },
      },
    });
    const logOf = (l: Launch) => {
      try {
        return readFileSync(path.join(h.config.dataDir, 'logs', `${l.launchId}.log`), 'utf8');
      } catch {
        return '';
      }
    };
    // A dirty or untracked worktree rejects a submit with 409 and the file list, and no event records it, so the handler is observed.
    const rejections: Array<{ taskId: string; body: unknown }> = [];
    const orch = h.orch as unknown as { handleReport: (l: Launch, b: Record<string, unknown>) => Promise<{ status: number; body: unknown }> };
    const handleReport = orch.handleReport.bind(h.orch);
    orch.handleReport = async (l, b) => {
      const res = await handleReport(l, b);
      if (res.status === 409) rejections.push({ taskId: l.taskId, body: res.body });
      return res;
    };

    // The test stands in for the session: Q1's question is answered once it has waited ANSWER_DELAY_MS, any other question at once.
    const questions: Array<{ id: string; kind: string; message: string; waitedMs?: number }> = [];
    const answered = new Set<string>();
    const respond = () => {
      const s = h.orch.status();
      for (const id of s.openQuestions) {
        const e = h.orch.entry(id);
        const q = e.status.kind === 'waiting' ? e.status.question : e.status.kind === 'blocked' ? e.status.reason : undefined;
        if (!q || answered.has(`${id}:${q.message}`)) continue;
        let text: string;
        let waitedMs: number | undefined;
        if (id === 'Q1' && e.status.kind === 'waiting') {
          waitedMs = Date.now() - e.status.askedAt;
          if (waitedMs < ANSWER_DELAY_MS) continue;
          text = ANSWER;
        } else {
          text = q.kind === 'needsAccess' ? 'That command is not available in this sandbox. Skip it, state that in your report, and submit.' : 'Decide yourself, keep it minimal, and proceed.';
        }
        answered.add(`${id}:${q.message}`);
        questions.push({ id, kind: q.kind, message: q.message, ...(waitedMs !== undefined ? { waitedMs } : {}) });
        if (e.status.kind === 'waiting') h.orch.answer(id, text);
        else h.orch.unblock(id, { answer: text });
      }
      return s.finished || s.stalled;
    };
    let passed = false;
    try {
      await h.waitFor(respond, 30 * 60_000);
      // Usage is read once a process has exited, which can be a tick after its task published.
      await h.waitFor(() => h.store.listLaunches().every((l) => h.store.listEvents({ kind: 'launch.usage', launchId: l.launchId }).length > 0), 120_000).catch(() => undefined);
      const s = h.orch.status();
      const launches = h.store.listLaunches();
      const types = new Set<string>();
      for (const l of launches) for (const e of events(logOf(l))) if (e.item?.type) types.add(e.item.type);
      console.log('e2e codex item types:', JSON.stringify([...types].sort()));
      const lastLog = launches.at(-1) ? logOf(launches.at(-1)!).slice(-3000) : '';
      expect(s.stalled, JSON.stringify({ questions, rejections, status: s, lastLog })).toBe(false);
      expect(s.byStatus.done.sort()).toEqual(['Q1', 'T1', 'T2', 'T3']);

      // One trailer commit per task on the integration branch's first-parent line, over the initial commit.
      const commits = gitIn(repo, 'rev-list', '--first-parent', 'main').split('\n').filter(Boolean);
      expect(commits).toHaveLength(5);
      const tasks = await Promise.all(commits.slice(0, 4).map((c) => commitTrailers(repo, c).then((t) => t['Orchestrator-Task'])));
      expect(tasks.sort()).toEqual(['Q1', 'T1', 'T2', 'T3']);
      expect(gitIn(repo, 'show', 'main:hello.txt').trim()).toBe('hello');
      expect(gitIn(repo, 'show', 'main:answer.txt').trim()).toBe(ANSWER);

      // Every launch ran Codex, its tokens were parsed from the JSONL log, and usage was recorded once.
      expect(launches.length).toBeGreaterThanOrEqual(4);
      for (const l of launches) {
        const row = h.store.getLaunch(l.launchId)!;
        expect(row.runner).toBe('codex');
        expect(row.commitPolicy).toBe('daemon');
        expect(row.tokens?.input, l.launchId).toBeGreaterThan(0);
        expect(row.tokens?.output, l.launchId).toBeGreaterThan(0);
        expect(row.usageSource).toBe('codex');
        expect(h.store.listEvents({ kind: 'launch.usage', launchId: l.launchId }), l.launchId).toHaveLength(1);
      }
      // Without budgets.prices the cost is unknown: nothing enters runUsd and every launch counts as unpriced.
      // ORC-43 prices at record time, not at read time, so the priced assertion stays in the fake-codex slice.
      expect(s.cost.runUsd).toBe(0);
      expect(s.cost.unpricedLaunches).toBe(launches.length);

      // The daemon commit policy: no agent asked to run git add/commit, and no submit was rejected for a dirty worktree.
      expect(questions.filter((q) => q.kind === 'needsAccess' && /git (add|commit)/.test(q.message)), JSON.stringify(questions)).toEqual([]);
      expect(rejections.filter((r) => (r.body as { files?: unknown }).files !== undefined), JSON.stringify(rejections)).toEqual([]);
      // Every report went through the MCP server: none fell back to the report file because the sandbox refused the API.
      const fallbacks = launches.flatMap((l) => h.store.listEvents({ kind: 'agent.fallback', launchId: l.launchId }));
      expect(fallbacks.map((f) => [f.taskId, f.payload]), 'fallback reports').toEqual([]);
      const reports = launches.flatMap((l) => h.store.listEvents({ kind: 'agent.report', launchId: l.launchId }));
      const submits = reports.filter((r) => (r.payload as { kind?: string }).kind === 'submit');
      expect(submits.length).toBeGreaterThanOrEqual(4);
      expect(submits.every((r) => (r.payload as { committedByOrchestrator?: boolean }).committedByOrchestrator === true), JSON.stringify(submits.map((r) => r.payload))).toBe(true);
      // Nothing Codex writes lands in the task commits: each commit touches only files the tasks asked for.
      const touched = commits.slice(0, 4).flatMap((c) => gitIn(repo, 'show', '--name-only', '--format=', c).split('\n').filter(Boolean));
      expect(touched.filter((f) => /(^|\/)\.?codex|\.orchestrator\//i.test(f)), JSON.stringify(touched)).toEqual([]);

      // The question task waited past the MCP client's default timeout and got the answer.
      const q1 = questions.find((q) => q.id === 'Q1');
      expect(q1, JSON.stringify(questions)).toBeDefined();
      expect(q1!.kind).toBe('needsDecision');
      expect(q1!.waitedMs).toBeGreaterThanOrEqual(ANSWER_DELAY_MS);

      // The launch logs: every launch ended a turn; Q1 holds exactly one block call, and it completed with the answer.
      let q1Blocks: Item[] = [];
      for (const l of launches) {
        const ev = events(logOf(l));
        expect(ev.some((e) => e.type === 'turn.completed'), l.launchId).toBe(true);
        if (l.taskId === 'Q1') q1Blocks = q1Blocks.concat(ev.filter((e) => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call' && /(^|\\.)block$/.test(e.item.tool ?? '')).map((e) => e.item!));
      }
      const timeoutHonoured = q1Blocks.length === 1 && q1Blocks[0]!.status === 'completed' && JSON.stringify(q1Blocks[0]).includes(ANSWER);
      const sealedByDaemon = submits.length >= 4 && submits.every((r) => (r.payload as { committedByOrchestrator?: boolean }).committedByOrchestrator === true);
      const artifactsAbsent = rejections.length === 0;
      console.log('e2e codex Q1 block items:', JSON.stringify(q1Blocks));
      console.log(`probe: tool timeout honoured: ${timeoutHonoured} (Q1 block items: ${q1Blocks.length}, waited ${q1!.waitedMs} ms, tool_timeout_sec ${Math.ceil(h.config.maxWaitMs / 1000) + 60})`);
      console.log(`probe: daemon seal under workspace-write: ${sealedByDaemon} (${submits.length} submits committed by the orchestrator)`);
      console.log(`probe: codex artifacts absent: ${artifactsAbsent} (409 rejections: ${rejections.length}; files committed: ${JSON.stringify(touched)})`);
      console.log('e2e codex tokens by launch:', JSON.stringify(launches.map((l) => ({ task: l.taskId, model: l.model, tokens: h.store.getLaunch(l.launchId)!.tokens }))));
      console.log('e2e questions asked by agents:', JSON.stringify(questions));
      expect(q1Blocks, JSON.stringify(q1Blocks)).toHaveLength(1);
      expect(q1Blocks[0]!.status).toBe('completed');
      expect(JSON.stringify(q1Blocks[0])).toContain(ANSWER);
      expect(rejections, JSON.stringify(rejections)).toEqual([]);
      passed = true;
    } finally {
      // On failure the launch logs and the event log are kept for diagnosis; the harness removes the run directory.
      if (!passed) {
        const keep = mkdtempSync(path.join(tmpdir(), 'orch-codex-keep-'));
        cpSync(path.join(h.config.dataDir, 'logs'), path.join(keep, 'logs'), { recursive: true });
        writeFileSync(path.join(keep, 'events.json'), JSON.stringify(h.store.listEvents(), null, 2));
        writeFileSync(path.join(keep, 'launches.json'), JSON.stringify(h.store.listLaunches(), null, 2));
        console.warn('codex e2e failed; logs and events kept in', keep);
      }
      await h.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 35 * 60_000);
});
