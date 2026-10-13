import { describe, expect, it } from 'vitest';
import { parseGraph } from '../../src/graph/load.js';
import { ImportError, mapIssues, splitDescription } from '../../src/import/mapping.js';

const epic = {
  root: 'ENG-1',
  issues: [
    { id: 'ENG-1', title: 'Checkout epic', state: 'open', blockedBy: ['OPS-9'] },
    { id: 'ENG-2', title: 'A', parent: 'ENG-1', state: 'open', description: 'Build A.\n\n## Acceptance criteria\n- [ ] A works\n- A is documented\n\n## Notes\nignore', blockedBy: [] },
    { id: 'ENG-3', title: 'B', parent: 'ENG-1', state: 'open', description: 'Build B.\n\nAcceptance criteria:\n1. B works', blockedBy: ['ENG-2'] },
    { id: 'ENG-4', title: 'C', parent: 'ENG-1', state: 'done', description: 'Already done', blockedBy: [] },
    { id: 'ENG-5', title: 'D', parent: 'ENG-1', state: 'open', description: 'No criteria here', blockedBy: ['OPS-7', 'ENG-4'], labels: ['backend'], priority: 2, url: 'https://x/ENG-5' },
    { id: 'ENG-6', title: 'E', parent: 'ENG-1', state: 'inProgress', description: 'Human working', blockedBy: [] },
    { id: 'OPS-7', title: 'Provision DB', state: 'open', blockedBy: [] },
  ],
};

describe('description splitting', () => {
  it('parses criteria under the heading and keeps the text before it', () => {
    expect(splitDescription('Do the thing.\n\n## Acceptance criteria\n- [ ] it works\n- documented\n\n## Notes\nignore')).toEqual({ description: 'Do the thing.', acceptanceCriteria: ['it works', 'documented'] });
    expect(splitDescription('Only prose')).toEqual({ description: 'Only prose', acceptanceCriteria: [] });
    expect(splitDescription('x\n**Acceptance Criteria**\n1) first\n2. second', 'Acceptance criteria')).toEqual({ description: 'x', acceptanceCriteria: ['first', 'second'] });
    expect(splitDescription('x\n### Done when\n- y', 'Done when')).toEqual({ description: 'x', acceptanceCriteria: ['y'] });
    expect(splitDescription(undefined)).toEqual({ description: '', acceptanceCriteria: [] });
  });
});

describe('mapping rules', () => {
  it('maps an epic with mixed children', () => {
    const r = mapIssues(epic);
    const byId = Object.fromEntries(r.nodes.map((n) => [n.id, n]));
    expect(byId['ENG-2']).toMatchObject({ kind: 'task', deps: [], acceptanceCriteria: ['A works', 'A is documented'], description: 'Build A.', trackerState: 'open' });
    expect(byId['ENG-3']).toMatchObject({ kind: 'task', deps: ['ENG-2'], acceptanceCriteria: ['B works'] });
    expect(byId['ENG-4']).toMatchObject({ kind: 'external', done: true, externalCause: 'state' });
    expect(byId['ENG-5']).toMatchObject({ kind: 'task', deps: ['OPS-7', 'ENG-4'], labels: ['backend'], priority: 2, url: 'https://x/ENG-5' });
    expect(byId['ENG-6']).toMatchObject({ kind: 'external', done: false, externalCause: 'state' });
    expect(byId['OPS-7']).toMatchObject({ kind: 'external', done: false, externalCause: 'outside', title: 'Provision DB' });
    expect(byId['OPS-9']).toMatchObject({ kind: 'external', done: false, unknown: true });
    expect(byId['ENG-1']).toMatchObject({ kind: 'milestone', gated: true, title: 'Checkout epic' });
    expect([...(byId['ENG-1']!.deps as string[])].sort()).toEqual(['ENG-2', 'ENG-3', 'ENG-4', 'ENG-5', 'ENG-6', 'OPS-9']);
    expect(r.summary).toEqual({ tasks: 3, external: 4, milestones: 1, missingCriteria: ['ENG-5'], unknownExternal: ['OPS-9'], inProgressAsExternal: ['ENG-6'] });
    const g = parseGraph(r.content);
    expect(g.rev).toBe(r.rev);
    expect(g.nodes.size).toBe(8);
  });

  it('in-progress policy and ungated option', () => {
    const r = mapIssues({ ...epic, options: { inProgress: 'task', gated: false } });
    const byId = Object.fromEntries(r.nodes.map((n) => [n.id, n]));
    expect(byId['ENG-6']).toMatchObject({ kind: 'task' });
    expect(byId['ENG-1']).toMatchObject({ gated: false });
    expect(r.summary.inProgressAsExternal).toEqual([]);
  });

  it('rejects malformed records and roots without children', () => {
    expect(() => mapIssues({ root: 'E', issues: [{ id: 'A', parent: 'E' }] })).toThrow(/issues\.0\.state/);
    expect(() => mapIssues({ root: 'E', issues: [{ id: 'A', state: 'open' }] })).toThrow(/no children/);
    expect(() => mapIssues({ root: 'E', issues: [{ id: 'A', state: 'open' }] })).toThrow(ImportError);
  });

  it('rejects a mapped graph with a cycle, naming it', () => {
    const cyc = { root: 'E', issues: [{ id: 'A', parent: 'E', state: 'open', blockedBy: ['B'] }, { id: 'B', parent: 'E', state: 'open', blockedBy: ['A'] }] };
    expect(() => mapIssues(cyc)).toThrow(/dependency cycle: A -> B -> A|dependency cycle: B -> A -> B/);
  });
});
