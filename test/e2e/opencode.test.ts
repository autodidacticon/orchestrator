/**
 * Opt-in end to end with real OpenCode agents: ORCH_E2E_OPENCODE=1 npm test -- test/e2e/opencode
 * Runs on the free model `opencode/big-pickle` (opencode 1.18.30 when written): no login, no key, cost 0
 * per step. Launches share the user's OpenCode database at capacity 2, so a `startupContended` death
 * may happen and must be relaunched uncharged. Case 1: three tasks, one of whose `block` is answered
 * only after 75 s (the MCP call timeout is 60 s unless the per-server timeout is sized). Case 2: a task
 * needing a command outside the derived permission patterns; the derived catch-alls are `deny`, so the
 * agent sees the refusal, asks for the command with needsAccess, and finishes with the answer.
 * ORCH_E2E_OPENCODE_RECORD=1 copies each task's first launch's JSONL, redacted, to
 * test/fixtures/opencode/e2e-<task>.jsonl (e2e-access-<task>.jsonl for case 2); nothing is recorded otherwise.
 * See specs/worker-runners "OpenCode runner command composition", specs/health-monitoring "Usage accounting",
 * specs/task-lifecycle "Health failure reasons".
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commitTrailers } from '../../src/workspace/git.js';
import { DEFAULT_OPENCODE_COMMAND, OpenCodeRunner } from '../../src/runner/opencode.js';
import type { Launch } from '../../src/state/store.js';
import { composeAllowedTools } from '../../src/toolchain/tools.js';
import { makeSlice, gitIn, makeRepo, type SliceHarness } from '../slice/harness.js';

const enabled = process.env['ORCH_E2E_OPENCODE'] === '1';
const record = process.env['ORCH_E2E_OPENCODE_RECORD'] === '1';
const MODEL = 'opencode/big-pickle';
const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/opencode');

const ANSWER = 'pineapple';
const ANSWER_DELAY_MS = 75_000;

// Under the agent commit policy every description asks for the commit. Under `derived` the file tools (write included), git, node and
// the check command are allowed, each command of a chain is matched on its own, and any other command is denied: the model gets the
// error and goes on (fixtures/opencode/events/P-deny.jsonl, X-*.jsonl), so a stray ls costs a step, not the launch.
const ONLY = 'Use your file read, write and edit tools, git, and node.';
const graph = `nodes:
  - id: T1
    title: Create greeting file
    description: Create a file named hello.txt at the repository root containing exactly the single line "hello". Use your file write tool, then commit it with git. ${ONLY}
    acceptanceCriteria: ["hello.txt exists at the repo root", "its content is the line hello", "it is committed on the launch branch"]
    deps: []
  - id: T2
    title: Ask which word to write
    description: Before writing anything, call the orchestrator_block tool once with kind needsDecision and the message "Which word should answer.txt contain?". The answer can take several minutes to arrive; wait for it and do not call block again unless the call itself fails. Then create answer.txt at the repository root containing exactly the single line with the word you were given, using your file write tool, and commit it with git. ${ONLY}
    acceptanceCriteria: ["answer.txt exists at the repo root", "its content is the word given in the answer to the block question", "it is committed on the launch branch"]
    deps: []
  - id: T3
    title: Add a README section
    description: Append a section "## Files" to README.md that names hello.txt and answer.txt, using your file edit tool, and commit it with git. ${ONLY}
    acceptanceCriteria: ["README.md contains a Files section naming hello.txt and answer.txt", "it is committed on the launch branch"]
    deps: [T1, T2]
`;

// The command is outside the derived patterns (git *, node *), and the description forbids working around it.
const accessGraph = `nodes:
  - id: P1
    title: Record the platform name
    description: Run exactly the shell command "uname -s" with your bash tool and write its output, one line, to platform.txt at the repository root. Do not guess the output and do not use another command. If the command is rejected, ask for it as the brief says and follow the answer. Commit platform.txt with git.
    acceptanceCriteria: ["platform.txt exists at the repo root and is committed on the launch branch", "its content is the output of uname -s, or what the answer to an access question said to write"]
    deps: []
`;

/** The JSONL event lines of a launch log (stderr shares it under --print-logs; non-JSON lines are skipped). */
function events(text: string): Array<{ type?: string; part?: Record<string, unknown> }> {
  const out: Array<{ type?: string; part?: Record<string, unknown> }> = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      out.push(JSON.parse(t) as { type?: string; part?: Record<string, unknown> });
    } catch {
      // a partial or non-event line
    }
  }
  return out;
}

function opencodeOnPath(): boolean {
  try {
    execFileSync('opencode', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return false;
  }
}

const hasOpencode = enabled && opencodeOnPath();
if (enabled && !hasOpencode) console.warn('opencode CLI not on PATH; opencode e2e skipped (install `opencode` 1.18.30 or later)');

/** A toy repo with a node manifest and one test, so the check `node --test` passes; the file rule `Bash(node:*)` gives the pattern `node *`. */
function makeNodeRepo(dir: string): string {
  const repo = makeRepo(dir);
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'toy', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n');
  mkdirSync(path.join(repo, 'test'));
  writeFileSync(path.join(repo, 'test', 'smoke.test.mjs'), "import test from 'node:test';\ntest('smoke', () => {});\n");
  gitIn(repo, 'add', '.');
  gitIn(repo, 'commit', '-q', '-m', 'node manifest');
  return repo;
}

interface Run {
  h: SliceHarness;
  dir: string;
  repo: string;
  logOf: (l: Launch) => string;
  rejections: Array<{ taskId: string; body: unknown }>;
  questions: Array<{ id: string; kind: string; message: string; waitedMs?: number }>;
}

async function startRun(name: string, g: string): Promise<Run> {
  // The real path: opencode runs in the realpath of its cwd (/private/var/... on macOS), and a file path under the /var/... alias is an
  // `external_directory` ask, which a headless run auto-rejects and then ends on.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `orch-opencode-${name}-`)));
  const repo = makeNodeRepo(dir);
  const h = await makeSlice({
    graph: g,
    dir,
    repo,
    realVerifier: true,
    config: {
      capacity: 2,
      maxAttempts: 3,
      leaseTtlMs: 10 * 60_000,
      // Above the answer delay, so one long poll carries the answer; the per-server MCP timeout is a minute above this.
      maxWaitMs: 5 * 60_000,
      checkCommand: 'node --test',
      // The file layer gives the rule the check command needs; the derived ruleset turns it into the bash pattern `node *`.
      runner: { kind: 'opencode', opencode: { model: MODEL, permission: 'derived' }, claude: { allowedTools: ['Bash(node:*)'] } },
    },
  });
  // The OpenCode runner as main.ts builds it, reading its template, settings and derived rules from the effective configuration at every spawn. Its logs stay under the test's temp dir.
  const runner = new OpenCodeRunner({
    command: () => h.orch.effective().config.runner.opencode.command ?? DEFAULT_OPENCODE_COMMAND,
    settings: () => h.orch.effective().config.runner.opencode,
    allowedTools: () => {
      const eff = h.orch.effective();
      if (eff.allowedTools.value.length) return eff.allowedTools.value;
      const claude = eff.config.runner.claude;
      return composeAllowedTools({ record: eff.toolchain, deriveTools: claude.deriveTools, fileRules: claude.allowedTools, argumentRules: eff.overrides.allowedTools ?? [] }).value;
    },
    maxWaitMs: h.config.maxWaitMs,
    logDir: path.join(h.config.dataDir, 'logs'),
    retryWindowMs: h.config.retryWindowMs,
  });
  (h.orch as unknown as { runner: unknown }).runner = runner;
  const logOf = (l: Launch) => {
    try {
      return readFileSync(path.join(h.config.dataDir, 'logs', `${l.launchId}.log`), 'utf8');
    } catch {
      return '';
    }
  };
  // A dirty or untracked worktree rejects a submit with 409 and the file list, and no event records it, so the handler is observed.
  const rejections: Run['rejections'] = [];
  const orch = h.orch as unknown as { handleReport: (l: Launch, b: Record<string, unknown>) => Promise<{ status: number; body: unknown }> };
  const handleReport = orch.handleReport.bind(h.orch);
  orch.handleReport = async (l, b) => {
    const res = await handleReport(l, b);
    if (res.status === 409) rejections.push({ taskId: l.taskId, body: res.body });
    return res;
  };
  return { h, dir, repo, logOf, rejections, questions: [] };
}

/** The test stands in for the session: `delayed` questions are answered once they waited `delayMs`, others at once with `answerFor`. */
function responder(run: Run, opts: { delayed?: { id: string; text: string; delayMs: number }; answerFor: (q: { id: string; kind: string; message: string }) => string }): () => boolean {
  const answered = new Set<string>();
  return () => {
    const s = run.h.orch.status();
    for (const id of s.openQuestions) {
      const e = run.h.orch.entry(id);
      const q = e.status.kind === 'waiting' ? e.status.question : e.status.kind === 'blocked' ? e.status.reason : undefined;
      // A relaunched task asks again, so a question is keyed by when it was asked, not by its text.
      if (!q) continue;
      const key = `${id}:${e.status.kind === 'waiting' ? e.status.askedAt : q.message}`;
      if (answered.has(key)) continue;
      let text: string;
      let waitedMs: number | undefined;
      if (opts.delayed?.id === id && e.status.kind === 'waiting' && q.kind === 'needsDecision') {
        waitedMs = Date.now() - e.status.askedAt;
        if (waitedMs < opts.delayed.delayMs) continue;
        text = opts.delayed.text;
      } else {
        text = opts.answerFor({ id, kind: q.kind, message: q.message });
      }
      answered.add(key);
      run.questions.push({ id, kind: q.kind, message: q.message, ...(waitedMs !== undefined ? { waitedMs } : {}) });
      if (e.status.kind === 'waiting') run.h.orch.answer(id, text);
      else run.h.orch.unblock(id, { answer: text });
    }
    return s.finished || s.stalled;
  };
}

/** Each task's first launch's events, with scratch paths and the home directory redacted the way the fixtures README describes. */
function recordFixtures(run: Run, name: string): void {
  const scratch = [run.dir, run.dir.replace(/^\/private\//, '/')].sort((a, b) => b.length - a.length);
  const seen = new Set<string>();
  for (const l of run.h.store.listLaunches()) {
    if (seen.has(l.taskId)) continue;
    seen.add(l.taskId);
    let text = run.logOf(l).split('\n').filter((line) => line.trim().startsWith('{')).join('\n');
    for (const s of scratch) text = text.split(s).join('<scratch>');
    text = text.split(homedir()).join('~');
    const file = path.join(fixtures, name === 'graph' ? `e2e-${l.taskId}.jsonl` : `e2e-${name}-${l.taskId}.jsonl`);
    writeFileSync(file, text + '\n');
    console.log('recorded', file);
  }
}

/** Common to both cases: every launch ran opencode on the free model, and the counter rule held for the contended deaths that happened. */
function checkLaunches(run: Run): Launch[] {
  const { h } = run;
  const launches = h.store.listLaunches();
  const failed = h.store.listEvents({ kind: 'launch.failed' });
  const failedIds = new Set(failed.map((e) => e.launchId));
  for (const l of launches) {
    const row = h.store.getLaunch(l.launchId)!;
    expect(row.runner, l.launchId).toBe('opencode');
    expect(row.model, l.launchId).toBe(MODEL);
    expect(row.commitPolicy, l.launchId).toBe('agent');
    // A launch that died at startup has no events and so no usage; every other one read tokens and the cost from the stream.
    if (failedIds.has(l.launchId) && !events(run.logOf(l)).some((e) => e.type === 'step_finish')) continue;
    expect(row.tokens?.input, l.launchId).toBeGreaterThan(0);
    expect(row.tokens?.output, l.launchId).toBeGreaterThan(0);
    expect(row.costUsd, l.launchId).toBe(0);
    expect(row.usageSource, l.launchId).toBe('opencode');
    expect(h.store.listEvents({ kind: 'launch.usage', launchId: l.launchId }), l.launchId).toHaveLength(1);
  }
  // Cost came from the stream (zero on the free model), so no launch is unpriced.
  expect(h.orch.status().cost.unpricedLaunches).toBe(0);
  expect(h.orch.status().cost.runUsd).toBe(0);

  // Every launch but the last of a task charged one attempt, except the uncharged startupContended deaths.
  const contended = failed.filter((e) => e.payload?.['reason'] === 'startupContended');
  for (const e of contended) {
    const uncharged = contended.filter((c) => c.taskId === e.taskId && c.payload?.['charged'] === false).length;
    const own = launches.filter((l) => l.taskId === e.taskId).length;
    expect(h.orch.entry(e.taskId!).attempts, JSON.stringify(failed.map((f) => [f.taskId, f.payload]))).toBe(own - 1 - uncharged);
  }
  console.log(`e2e opencode launches: ${launches.length}; launch.failed: ${JSON.stringify(failed.map((f) => [f.taskId, f.payload]))}; startupContended: ${contended.length}`);
  console.log('e2e opencode tokens by launch:', JSON.stringify(launches.map((l) => ({ task: l.taskId, tokens: h.store.getLaunch(l.launchId)!.tokens, costUsd: h.store.getLaunch(l.launchId)!.costUsd, source: h.store.getLaunch(l.launchId)!.usageSource }))));
  return launches;
}

async function finish(run: Run, name: string, passed: boolean): Promise<void> {
  const { h } = run;
  // On failure the launch logs and the event log are kept for diagnosis; the harness removes the run directory.
  if (!passed) {
    const keep = mkdtempSync(path.join(tmpdir(), `orch-opencode-keep-${name}-`));
    cpSync(path.join(h.config.dataDir, 'logs'), path.join(keep, 'logs'), { recursive: true });
    writeFileSync(path.join(keep, 'events.json'), JSON.stringify(h.store.listEvents(), null, 2));
    writeFileSync(path.join(keep, 'launches.json'), JSON.stringify(h.store.listLaunches(), null, 2));
    console.warn('opencode e2e failed; logs and events kept in', keep);
  } else if (record) recordFixtures(run, name);
  await h.cleanup();
  rmSync(run.dir, { recursive: true, force: true });
}

describe.skipIf(!hasOpencode)('e2e with OpenCode on the free model', () => {
  it.concurrent('three tasks and a long-blocking question at capacity 2 are published by opencode workers with tokens and cost recorded', async () => {
    const run = await startRun('graph', graph);
    const { h, repo } = run;
    let passed = false;
    try {
      const respond = responder(run, {
        delayed: { id: 'T2', text: ANSWER, delayMs: ANSWER_DELAY_MS },
        answerFor: (q) => (q.kind === 'needsAccess' ? 'That command is not allowed here. Do without it, say so in your report, and submit.' : 'Decide yourself, keep it minimal, and proceed.'),
      });
      await h.waitFor(respond, 9 * 60_000);
      // Usage is read once a process has exited, which can be a tick after its task published.
      await h.waitFor(() => h.store.listLaunches().every((l) => h.store.listEvents({ kind: 'launch.usage', launchId: l.launchId }).length > 0 || h.store.listEvents({ kind: 'launch.failed', launchId: l.launchId }).length > 0), 60_000).catch(() => undefined);
      const s = h.orch.status();
      const lastLog = h.store.listLaunches().at(-1) ? run.logOf(h.store.listLaunches().at(-1)!).slice(-3000) : '';
      expect(s.stalled, JSON.stringify({ questions: run.questions, rejections: run.rejections, status: s, lastLog })).toBe(false);
      expect(s.finished).toBe(true);
      expect(s.byStatus.done.sort()).toEqual(['T1', 'T2', 'T3']);
      console.log('e2e opencode status:', JSON.stringify(s, null, 2));

      // One Orchestrator-Task trailer per task on the integration branch's first-parent line.
      const commits = gitIn(repo, 'rev-list', '--first-parent', 'main').split('\n').filter(Boolean);
      const trailers = (await Promise.all(commits.map((c) => commitTrailers(repo, c).then((t) => t['Orchestrator-Task'])))).filter(Boolean);
      expect(trailers.sort()).toEqual(['T1', 'T2', 'T3']);
      expect(gitIn(repo, 'show', 'main:hello.txt').trim()).toBe('hello');
      expect(gitIn(repo, 'show', 'main:answer.txt').trim()).toBe(ANSWER);

      checkLaunches(run);

      // The agent commits under `commit: agent`: no question asked for git commit, and every submit was the agent's.
      expect(run.questions.filter((q) => q.kind === 'needsAccess' && /git (add|commit)/.test(q.message)), JSON.stringify(run.questions)).toEqual([]);
      const reports = h.store.listEvents({ kind: 'agent.report' });
      const submits = reports.filter((r) => (r.payload as { kind?: string }).kind === 'submit');
      expect(submits.length).toBeGreaterThanOrEqual(3);
      expect(submits.some((r) => (r.payload as { committedByOrchestrator?: boolean }).committedByOrchestrator === true), JSON.stringify(submits.map((r) => r.payload))).toBe(false);

      // T2's question waited past OpenCode's default 60 s MCP call timeout and got the answer.
      const q = run.questions.find((x) => x.id === 'T2' && x.kind === 'needsDecision');
      expect(q, JSON.stringify(run.questions)).toBeDefined();
      expect(q!.waitedMs).toBeGreaterThanOrEqual(ANSWER_DELAY_MS);
      console.log('e2e opencode questions:', JSON.stringify(run.questions), 'rejections:', JSON.stringify(run.rejections));
      passed = true;
    } finally {
      await finish(run, 'graph', passed);
    }
  }, 10 * 60_000);

  // An auto-rejected `ask` would end the run (fixtures/opencode/events/P-ask.jsonl); the derived `deny` returns an error the model
  // sees and continues past (P-deny.jsonl), so needsAccess surfaces.
  it.concurrent('a command outside the derived patterns is asked for with needsAccess and the task still finishes', async () => {
    const run = await startRun('access', accessGraph);
    const { h, repo } = run;
    let passed = false;
    try {
      const respond = responder(run, {
        answerFor: (q) =>
          q.kind === 'needsAccess' ? 'That command will not be allowed. Write the single line "denied" to platform.txt instead, commit it, and submit.' : 'Decide yourself, keep it minimal, and proceed.',
      });
      await h.waitFor(respond, 9 * 60_000);
      await h.waitFor(() => h.store.listLaunches().every((l) => h.store.listEvents({ kind: 'launch.usage', launchId: l.launchId }).length > 0 || h.store.listEvents({ kind: 'launch.failed', launchId: l.launchId }).length > 0), 60_000).catch(() => undefined);
      const s = h.orch.status();
      expect(s.stalled, JSON.stringify({ questions: run.questions, rejections: run.rejections, status: s })).toBe(false);
      expect(s.byStatus.done).toEqual(['P1']);

      // The denied command surfaced as the brief instructs: a needsAccess question naming it.
      const access = run.questions.filter((q) => q.kind === 'needsAccess' && /uname/.test(q.message));
      expect(access.length, JSON.stringify(run.questions)).toBeGreaterThanOrEqual(1);
      expect(gitIn(repo, 'show', 'main:platform.txt').trim()).toBe('denied');
      checkLaunches(run);
      console.log('e2e opencode access questions:', JSON.stringify(run.questions));
      passed = true;
    } finally {
      await finish(run, 'access', passed);
    }
  }, 10 * 60_000);
});
