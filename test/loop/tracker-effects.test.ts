import { afterEach, describe, expect, it } from 'vitest';
import { SlotValidator, defaultSlots } from '../../src/brief/template.js';
import type { Config } from '../../src/config.js';
import { setTracker } from '../../src/state/store.js';
import { fixtureText } from '../graph/helpers.js';
import { makeHarness, runToQuiet, type Harness } from './harness.js';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

function trackerCfg(over: Partial<Config['tracker']> = {}): Config['tracker'] {
  return { enabled: 'auto', maxAttempts: 3, parentInProgress: true, commentOnDone: false, commentOnFail: false, doneAt: 'integration', answersFromComments: true, ...over };
}

function tracked(over: Partial<Config['tracker']> = {}, extra: { graph?: string; record?: boolean; validator?: boolean } = {}): Harness {
  const h = makeHarness({
    graph: extra.graph ?? fixtureText('tracked.yaml'),
    // A long lease keeps clock jumps for maxWait from expiring other launches (a v1 defect add-health-monitoring fixes).
    config: {
      tracker: trackerCfg(over),
      leaseTtlMs: 4 * 3600_000,
      health: { stuckAfterMs: 0, stuckFailAfterMs: 0, baseMovedNotice: true },
      budgets: { maxLaunchMs: 0, maxRunCostUsd: 0 },
    },
    briefValidator: extra.validator ? new SlotValidator(defaultSlots) : undefined,
  });
  if (extra.record !== false) setTracker(h.store, { kind: 'linear', workspace: 'acme', recordedAt: 1 });
  open.push(h);
  return h;
}

const states = (h: Harness, id: string): string[] =>
  h.store.listOutbox().filter((e) => e.taskId === id && e.kind === 'setState').map((e) => String(e.payload['state']));
const comments = (h: Harness, id: string): string[] =>
  h.store.listOutbox().filter((e) => e.taskId === id && e.kind === 'comment').map((e) => String(e.payload['body']));

describe('tracker effect derivation', () => {
  it('derives one inProgress per task across a retry and a conflict relaunch, keyed to the transition event', async () => {
    const h = tracked();
    await h.orch.tick();
    expect(states(h, 'T1')).toEqual(['inProgress']);
    const [row] = h.store.listOutbox().filter((e) => e.taskId === 'T1');
    const [ev] = h.store.listEvents({ kind: 'transition', taskId: 'T1' });
    expect(row).toMatchObject({ sourceSeq: ev!.seq, status: 'pending', payload: { issue: 'T1', url: 'https://tracker.example/T1', state: 'inProgress' } });

    await h.failTask('T1', 'nope');
    expect(h.statusOf('T1')).toBe('unstarted');
    await h.orch.tick();
    expect(h.statusOf('T1')).toBe('running');
    expect(states(h, 'T1')).toEqual(['inProgress']);

    h.verifier.on('T5', { kind: 'conflict', files: ['CHANGELOG.md'], since: [] });
    await h.submit('T5');
    await h.orch.settle();
    await h.orch.tick();
    expect(h.statusOf('T5')).toBe('running');
    expect(h.orch.entry('T5').launches).toBe(2);
    expect(states(h, 'T5')).toEqual(['inProgress']);
  });

  it('the parent issue follows its first starting child, unless parentInProgress is off', async () => {
    const h = tracked();
    await h.orch.tick();
    expect(states(h, 'MVP')).toEqual([]);
    await h.submit('T1');
    await h.orch.settle();
    expect(h.orch.status().byStatus.running.sort()).toEqual(['T2', 'T3', 'T5']);
    expect(states(h, 'MVP')).toEqual(['inProgress']);
    await h.submit('T2');
    await h.orch.settle();
    expect(h.statusOf('T4')).toBe('running');
    expect(states(h, 'MVP')).toEqual(['inProgress']);

    const off = tracked({ parentInProgress: false });
    await off.orch.tick();
    await off.submit('T1');
    await off.orch.settle();
    expect(off.statusOf('T3')).toBe('running');
    expect(states(off, 'MVP')).toEqual([]);
  });

  it('done at integration: the task flips at publication, the parent at acceptance, with review comments', async () => {
    const h = tracked();
    await runToQuiet(h);
    expect(h.orch.status().awaitingReview).toEqual(['MVP']);
    expect(states(h, 'T3')).toEqual(['inProgress', 'done']);
    expect(states(h, 'T5')).toEqual(['inProgress', 'done']);
    expect(states(h, 'MVP')).toEqual(['inProgress']);
    const mvp = h.orch.entry('MVP');
    const [submitted] = comments(h, 'MVP');
    expect(submitted).toContain(`version 1 at ${mvp.integrationSha}`);
    expect(submitted).toContain('milestone/MVP/v1');
    expect(submitted).toContain('- T3 (pub-T3-');
    expect(submitted).toContain('did T4');
    expect(h.orch.acceptMilestone('MVP', mvp.integrationSha!, 1)).toEqual({ ok: true });
    await h.orch.settle();
    expect(states(h, 'MVP')).toEqual(['inProgress', 'done']);
    expect(comments(h, 'MVP')).toHaveLength(2);
    expect(comments(h, 'MVP')[1]).toBe(`Milestone accepted: version 1 at ${mvp.integrationSha}.`);
    // every effect carries the run marker
    const markers = h.store.listOutbox().filter((e) => e.kind === 'comment').map((e) => String(e.payload['marker']));
    expect(markers.every((m) => /^— orchestrator run \S+ · event \d+$/.test(m))).toBe(true);
    expect(new Set(markers).size).toBe(markers.length);
  });

  it('done at milestone acceptance: tasks under the gated milestone flip at accept, others at publication', async () => {
    const h = tracked({ doneAt: 'milestoneAccepted' });
    await runToQuiet(h);
    for (const t of ['T1', 'T2', 'T3', 'T4']) {
      expect(states(h, t)).toEqual(['inProgress']);
      expect(comments(h, t)).toEqual([expect.stringMatching(/^Integrated as pub-/)]);
    }
    expect(states(h, 'T5')).toEqual(['inProgress', 'done']);
    const mvp = h.orch.entry('MVP');
    h.orch.acceptMilestone('MVP', mvp.integrationSha!, 1);
    await h.orch.settle();
    for (const t of ['T1', 'T2', 'T3', 'T4']) expect(states(h, t)).toEqual(['inProgress', 'done']);
    expect(states(h, 'MVP')).toEqual(['inProgress', 'done']);
  });

  it('mirrors a question once, exhaustion with what would unblock, and a rejection', async () => {
    const h = tracked();
    await h.orch.tick();
    const l = h.launchOf('T1');
    void h.orch.agentCall(l.launchId, l.token, 'block', { seq: 2, kind: 'needsDecision', message: 'Use REST or GraphQL?', options: ['REST', 'GraphQL'] });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.statusOf('T1')).toBe('waiting');
    expect(comments(h, 'T1')).toEqual([expect.stringContaining('Use REST or GraphQL?')]);
    expect(comments(h, 'T1')[0]).toContain('- GraphQL');
    h.advance(h.orch.config.maxWaitMs + 1);
    await h.orch.tick();
    expect(h.statusOf('T1')).toBe('blocked');
    expect(comments(h, 'T1')).toHaveLength(1);
    expect(h.orch.answer('T1', 'REST')).toEqual({ ok: true });
    await h.orch.tick();
    expect(h.statusOf('T1')).toBe('running');
    expect(states(h, 'T1')).toEqual(['inProgress']);

    const t5 = h.launchOf('T5');
    await h.orch.agentCall(t5.launchId, t5.token, 'report', { seq: 1, kind: 'fail', why: 'no creds', whatWouldUnblock: 'need staging credentials' });
    await h.orch.tick();
    const t5b = h.launchOf('T5');
    await h.orch.agentCall(t5b.launchId, t5b.token, 'report', { seq: 1, kind: 'fail', why: 'still no creds', whatWouldUnblock: 'need staging credentials' });
    expect(h.statusOf('T5')).toBe('blocked');
    expect(comments(h, 'T5')).toHaveLength(1);
    expect(comments(h, 'T5')[0]).toContain('attempts exhausted');
    expect(comments(h, 'T5')[0]).toContain('need staging credentials');

    await runToQuiet(h);
    expect(h.orch.rejectMilestone('MVP', 'demo failed: no login')).toEqual({ ok: true });
    expect(comments(h, 'MVP').at(-1)).toBe('Milestone rejected: demo failed: no login');
  });

  it('mirrors insufficient briefs with the missing slots', async () => {
    const h = tracked({}, { validator: true });
    await h.orch.tick();
    expect(h.statusOf('T1')).toBe('blocked');
    expect(comments(h, 'T1')).toEqual([expect.stringContaining('Missing: description, acceptanceCriteria')]);
    expect(states(h, 'T1')).toEqual([]);
  });

  it('completion and failure comments are off by default and on when configured', async () => {
    const quiet = tracked();
    await quiet.orch.tick();
    await quiet.failTask('T5', 'flaky');
    await quiet.orch.tick();
    await quiet.submit('T5');
    await quiet.orch.settle();
    expect(quiet.statusOf('T5')).toBe('done');
    expect(comments(quiet, 'T5')).toEqual([]);

    const loud = tracked({ commentOnDone: true, commentOnFail: true });
    await loud.orch.tick();
    await loud.failTask('T5', 'flaky');
    await loud.orch.tick();
    await loud.submit('T5');
    await loud.orch.settle();
    expect(comments(loud, 'T5')).toEqual(['Attempt failed (agentFail): flaky', expect.stringMatching(/^Integrated as pub-T5-\d+: did T5$/)]);
  });

  it('a reopened task is set in progress again when it relaunches', async () => {
    const h = tracked();
    await h.orch.tick();
    await h.submit('T5');
    await h.orch.settle();
    expect(h.orch.reopen('T5')).toMatchObject({ ok: true });
    await h.orch.tick();
    expect(h.statusOf('T5')).toBe('running');
    expect(states(h, 'T5')).toEqual(['inProgress', 'done', 'inProgress']);
  });

  it('derives nothing when disabled, when no tracker is recorded, or for a node without identity', async () => {
    const never = tracked({ enabled: 'never' });
    await never.orch.tick();
    expect(never.store.listOutbox()).toEqual([]);

    const unrecorded = tracked({}, { record: false });
    await unrecorded.orch.tick();
    expect(unrecorded.store.listOutbox()).toEqual([]);

    const always = tracked({ enabled: 'always' }, { record: false });
    await always.orch.tick();
    expect(states(always, 'T1')).toEqual(['inProgress']);

    const graph = `${fixtureText('tracked.yaml')}  - { id: T9, title: Hand added, deps: [] }\n`;
    const mixed = tracked({}, { graph });
    await mixed.orch.tick();
    expect(mixed.statusOf('T9')).toBe('running');
    expect(mixed.store.listOutbox().filter((e) => e.taskId === 'T9')).toEqual([]);
    expect(states(mixed, 'T1')).toEqual(['inProgress']);
  });
});
