import { afterEach, describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config.js';
import {
  cutStat,
  cutSummary,
  fullOf,
  gatherPrevious,
  indexOf,
  parseReviewQuery,
  previousOf,
  reviewAnswer,
  type PreviousFacts,
  type ReviewBundle,
  type ReviewParams,
  type TaskExtras,
} from '../../src/operator/review.js';
import { fixtureText } from '../graph/helpers.js';
import { makeHarness, runToQuiet, type Harness } from '../loop/harness.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const CUTS = { statLines: 40, summaryChars: 400 };

/** A stat as git-workspace returns it: trimmed, so the first file line has no leading space. */
function stat(files: number, width = 0): string {
  const lines = Array.from({ length: files }, (_, i) => {
    const line = ` src/file${i}.ts | 2 +-`;
    return width ? line.padEnd(width, 'x') : line;
  });
  lines.push(` ${files} files changed, ${files} insertions(+), ${files} deletions(-)`);
  return lines.join('\n').trim();
}

function bundle(over: Partial<ReviewBundle> = {}): ReviewBundle {
  return {
    milestone: 'MVP',
    integrationSha: HEAD,
    reviewVersion: 2,
    tag: 'milestone/MVP/v2',
    baseline: BASE,
    diffStat: stat(45),
    closure: [
      { taskId: 'T1', status: 'done', publishedSha: 'c'.repeat(40), summary: 'x'.repeat(1000), acceptance: [{ criterion: 'a', evidence: 'e' }] },
      { taskId: 'T2', status: 'done', publishedSha: 'd'.repeat(40), summary: 'short', acceptance: [{ criterion: 'b', evidence: 'e' }, { criterion: 'c', evidence: 'f' }] },
      { taskId: 'T3', status: 'done', publishedSha: 'e'.repeat(40), summary: 'no evidence', acceptance: [] },
    ],
    acceptanceCriteria: ['demo runs'],
    ...over,
  };
}

const extras = new Map<string, TaskExtras>([
  ['T1', { title: 'First task', changedFileCount: 3 }],
  ['T2', { title: 'Second task' }],
]);

describe('review index', () => {
  it('states what the cuts left out', () => {
    const b = bundle();
    const idx = indexOf(b, extras, CUTS);
    expect(idx).toMatchObject({ view: 'index', milestone: 'MVP', integrationSha: HEAD, reviewVersion: 2, tag: 'milestone/MVP/v2', baseline: BASE, acceptanceCriteria: ['demo runs'] });
    const lines = String(idx['diffStat']).split('\n');
    const all = b.diffStat.split('\n');
    expect(lines).toHaveLength(42);
    expect(lines.slice(0, 40)).toEqual(all.slice(0, 40));
    expect(lines[40]).toBe(' ... 5 more files');
    expect(lines[41]).toBe(all[45]);
    const closure = idx['closure'] as Array<Record<string, unknown>>;
    expect(closure[0]).toEqual({ taskId: 'T1', title: 'First task', status: 'done', publishedSha: 'c'.repeat(40), summary: 'x'.repeat(400), summaryLength: 1000, acceptanceCount: 1, changedFileCount: 3 });
    expect(closure[1]).toEqual({ taskId: 'T2', title: 'Second task', status: 'done', publishedSha: 'd'.repeat(40), summary: 'short', summaryLength: 5, acceptanceCount: 2 });
    // No title in the payload: the task id.
    expect(closure[2]).toMatchObject({ taskId: 'T3', title: 'T3', summary: 'no evidence', acceptanceCount: 0 });
    for (const c of closure) expect(c).not.toHaveProperty('acceptance');
    const omitted = idx['omitted'] as Array<{ field: string; count: number; fetch: string }>;
    expect(omitted.map((o) => [o.field, o.count])).toEqual([['closure.acceptance', 2], ['closure.summary', 1], ['diffStat', 5]]);
    for (const o of omitted.slice(0, 2)) {
      expect(o.fetch).toContain('task=');
      expect(o.fetch).toContain('full=true');
      expect(o.fetch).toContain('GET /v1/milestones/MVP/review?task=');
    }
    expect(omitted[2]!.fetch).toBe(`git diff --stat ${BASE}..${HEAD}`);
  });

  it('keeps an empty stat empty and omits nothing when nothing was cut', () => {
    for (const statLines of [40, 0]) {
      const idx = indexOf(bundle({ diffStat: '' }), extras, { statLines, summaryChars: 400 });
      expect(idx['diffStat']).toBe('');
      expect((idx['omitted'] as Array<{ field: string }>).map((o) => o.field)).not.toContain('diffStat');
    }
    const plain = bundle({
      diffStat: stat(3),
      closure: [
        { taskId: 'T1', status: 'done', summary: 'one', acceptance: [] },
        // A task with no submit report (cancelled with release): no summary, no evidence.
        { taskId: 'T2', status: 'cancelled', summary: undefined, acceptance: undefined },
      ],
    });
    const idx = indexOf(plain, new Map(), CUTS);
    expect(idx['omitted']).toEqual([]);
    expect(idx['diffStat']).toBe(plain.diffStat);
    expect((idx['closure'] as unknown[])[1]).toEqual({ taskId: 'T2', title: 'T2', status: 'cancelled', summary: '', summaryLength: 0, acceptanceCount: 0 });
  });

  it('cuts to zero and never splits a surrogate pair', () => {
    const b = bundle();
    const zero = cutStat(b.diffStat, 0);
    const all = b.diffStat.split('\n');
    expect(zero).toEqual({ text: [' ... 45 more files', all[45]].join('\n'), omitted: 45 });
    // A one-line stat (the fake workspace's) is whole, also at 0.
    expect(cutStat('1 file changed', 0)).toEqual({ text: '1 file changed', omitted: 0 });
    expect(cutStat('', 5)).toEqual({ text: '', omitted: 0 });
    const idx = indexOf(b, extras, { statLines: 40, summaryChars: 0 });
    const closure = idx['closure'] as Array<{ summary: string; summaryLength: number }>;
    expect(closure.map((c) => [c.summary, c.summaryLength])).toEqual([['', 1000], ['', 5], ['', 11]]);
    expect((idx['omitted'] as Array<{ field: string; count: number }>).find((o) => o.field === 'closure.summary')?.count).toBe(3);
    // The 400th unit is the high half of a pair: the cut stops before the pair.
    const s = 'y'.repeat(399) + '😀' + 'z'.repeat(50);
    expect(s.charCodeAt(399)).toBeGreaterThanOrEqual(0xd800);
    expect(cutSummary(s, 400)).toBe('y'.repeat(399));
    expect(cutSummary(s, 401)).toBe('y'.repeat(399) + '😀');
    expect(cutSummary('abc', 3)).toBe('abc');
  });

  it('config keys default to 40 and 400 and refuse negatives', () => {
    expect(configSchema.parse({}).review).toEqual({ statLines: 40, summaryChars: 400 });
    expect(configSchema.safeParse({ review: { statLines: -1 } }).success).toBe(false);
    expect(configSchema.safeParse({ review: { summaryChars: 1.5 } }).success).toBe(false);
    expect(configSchema.parse({ review: { summaryChars: 5 } }).review).toEqual({ statLines: 40, summaryChars: 5 });
  });

  it('is small at a large milestone shape', () => {
    const closure = Array.from({ length: 24 }, (_, i) => ({
      taskId: `ORC-${100 + i}`,
      status: 'done',
      publishedSha: 'f'.repeat(40),
      summary: 's'.repeat(1200),
      acceptance: Array.from({ length: 7 }, (_, k) => ({ criterion: `criterion ${k}`, evidence: 'e'.repeat(500 - `criterion ${k}`.length) })),
    }));
    const evidence = JSON.stringify(closure[0]!.acceptance).length;
    expect(evidence).toBeGreaterThanOrEqual(3500);
    const big = bundle({ closure, diffStat: stat(600, 60) });
    expect(big.diffStat.split('\n')[1]).toHaveLength(60);
    const titles = new Map(closure.map((c) => [c.taskId, { title: `Task ${c.taskId} with a title of ordinary length`, changedFileCount: 12 }]));
    const index = JSON.stringify(indexOf(big, titles, CUTS)).length;
    const full = JSON.stringify(fullOf(big)).length;
    expect(index).toBeLessThan(20_000);
    expect(full).toBeGreaterThan(100_000);
  });

  it('full keeps the bundle and puts view and omitted first', () => {
    const b = bundle();
    const f = fullOf(b);
    expect(f).toEqual({ ...b, view: 'full', omitted: [] });
    expect(Object.keys(f).slice(0, 2)).toEqual(['view', 'omitted']);
    const keys = Object.keys(indexOf(b, extras, CUTS));
    expect(keys.indexOf('omitted')).toBeLessThan(keys.indexOf('diffStat'));
    expect(keys.indexOf('view')).toBeLessThan(keys.indexOf('closure'));
  });
});

describe('review query', () => {
  it('reads the parameters as strings', () => {
    expect(parseReviewQuery({})).toEqual({ ok: true, params: { full: false } });
    expect(parseReviewQuery({ full: 'false' })).toEqual({ ok: true, params: { full: false } });
    expect(parseReviewQuery({ full: 'true', summaryChars: '0' })).toEqual({ ok: true, params: { full: true, summaryChars: 0 } });
    expect(parseReviewQuery({ task: 'A+B c', statLines: '5' })).toEqual({ ok: true, params: { full: false, task: 'A+B c', statLines: 5 } });
    const refused: Array<[Record<string, string>, string]> = [
      [{ task: 'T1', full: 'true' }, 'full'],
      [{ statLines: '-1' }, 'statLines'],
      [{ statLines: '1.5' }, 'statLines'],
      [{ statLines: '' }, 'statLines'],
      [{ statLines: '1e3' }, 'statLines'],
      [{ summaryChars: 'abc' }, 'summaryChars'],
      [{ summaryChars: '99999999999999999999' }, 'summaryChars'],
      [{ full: 'yes' }, 'full'],
      [{ full: '' }, 'full'],
      [{ task: '' }, 'task'],
    ];
    for (const [query, parameter] of refused) expect(parseReviewQuery(query), JSON.stringify(query)).toMatchObject({ ok: false, parameter, reason: expect.any(String) });
  });
});

describe('review answer names the previous version', () => {
  const P = 'p'.repeat(40);
  const facts = (over: Partial<PreviousFacts> = {}): PreviousFacts => ({
    version: 2,
    milestone: 'MVP',
    sha: P,
    integrationSha: HEAD,
    closure: [{ taskId: 'T1', publishedSha: 'c1' }, { taskId: 'T2', publishedSha: 'd2' }, { taskId: 'T3' }],
    previousClosure: [{ taskId: 'T1', publishedSha: 'c1' }, { taskId: 'T2', publishedSha: 'd1' }, { taskId: 'T9', publishedSha: 'x' }],
    stat: stat(3),
    ...over,
  });

  it('has no block at version 1', () => {
    expect(previousOf(facts({ version: 1 }))).toBeUndefined();
    const b = bundle({ reviewVersion: 1, tag: 'milestone/MVP/v1' });
    expect(indexOf(b, extras, CUTS)).not.toHaveProperty('previous');
    expect(fullOf(b)).not.toHaveProperty('previous');
  });

  it('lists added and republished tasks, not unchanged or dropped ones', () => {
    const p = previousOf(facts())!;
    expect(p.previous).toEqual({ version: 1, sha: P, tag: 'milestone/MVP/v1', tasksSince: [{ taskId: 'T2', change: 'republished' }, { taskId: 'T3', change: 'added' }], diffStat: stat(3) });
    expect(p.omitted).toEqual([]);
    // No published sha then, one now: republished.
    const q = previousOf(facts({ closure: [{ taskId: 'T1', publishedSha: 'c1' }], previousClosure: [{ taskId: 'T1' }] }))!;
    expect(q.previous['tasksSince']).toEqual([{ taskId: 'T1', change: 'republished' }]);
  });

  it('no sha on record: only version and unavailable', () => {
    const p = previousOf(facts({ sha: undefined, version: 3 }))!;
    expect(Object.keys(p.previous).sort()).toEqual(['unavailable', 'version']);
    expect(p.previous['version']).toBe(2);
    expect(String(p.previous['unavailable'])).toContain('tagged:MVP:2');
  });

  it('an empty stat between two different shas gets a note naming previous.sha', () => {
    for (const s of ['', undefined]) {
      const p = previousOf(facts({ stat: s }), 40)!;
      expect(p.previous['diffStat']).toBe('');
      expect(String(p.previous['diffStatNote'])).toContain(P);
      expect(String(p.previous['diffStatNote'])).toContain("not in the daemon's clone");
    }
    expect(previousOf(facts())!.previous).not.toHaveProperty('diffStatNote');
  });

  it('same commit: sameCommit true, empty stat, no note', () => {
    const p = previousOf(facts({ sha: HEAD, stat: undefined, previousClosure: facts().closure }), 40)!;
    expect(p.previous).toEqual({ version: 1, sha: HEAD, tag: 'milestone/MVP/v1', sameCommit: true, tasksSince: [], diffStat: '' });
  });

  it('an unreadable previous closure: tasksSinceUnavailable, no tasksSince', () => {
    const p = previousOf(facts({ previousClosure: undefined }))!;
    expect(p.previous).toMatchObject({ sha: P, diffStat: stat(3), tasksSinceUnavailable: true });
    expect(p.previous).not.toHaveProperty('tasksSince');
  });

  it('gatherPrevious: kv sha, the matching earlier submitted event, and one guarded git call', async () => {
    const sub = (sha: string, closure: unknown) => ({ seq: 1, ts: 0, kind: 'transition', taskId: 'MVP', payload: { to: 'submitted', integrationSha: sha, closure } });
    const prevEv = sub(P, [{ taskId: 'T1', publishedSha: 'c0' }]);
    const curEv = sub(HEAD, [{ taskId: 'T1', publishedSha: 'c1' }]);
    const other = { seq: 2, ts: 0, kind: 'transition', taskId: 'MVP', payload: { to: 'unstarted' } };
    const source = (kv: string | undefined, events: unknown[], diffStat: (a: string, b: string) => Promise<string>) => {
      const calls: string[][] = [];
      const orch = {
        store: { getKv: (k: string) => (k === 'tagged:MVP:1' ? kv : undefined), listEvents: () => events },
        workspace: {
          diffStat: (a: string, b: string) => {
            calls.push([a, b]);
            return diffStat(a, b);
          },
        },
      } as unknown as Parameters<typeof gatherPrevious>[0];
      return { orch, calls };
    };
    const b = bundle({ closure: [{ taskId: 'T1', status: 'done', publishedSha: 'c1' }] });
    const ok = async () => 'fake stat';

    // Version 1: nothing.
    expect(await gatherPrevious(source(P, [prevEv, curEv], ok).orch, bundle({ reviewVersion: 1 }))).toBeUndefined();

    // The matching event: its closure is used, one git call.
    const good = source(P, [prevEv, other, curEv], ok);
    const f = (await gatherPrevious(good.orch, b))!;
    expect(f).toMatchObject({ version: 2, sha: P, previousClosure: [{ taskId: 'T1', publishedSha: 'c0' }], stat: 'fake stat' });
    expect(good.calls).toEqual([[P, HEAD]]);
    expect(previousOf(f)!.previous['tasksSince']).toEqual([{ taskId: 'T1', change: 'republished' }]);

    // kv absent: no sha, no git call, { version, unavailable }.
    const none = source(undefined, [prevEv, curEv], ok);
    const fn = (await gatherPrevious(none.orch, b))!;
    expect(fn.sha).toBeUndefined();
    expect(none.calls).toEqual([]);
    expect(Object.keys(previousOf(fn)!.previous).sort()).toEqual(['unavailable', 'version']);

    // The earlier event's sha differs from the kv sha, or there is no earlier event: no closure.
    for (const events of [[sub('q'.repeat(40), []), curEv], [curEv]]) {
      const fm = (await gatherPrevious(source(P, events, ok).orch, b))!;
      expect(fm.previousClosure).toBeUndefined();
      const prev = previousOf(fm)!.previous;
      expect(prev).toMatchObject({ sha: P, diffStat: 'fake stat', tasksSinceUnavailable: true });
      expect(prev).not.toHaveProperty('tasksSince');
    }

    // A throwing git call is an empty stat, with the note.
    const thrown = (await gatherPrevious(source(P, [prevEv, curEv], async () => { throw new Error('bad object'); }).orch, b))!;
    expect(thrown.stat).toBe('');
    expect(String(previousOf(thrown)!.previous['diffStatNote'])).toContain(P);
  });

  it('the index cuts previous.diffStat and names it in omitted; the full answer keeps it whole', () => {
    const f = facts({ stat: stat(45) });
    const b = bundle();
    const idx = indexOf(b, extras, CUTS, f);
    const prev = idx['previous'] as Record<string, unknown>;
    const lines = String(prev['diffStat']).split('\n');
    const all = stat(45).split('\n');
    expect(lines).toHaveLength(42);
    expect(lines.slice(0, 40)).toEqual(all.slice(0, 40));
    expect(lines[40]).toBe(' ... 5 more files');
    expect(lines[41]).toBe(all[45]);
    const omitted = idx['omitted'] as Array<{ field: string; count: number; fetch: string }>;
    const o = omitted.find((x) => x.field === 'previous.diffStat')!;
    expect(o.count).toBe(5);
    expect(o.fetch).toBe(`git diff --stat ${P}..${HEAD}`);
    expect(omitted.at(-1)).toBe(o);
    const keys = Object.keys(idx);
    expect(keys.indexOf('previous')).toBe(keys.indexOf('omitted') + 1);
    expect(keys.indexOf('previous')).toBeLessThan(keys.indexOf('diffStat'));
    const full = fullOf(b, f);
    expect((full['previous'] as Record<string, unknown>)['diffStat']).toBe(stat(45));
    expect(full['omitted']).toEqual([]);
    const fk = Object.keys(full);
    expect(fk.slice(0, 3)).toEqual(['view', 'omitted', 'previous']);
    expect(fk.indexOf('previous')).toBeLessThan(fk.indexOf('diffStat'));
  });
});

describe('review answer previous block in the loop', () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });
  const answer = async (params: Partial<ReviewParams> = {}) => {
    const r = await reviewAnswer(h!.orch, 'MVP', { full: false, ...params });
    expect(r.status).toBe(200);
    return r.body;
  };
  const submittedEvents = () => h!.store.listEvents({ kind: 'transition', taskId: 'MVP' }).filter((e) => e.payload?.['to'] === 'submitted');
  const recordStats = () => {
    const calls: Array<[string, string]> = [];
    const orig = h!.workspace.diffStat.bind(h!.workspace);
    h!.workspace.diffStat = async (from: string, to: string) => {
      calls.push([from, to]);
      return orig(from, to);
    };
    return calls;
  };

  it('version 1: no previous in the index or the full answer', async () => {
    h = makeHarness();
    await runToQuiet(h);
    expect(h.orch.entry('MVP')).toMatchObject({ status: { kind: 'submitted' }, reviewVersion: 1 });
    expect(await answer()).not.toHaveProperty('previous');
    expect(await answer({ full: true })).not.toHaveProperty('previous');
  });

  it('version 2 after a task is published again: previous names version 1, its sha and the republished task', async () => {
    h = makeHarness();
    await runToQuiet(h);
    const v1 = h.orch.entry('MVP');
    expect(h.orch.acceptMilestone('MVP', v1.integrationSha!, 1)).toEqual({ ok: true });
    await h.orch.settle();
    // Jobs are listed by createdAt, then by their random id: the new job must be created later than the old one.
    h.advance(1000);
    h.orch.reopen('T3');
    await h.orch.tick();
    await h.submit('T3');
    await h.orch.settle();
    const v2 = h.orch.entry('MVP');
    expect(v2).toMatchObject({ status: { kind: 'submitted' }, reviewVersion: 2 });
    expect(v2.integrationSha).not.toBe(v1.integrationSha);
    const before = (submittedEvents().at(-2)!.payload!['closure'] as Array<{ taskId: string; publishedSha?: string }>).find((c) => c.taskId === 'T3')!.publishedSha;
    const now = h.store.listJobs({ taskId: 'T3', status: 'published' }).at(-1)!.publishedSha;
    expect(now).not.toBe(before);
    const calls = recordStats();
    const idx = await answer();
    expect(idx['previous']).toEqual({
      version: 1,
      sha: v1.integrationSha,
      tag: 'milestone/MVP/v1',
      tasksSince: [{ taskId: 'T3', change: 'republished' }],
      diffStat: `fake diff ${v1.integrationSha}..${v2.integrationSha}`,
    });
    expect(calls.filter(([from]) => from === v1.integrationSha)).toEqual([[v1.integrationSha, v2.integrationSha]]);
    const full = await answer({ full: true });
    expect(full['previous']).toEqual(idx['previous']);
    // The whole-milestone stat stays beside it.
    expect(idx['diffStat']).toBe(`fake diff ${idx['baseline']}..${v2.integrationSha}`);
  });

  it('the one-task answer has no previous at version 2', async () => {
    h = makeHarness();
    await runToQuiet(h);
    const v1 = h.orch.entry('MVP');
    expect(h.orch.acceptMilestone('MVP', v1.integrationSha!, 1)).toEqual({ ok: true });
    h.orch.reopen('MVP');
    await h.orch.settle();
    expect(h.orch.entry('MVP')).toMatchObject({ status: { kind: 'submitted' }, reviewVersion: 2 });
    expect(await answer()).toHaveProperty('previous');
    const one = await answer({ task: 'T3' });
    expect(one['view']).toBe('task');
    expect(one['reviewVersion']).toBe(2);
    expect(one).not.toHaveProperty('previous');
  });

  it('a task added between versions is added; an unchanged task is not listed', async () => {
    h = makeHarness();
    await runToQuiet(h);
    const v1 = h.orch.entry('MVP');
    expect(h.orch.acceptMilestone('MVP', v1.integrationSha!, 1)).toEqual({ ok: true });
    h.orch.reopen('MVP');
    await h.orch.settle();
    const v2 = h.orch.entry('MVP');
    expect(v2.reviewVersion).toBe(2);
    expect(h.orch.rejectMilestone('MVP', 'demo failed')).toEqual({ ok: true });
    h.source.set(`nodes:
  - { id: T1, deps: [] }
  - { id: T2, deps: [T1] }
  - { id: T3, deps: [T1] }
  - { id: T4, deps: [T2] }
  - { id: T5, deps: [] }
  - { id: T7, deps: [] }
  - { id: MVP, kind: milestone, gated: true, deps: [T3, T4, T7] }`);
    expect(h.orch.unblock('MVP')).toEqual({ ok: true });
    await h.orch.settle();
    await h.submit('T7');
    await h.orch.settle();
    const v3 = h.orch.entry('MVP');
    expect(v3).toMatchObject({ status: { kind: 'submitted' }, reviewVersion: 3 });
    const prev = (await answer())['previous'] as Record<string, unknown>;
    expect(prev).toMatchObject({ version: 2, sha: v2.integrationSha, tag: 'milestone/MVP/v2' });
    expect(prev['tasksSince']).toEqual([{ taskId: 'T7', change: 'added' }]);
  });

  it('resubmitted at the same commit: sameCommit, empty stat, no tasks, no git call for the previous sha', async () => {
    h = makeHarness();
    await runToQuiet(h);
    const v1 = h.orch.entry('MVP');
    expect(v1).toMatchObject({ status: { kind: 'submitted' }, reviewVersion: 1 });
    // A deps edit that leaves the closure as it was: reset from submitted, resubmitted in the same tick.
    h.source.set(fixtureText('standard.yaml').replace('deps: [T3, T4]', 'deps: [T3, T4, T1]'));
    await h.orch.tick();
    expect(h.store.listEvents({ kind: 'milestone.reset' })).toMatchObject([{ taskId: 'MVP', payload: { from: 'submitted', reviewVersion: 1 } }]);
    const v2 = h.orch.entry('MVP');
    expect(v2).toMatchObject({ status: { kind: 'submitted' }, reviewVersion: 2 });
    expect(v2.integrationSha).toBe(v1.integrationSha);
    const calls = recordStats();
    const idx = await answer();
    expect(idx['previous']).toEqual({ version: 1, sha: v1.integrationSha, tag: 'milestone/MVP/v1', sameCommit: true, tasksSince: [], diffStat: '' });
    expect(calls.length).toBeGreaterThan(0); // the baseline stat went through the recorder
    expect(calls.filter(([from]) => from === v1.integrationSha)).toEqual([]);
  });
});
