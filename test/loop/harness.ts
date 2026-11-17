import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BriefValidator } from '../../src/brief/validate.js';
import type { StuckDiagnoser } from '../../src/health/stuck.js';
import { type ConfigInput, DEFAULT_GAP_AFTER_MS, defaultConfig } from '../../src/config.js';
import { StaticGraphSource } from '../../src/graph/source.js';
import { Orchestrator, type ApiResponse } from '../../src/loop/orchestrator.js';
import { InprocRunner } from '../../src/runner/inproc.js';
import { MultiRunner } from '../../src/runner/multi.js';
import type { RunnerKind } from '../../src/runner/selection.js';
import type { Launch, Store } from '../../src/state/store.js';
import { harnessStore } from '../slice/harness.js';
import { FakeVerifierBackend } from '../../src/verify/fake.js';
import { FakeWorkspace } from '../../src/workspace/fake.js';
import { fixtureText } from '../graph/helpers.js';

export interface Harness {
  orch: Orchestrator;
  store: Store;
  /** The claude-code fake; `runners` holds one per kind behind the orchestrator's MultiRunner. */
  runner: InprocRunner;
  runners: Record<RunnerKind, InprocRunner>;
  workspace: FakeWorkspace;
  verifier: FakeVerifierBackend;
  source: StaticGraphSource;
  dir: string;
  now: { value: number };
  /**
   * Time during which the daemon ran: the clock moves in steps of at most half of `health.gapAfterMs`, noted by
   * `orch` after each step, so it is never a gap. With `health.gapAfterMs: 0` it moves in one step.
   */
  advance(ms: number): void;
  /** Time during which the daemon did not run: the clock moves in one step and nothing is noted. */
  sleep(ms: number): void;
  /** Live launch for a task (throws if none). */
  launchOf(taskId: string): Launch;
  submit(taskId: string, extra?: Record<string, unknown>, seq?: number): Promise<ApiResponse>;
  failTask(taskId: string, why?: string, seq?: number): Promise<ApiResponse>;
  block(taskId: string, message?: string, seq?: number): Promise<ApiResponse>;
  /** Drain the live launch's inbox through the agent API. */
  inbox(taskId: string): Promise<Array<{ kind: string; [k: string]: unknown }>>;
  statusOf(taskId: string): string;
  cleanup(): void;
}

export function makeHarness(opts: { graph?: string; config?: ConfigInput; dir?: string; briefValidator?: BriefValidator; stuckDiagnoser?: StuckDiagnoser; store?: Store } = {}): Harness {
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), 'orch-'));
  // checkCommand has no default any more; in-process scenarios verify with the fake backend and must not be held. See specs/integration-pipeline "Check and verified tree".
  // Fake processes never exit by themselves, so in-process scenarios reap on the tick after submit. See specs/health-monitoring "Usage accounting".
  const config = defaultConfig({ dataDir: dir, capacity: 4, maxWaiting: 4, checkCommand: 'true', health: { reportGraceMs: 0, ...(opts.config?.health ?? {}) }, ...opts.config });
  const store = opts.store ?? harnessStore(path.join(dir, 'store.sqlite'));
  const runners: Record<RunnerKind, InprocRunner> = { 'claude-code': new InprocRunner(), codex: new InprocRunner(), opencode: new InprocRunner() };
  const runner = runners['claude-code'];
  const workspace = new FakeWorkspace();
  const verifier = new FakeVerifierBackend();
  const source = new StaticGraphSource(opts.graph ?? fixtureText('standard.yaml'));
  const now = { value: 1_000_000 };
  const orch = new Orchestrator({
    store,
    config,
    graphSource: source,
    runner: new MultiRunner(runners),
    workspace,
    verifier,
    clock: () => now.value,
    briefValidator: opts.briefValidator,
    stuckDiagnoser: opts.stuckDiagnoser,
  });
  // keep fake verifier head and workspace head aligned
  const origRun = verifier.run.bind(verifier);
  verifier.run = async (job, ctx) => {
    const out = await origRun(job, ctx);
    workspace.head = verifier.head;
    return out;
  };

  const h: Harness = {
    orch,
    store,
    runner,
    runners,
    workspace,
    verifier,
    source,
    dir,
    now,
    advance: (ms) => {
      const gapAfterMs = config.health.gapAfterMs ?? DEFAULT_GAP_AFTER_MS;
      if (gapAfterMs <= 0 || ms <= 0) {
        now.value += ms;
        if (gapAfterMs > 0) h.orch.noteClock();
        return;
      }
      const step = Math.max(1, Math.floor(gapAfterMs / 2));
      for (let left = ms; left > 0; left -= step) {
        now.value += Math.min(step, left);
        // The orchestrator in place now: a test may replace it.
        h.orch.noteClock();
      }
    },
    sleep: (ms) => {
      now.value += ms;
    },
    launchOf: (taskId) => {
      const [l] = store.listLaunches({ taskId, status: 'live' });
      if (!l) throw new Error(`no live launch for ${taskId}`);
      return l;
    },
    submit: (taskId, extra = {}, seq = 1) => {
      const l = h.launchOf(taskId);
      return orch.agentCall(l.launchId, l.token, 'report', { seq, kind: 'submit', summary: `did ${taskId}`, ...extra });
    },
    failTask: (taskId, why = 'could not', seq = 1) => {
      const l = h.launchOf(taskId);
      return orch.agentCall(l.launchId, l.token, 'report', { seq, kind: 'fail', why });
    },
    block: (taskId, message = 'which way?', seq = 2) => {
      const l = h.launchOf(taskId);
      return orch.agentCall(l.launchId, l.token, 'block', { seq, kind: 'needsDecision', message });
    },
    inbox: async (taskId) => {
      const l = h.launchOf(taskId);
      const r = await orch.agentCall(l.launchId, l.token, 'inbox');
      return (r.body['notices'] ?? []) as Array<{ kind: string; [k: string]: unknown }>;
    },
    statusOf: (taskId) => orch.entry(taskId).status.kind,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

/** Run the whole fixture to completion with every task submitting on sight. */
export async function runToQuiet(h: Harness, maxRounds = 30): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    await h.orch.settle();
    const s = h.orch.status();
    if (s.finished || s.stalled || s.awaitingReview.length) return;
    for (const id of s.byStatus.running) await h.submit(id);
    await h.orch.settle();
  }
}
