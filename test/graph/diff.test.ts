import { describe, expect, it } from 'vitest';
import { classifyReload } from '../../src/graph/diff.js';
import { parseGraph } from '../../src/graph/load.js';
import { loadFixture, overlayWith } from './helpers.js';

const base = loadFixture('standard.yaml');
const running = overlayWith({ T1: 'done', T2: 'running' });

function variant(text: string) {
  return parseGraph(text);
}

const standardNodes = `
  - { id: T1, title: Schema migration,  deps: [] }
  - { id: T2, title: Feature A API,     deps: [T1] }
  - { id: T3, title: Feature B API,     deps: [T1] }
  - { id: T4, title: Feature A UI,      deps: [T2] }
  - { id: T5, title: Changelog,         deps: [] }
  - { id: MVP, kind: milestone, gated: true, deps: [T3, T4] }`;

describe('reload classification', () => {
  it('follow-up task added mid-run is compatible', () => {
    const next = variant(`nodes:${standardNodes}\n  - { id: T6, deps: [T2] }`);
    expect(classifyReload(base, next, running)).toMatchObject({ compatible: true, added: ['T6'] });
  });

  it('dependency added to a running task is incompatible', () => {
    const next = variant(`nodes:${standardNodes.replace('deps: [T1] }\n  - { id: T3', 'deps: [T1, T5] }\n  - { id: T3')}`);
    const r = classifyReload(base, next, running);
    expect(r.compatible).toBe(false);
    if (!r.compatible) expect(r.reasons[0]).toMatchObject({ id: 'T2', code: 'depsChangedStarted' });
  });

  it('removing a running task is incompatible', () => {
    const next = variant(`nodes:${standardNodes.replace('  - { id: T2, title: Feature A API,     deps: [T1] }\n', '').replace('deps: [T2]', 'deps: [T1]')}`);
    const r = classifyReload(base, next, running);
    expect(r.compatible).toBe(false);
    if (!r.compatible) expect(r.reasons.map((x) => x.id)).toContain('T2');
  });

  it('cancel then remove is compatible and keeps the orphan entry', () => {
    const o = overlayWith({ T1: 'done', T2: { kind: 'cancelled', reason: 'x', releasesDependents: false } });
    const next = variant(`nodes:${standardNodes.replace('  - { id: T2, title: Feature A API,     deps: [T1] }\n', '').replace('deps: [T2]', 'deps: [T1]')}`);
    expect(classifyReload(base, next, o)).toMatchObject({ compatible: true, removed: ['T2'] });
    expect(o.get('T2')?.status.kind).toBe('cancelled');
  });

  it('payload or gated change on a started node is compatible; kind change is not', () => {
    const payload = variant(`nodes:${standardNodes.replace('Feature A API', 'Feature A API v2')}`);
    expect(classifyReload(base, payload, running)).toMatchObject({ compatible: true, changed: ['T2'] });
    const kind = variant(`nodes:${standardNodes.replace('id: T2, title: Feature A API,', 'id: T2, kind: milestone,')}`);
    const r = classifyReload(base, kind, running);
    expect(r.compatible).toBe(false);
    if (!r.compatible) expect(r.reasons[0]?.code).toBe('kindChangedStarted');
  });

  it('a dependency change on a submitted milestone is compatible and listed; payload edits of started tasks are listed', () => {
    const o = overlayWith({ T1: 'done', T2: 'done', T3: 'done', T4: 'done', MVP: 'submitted' });
    const next = variant(`nodes:${standardNodes.replace('deps: [T3, T4] }', 'deps: [T3, T4, T5] }')}`);
    expect(classifyReload(base, next, o)).toMatchObject({ compatible: true, changed: ['MVP'], milestoneDepsChanged: ['MVP'], payloadChanged: [] });
    const payload = variant(`nodes:${standardNodes.replace('Feature A API', 'Feature A API v2')}`);
    expect(classifyReload(base, payload, running)).toMatchObject({ compatible: true, changed: ['T2'], payloadChanged: ['T2'], milestoneDepsChanged: [] });
    const unstartedMilestone = variant(`nodes:${standardNodes.replace('deps: [T3, T4] }', 'deps: [T3, T4, T5] }')}`);
    expect(classifyReload(base, unstartedMilestone, running)).toMatchObject({ compatible: true, milestoneDepsChanged: [] });
  });

  // See specs/task-graph "Reload compatibility": the finished-task exception.
  it('a done task may become a done external; an unfinished external or a running task may not', () => {
    const done = overlayWith({ T1: 'done', T2: 'running' });
    const asDoneExternal = variant(`nodes:${standardNodes.replace('id: T1, title: Schema migration,', 'id: T1, kind: external, done: true, title: Schema migration,')}`);
    const ok = classifyReload(base, asDoneExternal, done);
    expect(ok).toMatchObject({ compatible: true, changed: ['T1'] });
    expect(done.get('T1')?.status.kind).toBe('done');
    const asOpenExternal = variant(`nodes:${standardNodes.replace('id: T1, title: Schema migration,', 'id: T1, kind: external, done: false, title: Schema migration,')}`);
    const bad = classifyReload(base, asOpenExternal, done);
    expect(bad.compatible).toBe(false);
    if (!bad.compatible) expect(bad.reasons.map((r) => [r.id, r.code])).toEqual([['T1', 'kindChangedStarted']]);
    const runningToExternal = variant(`nodes:${standardNodes.replace('id: T2, title: Feature A API,', 'id: T2, kind: external, done: true, title: Feature A API,')}`);
    const bad2 = classifyReload(base, runningToExternal, done);
    expect(bad2.compatible).toBe(false);
    if (!bad2.compatible) expect(bad2.reasons[0]).toMatchObject({ id: 'T2', code: 'kindChangedStarted' });
  });

  it('deps change on an unstarted node is compatible', () => {
    const next = variant(`nodes:${standardNodes.replace('deps: [T2] }', 'deps: [T2, T3] }')}`);
    expect(classifyReload(base, next, running)).toMatchObject({ compatible: true, changed: ['T4'] });
  });
});
