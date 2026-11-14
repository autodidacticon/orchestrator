/**
 * ORC-91: a proposed graph rejected under a Postgres store stays rejected across restarts until it is sent again; a
 * Postgres store with git.pushIntegration off is warned about at startup; attempt context naming lost refs is rewritten
 * and the brief names none of them. See specs/graph-import "Rejected proposal stays rejected", specs/state-backend
 * "Postgres store without push integration" and specs/crash-recovery "Context naming lost work".
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeBrief } from '../../src/brief/compose.js';
import { scrubCarry } from '../../src/brief/lost.js';
import { type ConfigInput, defaultConfig, storeDurabilityWarning } from '../../src/config.js';
import { REJECTED_STAMP_KEY, StoreGraphSource } from '../../src/graph/source.js';
import { Orchestrator } from '../../src/loop/orchestrator.js';
import { InprocRunner } from '../../src/runner/inproc.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import { type AttemptContext, defaultEntry } from '../../src/state/status.js';
import type { Store } from '../../src/state/store.js';
import { FakeVerifierBackend } from '../../src/verify/fake.js';
import { FakeWorkspace } from '../../src/workspace/fake.js';
import type { BriefInput } from '../../src/workspace/workspace.js';

const G1 = 'nodes:\n  - { id: T1, deps: [], description: d, acceptanceCriteria: [a] }\n  - { id: T2, deps: [], description: d, acceptanceCriteria: [a] }\n';
/** T1 now depends on T2: incompatible while T1 is started, compatible once it is not. */
const G2 = 'nodes:\n  - { id: T1, deps: [T2], description: d, acceptanceCriteria: [a] }\n  - { id: T2, deps: [], description: d, acceptanceCriteria: [a] }\n';

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'orch-gaps-'));
  store = new SqliteStore(path.join(dir, 'store.sqlite'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A daemon over the store with the proposed slot as its graph source; a new call is a restart. */
function daemon(config: ConfigInput = {}): Orchestrator {
  return new Orchestrator({
    store,
    config: defaultConfig({ dataDir: dir, checkCommand: 'true', ...config }),
    graphSource: new StoreGraphSource(store),
    runner: new InprocRunner(),
    workspace: new FakeWorkspace(),
    verifier: new FakeVerifierBackend(),
  });
}

describe('a rejected proposed graph (store source)', () => {
  it('stays rejected after it becomes compatible, across a restart, until it is sent again', async () => {
    store.setProposedGraph('g1', G1);
    let o = daemon();
    await o.loadGraph();
    const active = o.graph().rev;
    // T1 started (submitted, say): the proposal changing its deps is rejected.
    store.setEntry('T1', { ...defaultEntry(1), status: { kind: 'submitted' } });
    const rejected = store.setProposedGraph('g2', G2);
    await o.loadGraph();
    expect(o.graph().rev).toBe(active);
    expect(o.graphRejected()?.reasons.join(' ')).toMatch(/deps of T1 changed while started/);
    expect(JSON.parse(store.getKv(REJECTED_STAMP_KEY) ?? '{}')).toMatchObject({ stamp: rejected.stamp, reasons: [expect.stringMatching(/deps of T1/)] });

    // Now compatible: T1 is back to unstarted. Neither the next tick's reload nor a restart activates the proposal.
    store.setEntry('T1', defaultEntry(2));
    await o.loadGraph();
    expect(o.graph().rev).toBe(active);
    o = daemon();
    await o.loadGraph();
    expect(o.graph().rev).toBe(active);
    expect(store.listEvents({ kind: 'graph.loaded' })).toHaveLength(1);
    // The restarted daemon still reports the standing rejection, without evaluating the proposal again.
    expect(o.graphRejected()?.reasons.join(' ')).toMatch(/deps of T1 changed while started/);
    expect(store.listEvents({ kind: 'graph.rejected' })).toHaveLength(1);

    // Sent again: a new write is evaluated, and is accepted.
    store.setProposedGraph('g2', G2);
    await o.loadGraph();
    expect(o.graph().rev).not.toBe(active);
    expect(o.graph().nodes.get('T1')?.deps).toEqual(['T2']);
    expect(o.graphRejected()).toBeUndefined();
  });

  it('a stored proposal that does not parse is rejected once and not again after a restart', async () => {
    store.setProposedGraph('g1', G1);
    let o = daemon();
    await o.loadGraph();
    store.setProposedGraph('bad', 'nodes: [ { id: T1, deps: [NOPE] } ]\n');
    await o.loadGraph();
    expect(store.listEvents({ kind: 'graph.rejected' })).toHaveLength(1);
    o = daemon();
    await o.loadGraph();
    expect(store.listEvents({ kind: 'graph.rejected' })).toHaveLength(1);
  });
});

describe('Postgres store with git.pushIntegration off', () => {
  it('is warned about at startup, not refused; with pushing on, or under sqlite, there is no warning', async () => {
    const pgOff = defaultConfig({ store: { kind: 'postgres', url: 'postgres://u@h/db' } });
    expect(storeDurabilityWarning(pgOff)).toMatch(/git\.pushIntegration is off.*restart loses every publication/);
    expect(storeDurabilityWarning(defaultConfig({ store: { kind: 'postgres', url: 'postgres://u@h/db' }, git: { pushIntegration: true } }))).toBeUndefined();
    expect(storeDurabilityWarning(defaultConfig())).toBeUndefined();

    store.setProposedGraph('g1', G1);
    const o = daemon({ store: { kind: 'postgres', url: 'postgres://u@h/db' }, daemon: { idleExitMs: 0 } });
    await o.start();
    await o.stop();
    expect(store.listEvents({ kind: 'config.warning' })).toMatchObject([{ payload: { code: 'postgresWithoutPushIntegration' } }]);
    expect(o.hasGraph()).toBe(true);
  });
});

describe('attempt context naming lost refs', () => {
  const carry: AttemptContext = {
    interrupted: { priorLaunchId: 'L1', priorBranch: 'task/T1/l1', headSha: 'h1', wipCommit: 'w1', reason: 'leaseExpired', interruptions: 1 },
    conflict: { files: ['a.ts'], since: ['T0'], previousBranch: 'task/T1/l0' },
    revision: { cause: 'reopened', priorLaunchId: 'L0', priorBranch: 'task/T1/l0', priorPublishedSha: 'p0' },
    answer: 'yes',
  };

  it('scrubCarry rewrites only what names a lost ref, and reports each part', () => {
    expect(scrubCarry(carry, () => false)).toEqual({ carry });
    const { carry: out, lost } = scrubCarry(carry, (r) => r === 'task/T1/l1' || r === 'task/T1/l0');
    expect(out).toEqual({
      lostWork: { priorLaunchId: 'L1', reason: 'leaseExpired' },
      conflict: { files: ['a.ts'], since: ['T0'] },
      revision: { cause: 'reopened', priorLaunchId: 'L0', priorPublishedSha: 'p0' },
      answer: 'yes',
    });
    expect(lost?.map((p) => p.field)).toEqual(['interrupted', 'conflict', 'revision']);
    // A lost commit alone is enough for a kept release.
    expect(scrubCarry({ interrupted: carry.interrupted }, (r) => r === 'w1').carry).toEqual({ lostWork: { priorLaunchId: 'L1', reason: 'leaseExpired' } });
  });

  it('the brief composed from a scrubbed context names no lost branch or commit', () => {
    const { carry: out } = scrubCarry(carry, (r) => ['task/T1/l1', 'task/T1/l0', 'h1', 'w1', 'p0'].includes(r));
    const input: BriefInput = {
      launch: { launchId: 'L2', taskId: 'T1', token: 't', worktree: '/w', branch: 'task/T1/l2', baseSha: 'b2', graphRev: 'r', attempt: 1, launchNo: 3, status: 'claimable' } as BriefInput['launch'],
      node: { id: 'T1', kind: 'task', payload: { title: 'T1', acceptanceCriteria: ['a'] }, deps: [] },
      depReports: [],
      carry: out as Record<string, unknown>,
      apiBaseUrl: 'http://x',
      retryWindowMs: 1000,
      integrationBranch: 'main',
    };
    for (const commitPolicy of ['agent', 'daemon'] as const) {
      const { markdown, json } = composeBrief({ ...input, runner: { kind: 'claude-code', commitPolicy } }, { fallbackPath: '/f', openspec: false });
      const text = `${markdown}\n${JSON.stringify(json)}`;
      for (const ref of ['task/T1/l1', 'task/T1/l0', 'h1', 'w1', 'p0']) expect(text).not.toContain(ref);
      expect(markdown).toContain('Your previous launch `L1` was interrupted (leaseExpired)');
      expect(markdown).toContain('Your previous branch conflicted on rebase in: a.ts');
      expect(markdown).toContain("Your prior launch `L0` worked on a branch that was lost with the orchestrator's previous clone and did not publish");
    }
  });
});
