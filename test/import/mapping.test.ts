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

  it('parses a scope section, one glob per item, with the headings in either order', () => {
    const both = splitDescription('Do the thing.\n\n## Acceptance criteria\n- it works\n\n## Scope\n- src/api/**\n- package.json');
    expect(both).toEqual({ description: 'Do the thing.', acceptanceCriteria: ['it works'], scope: ['src/api/**', 'package.json'] });
    const reversed = splitDescription('Intro text.\n\n**Scope**\n- docs/*\n\nAcceptance criteria:\n1. ok\n2. fine\n\n## Notes\nignored');
    expect(reversed).toEqual({ description: 'Intro text.', acceptanceCriteria: ['ok', 'fine'], scope: ['docs/*'] });
    // A bold scope heading ends the criteria section even though it is not a markdown heading.
    expect(splitDescription('x\n## Acceptance criteria\n- a\n**Scope**\n- src/**')).toEqual({ description: 'x', acceptanceCriteria: ['a'], scope: ['src/**'] });
    expect(splitDescription('x\n## Files\n- lib/**', 'Acceptance criteria', 'Files')).toEqual({ description: 'x', acceptanceCriteria: [], scope: ['lib/**'] });
    const none = splitDescription('No headings here');
    expect(none).toEqual({ description: 'No headings here', acceptanceCriteria: [] });
    expect('scope' in none).toBe(false);
  });
});

describe('tracker record', () => {
  it('is validated and passed through without changing the mapping', () => {
    const plain = mapIssues(epic);
    const tracked = mapIssues({ ...epic, tracker: { kind: 'linear', workspace: 'acme' } });
    expect(tracked.content).toBe(plain.content);
    expect(tracked.rev).toBe(plain.rev);
    expect(() => mapIssues({ ...epic, tracker: { kind: 'jira' } })).toThrow(ImportError);
    expect(() => mapIssues({ ...epic, tracker: { kind: 'atlassian', workspace: '' } })).toThrow(ImportError);
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
    expect(r.summary).toEqual({ tasks: 3, external: 4, milestones: 1, missingCriteria: ['ENG-5'], unknownExternal: ['OPS-9'], inProgressAsExternal: ['ENG-6'], ignoredLabels: [] });
    const g = parseGraph(r.content);
    expect(g.rev).toBe(r.rev);
    expect(g.nodes.size).toBe(8);
  });

  it('scope lands in the payload; priority 0 is dropped and other priorities pass through', () => {
    const issues = [
      { id: 'E', title: 'epic', state: 'open', blockedBy: [] },
      { id: 'A', parent: 'E', state: 'open', description: 'A.\n\n## Acceptance criteria\n- a\n\n## Scope\n- src/api/**\n- package.json', blockedBy: [], priority: 0 },
      { id: 'B', parent: 'E', state: 'open', description: 'B.\n\n## Scope\n- src/ui/**', blockedBy: [], priority: 1 },
      { id: 'C', parent: 'E', state: 'open', description: 'C with no scope', blockedBy: [], priority: 'High' },
      { id: 'D', parent: 'E', state: 'open', description: 'D.\n\n## Area\n- lib/**', blockedBy: [], priority: 4 },
    ];
    const r = mapIssues({ root: 'E', issues });
    const byId = Object.fromEntries(r.nodes.map((n) => [n.id, n]));
    expect(byId['A']).toMatchObject({ scope: ['src/api/**', 'package.json'], acceptanceCriteria: ['a'], description: 'A.' });
    expect('priority' in byId['A']!).toBe(false);
    expect(byId['B']).toMatchObject({ scope: ['src/ui/**'], priority: 1, description: 'B.' });
    expect(byId['C']).toMatchObject({ priority: 'High' });
    expect('scope' in byId['C']!).toBe(false);
    expect(byId['D']).toMatchObject({ priority: 4 });
    expect('scope' in byId['D']!).toBe(false); // "Area" is not the scope heading in this import, so it stays in the description
    expect(String(byId['D']!['description'])).toContain('## Area');
    expect(parseGraph(r.content).nodes.get('A')?.payload['scope']).toEqual(['src/api/**', 'package.json']);

    const renamed = mapIssues({ root: 'E', issues, options: { scopeHeading: 'Area' } });
    const byId2 = Object.fromEntries(renamed.nodes.map((n) => [n.id, n]));
    expect(byId2['D']).toMatchObject({ scope: ['lib/**'] });
    expect('scope' in byId2['A']!).toBe(false);
  });

  // See specs/graph-import "Mapping rules" (selector labels) and specs/model-selection.
  it('model: and effort: labels set the selectors, stay in labels, and a bad value is ignored with a note', () => {
    const r = mapIssues({
      root: 'E',
      issues: [
        { id: 'E', title: 'epic', state: 'open', blockedBy: [] },
        { id: 'A', parent: 'E', state: 'open', description: 'A.\n\n## Acceptance criteria\n- a', blockedBy: [], labels: ['Effort:low', 'model:claude-sonnet-5-5', 'backend'] },
        { id: 'KNO-7', parent: 'E', state: 'open', description: 'B.\n\n## Acceptance criteria\n- b', blockedBy: [], labels: ['effort:huge', 'MODEL: opus; rm'] },
        { id: 'C', parent: 'E', state: 'open', description: 'C.\n\n## Acceptance criteria\n- c', blockedBy: [] },
      ],
    });
    const byId = Object.fromEntries(r.nodes.map((n) => [n.id, n]));
    expect(byId['A']).toMatchObject({ effort: 'low', model: 'claude-sonnet-5-5', labels: ['Effort:low', 'model:claude-sonnet-5-5', 'backend'] });
    expect('effort' in byId['KNO-7']!).toBe(false);
    expect('model' in byId['KNO-7']!).toBe(false);
    expect(byId['KNO-7']).toMatchObject({ labels: ['effort:huge', 'MODEL: opus; rm'] });
    expect('model' in byId['C']!).toBe(false);
    expect(r.summary.ignoredLabels).toEqual([
      { id: 'KNO-7', label: 'effort:huge' },
      { id: 'KNO-7', label: 'MODEL: opus; rm' },
    ]);
    const g = parseGraph(r.content);
    expect(g.nodes.get('A')?.payload).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' });
  });

  it("the root's description and acceptance criteria ride on the milestone", () => {
    const r = mapIssues({
      root: 'E',
      issues: [
        { id: 'E', title: 'epic', state: 'open', blockedBy: [], description: 'The goal.\n\n## Acceptance criteria\n- demo runs\n- docs updated' },
        { id: 'A', parent: 'E', state: 'open', description: 'A.\n\n## Acceptance criteria\n- a', blockedBy: [] },
      ],
    });
    expect(r.nodes.find((n) => n.id === 'E')).toMatchObject({ kind: 'milestone', description: 'The goal.', acceptanceCriteria: ['demo runs', 'docs updated'] });
    const bare = mapIssues(epic);
    expect('description' in bare.nodes.find((n) => n.id === 'ENG-1')!).toBe(false);
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
