import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BriefValidator } from '../../src/brief/validate.js';
import type { StuckDiagnoser } from '../../src/health/stuck.js';
import { defaultConfig, type Config } from '../../src/config.js';
import { StaticGraphSource } from '../../src/graph/source.js';
import { Orchestrator, type ApiResponse } from '../../src/loop/orchestrator.js';
import { InprocRunner } from '../../src/runner/inproc.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import type { Launch } from '../../src/state/store.js';
import { FakeVerifierBackend } from '../../src/verify/fake.js';
import { FakeWorkspace } from '../../src/workspace/fake.js';
import { fixtureText } from '../graph/helpers.js';

export interface Harness {
  orch: Orchestrator;
  store: SqliteStore;
  runner: InprocRunner;
  workspace: FakeWorkspace;
  verifier: FakeVerifierBackend;
  source: StaticGraphSource;
  dir: string;
  now: { value: number };
  advance(ms: number): void;
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

export function makeHarness(opts: { graph?: string; config?: Partial<Config>; dir?: string; briefValidator?: BriefValidator; stuckDiagnoser?: StuckDiagnoser } = {}): Harness {
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), 'orch-'));
  const config = defaultConfig({ dataDir: dir, capacity: 4, maxWaiting: 4, ...opts.config });
  const store = new SqliteStore(path.join(dir, 'store.sqlite'));
  const runner = new InprocRunner();
  const workspace = new FakeWorkspace();
  const verifier = new FakeVerifierBackend();
  const source = new StaticGraphSource(opts.graph ?? fixtureText('standard.yaml'));
  const now = { value: 1_000_000 };
  const orch = new Orchestrator({
    store,
    config,
    graphSource: source,
    runner,
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
    workspace,
    verifier,
    source,
    dir,
    now,
    advance: (ms) => {
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
