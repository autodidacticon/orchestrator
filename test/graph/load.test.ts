import { describe, expect, it } from 'vitest';
import { GraphValidationError, parseGraph, revOf } from '../../src/graph/load.js';
import { closure } from '../../src/graph/query.js';
import { fixtureText, loadFixture } from './helpers.js';

describe('graph loading', () => {
  it('loads the standard fixture', () => {
    const g = loadFixture('standard.yaml');
    expect(g.nodes.size).toBe(6);
    const mvp = g.nodes.get('MVP');
    expect(mvp?.kind).toBe('milestone');
    expect(mvp?.gated).toBe(true);
    expect(g.rev).toBe(revOf(fixtureText('standard.yaml')));
    expect(g.nodes.get('T1')?.payload).toEqual({ title: 'Schema migration' });
    expect([...g.nodes.keys()]).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'MVP']);
  });

  it('same content yields the same revision', () => {
    expect(parseGraph(fixtureText('standard.yaml')).rev).toBe(parseGraph(fixtureText('standard.yaml')).rev);
    expect(parseGraph('nodes: [{id: A}]').rev).not.toBe(parseGraph('nodes: [{id: B}]').rev);
  });

  it('accepts JSON', () => {
    const g = parseGraph(JSON.stringify({ nodes: [{ id: 'A' }, { id: 'B', deps: ['A'] }] }));
    expect(g.nodes.get('B')?.deps).toEqual(['A']);
    expect(g.dependents.get('A')).toEqual(['B']);
  });

  it('reports a cycle with its path', () => {
    try {
      loadFixture('cyclic.yaml');
      expect.unreachable();
    } catch (err) {
      const e = err as GraphValidationError;
      expect(e).toBeInstanceOf(GraphValidationError);
      expect(e.code).toBe('cycle');
      expect(e.details['path']).toEqual(['A', 'B', 'C', 'A']);
      expect(e.message).toContain('A -> B -> C -> A');
    }
  });

  it('rejects a dependency on an unknown id, naming both', () => {
    expect(() => loadFixture('dangling.yaml')).toThrow(/node "B" depends on unknown id "NOPE"/);
  });

  it('rejects a duplicate id', () => {
    expect(() => loadFixture('duplicate.yaml')).toThrow(/duplicate node id "A"/);
  });

  it('rejects a self-loop', () => {
    expect(() => parseGraph('nodes: [{id: A, deps: [A]}]')).toThrow(/depends on itself/);
  });

  it('accepts multiple sinks', () => {
    const g = parseGraph('nodes: [{id: A}, {id: B}]');
    expect(g.nodes.size).toBe(2);
  });

  it('rejects unparseable and schema-invalid input', () => {
    expect(() => parseGraph('nodes: [{deps: []}]')).toThrow(GraphValidationError);
    expect(() => parseGraph(': : :')).toThrow(GraphValidationError);
  });

  // See specs/model-selection "Task selectors".
  it('model and effort load into the payload; a bad value is rejected naming the node and the key', () => {
    const g = parseGraph(`nodes:\n  - { id: A, deps: [], model: claude-sonnet-5-5, effort: low }\n  - { id: B, deps: [] }`);
    expect(g.nodes.get('A')?.payload).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' });
    expect(g.nodes.get('B')?.payload).toEqual({});
    for (const [bad, key] of [
      ['effort: huge', 'effort'],
      ['effort: 3', 'effort'],
      ['model: "opus; rm -rf /"', 'model'],
      ['model: ""', 'model'],
    ] as const) {
      try {
        parseGraph(`nodes:\n  - { id: A, deps: [] }\n  - { id: T4, deps: [A], ${bad} }`);
        expect.unreachable();
      } catch (err) {
        const e = err as GraphValidationError;
        expect(e.code).toBe('schema');
        expect(e.message).toMatch(/node "T4"/);
        expect(e.message).toMatch(new RegExp(key));
      }
    }
  });

  it('scope loads into the payload; a malformed scope is rejected naming the node', () => {
    const g = parseGraph(`nodes:\n  - { id: A, deps: [], scope: ["src/api/**", "package.json"] }\n  - { id: B, deps: [] }`);
    expect(g.nodes.get('A')?.payload).toEqual({ scope: ['src/api/**', 'package.json'] });
    expect(g.nodes.get('B')?.payload).toEqual({});
    expect('scope' in (g.nodes.get('B')?.payload ?? {})).toBe(false);
    for (const bad of ['scope: "src/**"', 'scope: [""]', 'scope: [1]']) {
      try {
        parseGraph(`nodes:\n  - { id: A, deps: [] }\n  - { id: T4, deps: [A], ${bad} }`);
        expect.unreachable();
      } catch (err) {
        const e = err as GraphValidationError;
        expect(e).toBeInstanceOf(GraphValidationError);
        expect(e.code).toBe('schema');
        expect(e.message).toMatch(/node "T4"/);
        expect(e.message).toMatch(/scope/);
      }
    }
  });

  it('closure(MVP) is T1..T4', () => {
    const g = loadFixture('standard.yaml');
    expect([...closure(g, 'MVP')].sort()).toEqual(['T1', 'T2', 'T3', 'T4']);
  });
});
