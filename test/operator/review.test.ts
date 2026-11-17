import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config.js';
import { cutStat, cutSummary, fullOf, indexOf, parseReviewQuery, type ReviewBundle, type TaskExtras } from '../../src/operator/review.js';

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
