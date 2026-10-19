import { afterEach, describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config.js';
import { parseGraph } from '../../src/graph/load.js';
import { mapIssues } from '../../src/import/mapping.js';
import {
  DEFAULT_MODEL_BY_KIND,
  EFFORT_FALLBACK,
  EFFORT_LEVELS_BY_KIND,
  isAnyModelName,
  isModelName,
  isModelNameFor,
  modelSchemaFor,
  RUNNER_KINDS,
  zeroByKind,
} from '../../src/runner/selection.js';
import { makeHarness, type Harness } from '../loop/harness.js';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

// See specs/worker-runners "Runner kinds and defaults" and "Per-kind effort sets".
describe('the opencode kind', () => {
  it('is the third kind, with its effort set, ultra fallback, and default model', () => {
    expect(RUNNER_KINDS).toEqual(['claude-code', 'codex', 'opencode']);
    expect(zeroByKind()).toEqual({ 'claude-code': 0, codex: 0, opencode: 0 });
    expect(EFFORT_LEVELS_BY_KIND.opencode).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(EFFORT_FALLBACK.opencode).toEqual({ ultra: 'max' });
    expect(DEFAULT_MODEL_BY_KIND.opencode).toBe('anthropic/claude-opus-5-5');
  });

  it('defaults runner.opencode and checks its model and effort per kind', () => {
    expect(configSchema.parse({}).runner.opencode).toEqual({ model: 'anthropic/claude-opus-5-5', effort: 'medium', commit: 'agent', permission: 'derived', dataDir: 'shared', ignoreUserConfig: false, pure: true, snapshots: false });
    expect(() => configSchema.parse({ runner: { opencode: { model: 'big-pickle' } } })).toThrow(/provider\/model/);
    expect(() => configSchema.parse({ runner: { opencode: { effort: 'ultra' } } })).toThrow(/opencode/);
    expect(() => configSchema.parse({ runner: { claude: { model: 'opencode/big-pickle' } } })).toThrow();
    expect(() => configSchema.parse({ runner: { opencode: { dataDir: 'elsewhere' } } })).toThrow();
    expect(configSchema.parse({ budgets: { prices: { 'opencode/big-pickle': { inputPerMTok: 0, outputPerMTok: 0 } } } }).budgets.prices).toHaveProperty('opencode/big-pickle');
  });
});

// See specs/model-selection "Run default model and effort".
describe('model shape per kind', () => {
  it('takes exactly one slash for opencode and none for the other kinds', () => {
    for (const ok of ['opencode/big-pickle', 'ollama/qwen3.6:35b-mlx', 'gitlab/duo-chat-fable-5', 'anthropic/claude-opus-5-5']) expect(isModelNameFor('opencode', ok)).toBe(true);
    for (const bad of ['opencode/a/b', '/x', 'x/', 'a b/c', "a/b'; rm", 'big-pickle', '', 'a/-b']) expect(isModelNameFor('opencode', bad)).toBe(false);
    expect(isModelNameFor('codex', 'opencode/big-pickle')).toBe(false);
    expect(isModelNameFor('claude-code', 'opencode/big-pickle')).toBe(false);
    expect(isModelNameFor('codex', 'gpt-6-astra')).toBe(true);
    expect(modelSchemaFor('opencode').safeParse('x/').success).toBe(false);
  });

  it('leaves isModelName as it was for the existing kinds', () => {
    for (const ok of ['claude-opus-5-5', 'opus', 'gpt-6-astra', 'a.b:c_d-e']) expect(isModelName(ok)).toBe(true);
    for (const bad of ['opencode/big-pickle', 'opus; rm -rf /', '-x', '']) expect(isModelName(bad)).toBe(false);
  });

  it('accepts either shape where the kind is not yet known', () => {
    expect(isAnyModelName('opencode/big-pickle')).toBe(true);
    expect(isAnyModelName('claude-opus-5-5')).toBe(true);
    expect(isAnyModelName('opencode/a/b')).toBe(false);
  });
});

// See specs/model-selection "Task selectors".
describe('task selectors', () => {
  it('a graph node takes a provider/model without a runner or with runner opencode, and refuses it under another runner', () => {
    expect(parseGraph('nodes:\n  - { id: A, deps: [], model: opencode/big-pickle }').nodes.get('A')?.payload).toEqual({ model: 'opencode/big-pickle' });
    expect(parseGraph('nodes:\n  - { id: A, deps: [], runner: opencode, model: ollama/qwen3.6:35b-mlx }').nodes.get('A')?.payload).toEqual({ runner: 'opencode', model: 'ollama/qwen3.6:35b-mlx' });
    expect(() => parseGraph('nodes:\n  - { id: A, deps: [], runner: codex, model: opencode/big-pickle }')).toThrow(/model.*not a model for codex/);
    expect(() => parseGraph('nodes:\n  - { id: A, deps: [], runner: opencode, model: big-pickle }')).toThrow(/model.*not a model for opencode/);
    expect(() => parseGraph('nodes:\n  - { id: A, deps: [], model: opencode/a/b }')).toThrow(/model/);
  });

  it('an import label takes a provider/model, and ignores it beside a runner label of another kind', () => {
    const task = (id: string, labels: string[]) => ({ id, parent: 'E', state: 'open', description: 'd\n\n## Acceptance criteria\n- x', blockedBy: [], labels });
    const r = mapIssues({
      root: 'E',
      issues: [
        { id: 'E', title: 'epic', state: 'open', blockedBy: [] },
        task('A', ['model:opencode/big-pickle']),
        task('B', ['runner:codex', 'model:opencode/big-pickle']),
        task('C', ['runner:opencode', 'model:opencode/big-pickle']),
      ],
    });
    const nodes = parseGraph(r.content).nodes;
    expect(nodes.get('A')?.payload).toMatchObject({ model: 'opencode/big-pickle' });
    expect(nodes.get('B')?.payload).toMatchObject({ runner: 'codex' });
    expect(nodes.get('B')?.payload).not.toHaveProperty('model');
    expect(nodes.get('C')?.payload).toMatchObject({ runner: 'opencode', model: 'opencode/big-pickle' });
    expect(r.summary.ignoredLabels).toEqual([{ id: 'B', label: 'model:opencode/big-pickle' }]);
  });
});

// See specs/model-selection "Resolution fixed at preparation".
describe('preparation under opencode', () => {
  it('prepares ultra as max with effortRequested, the opencode default model, and the agent commit policy', async () => {
    const h = makeHarness({ graph: 'nodes:\n  - { id: T1, deps: [], description: d, acceptanceCriteria: [a], effort: ultra }', config: { runner: { kind: 'opencode' } } });
    open.push(h);
    await h.orch.tick();
    expect(h.launchOf('T1')).toMatchObject({ runner: 'opencode', model: 'anthropic/claude-opus-5-5', effort: 'max', commitPolicy: 'agent' });
    expect(h.store.listEvents({ kind: 'launch.created', taskId: 'T1' })[0]?.payload).toMatchObject({ runner: 'opencode', effort: 'max', effortRequested: 'ultra' });
    expect(h.orch.selectionFor('T1')).toEqual({ runner: 'opencode', model: 'anthropic/claude-opus-5-5', effort: 'max', effortRequested: 'ultra' });
    expect(h.orch.commitPolicyFor('codex')).toBe('daemon');
  });

  it('binds a provider/model selector under opencode and gives another kind its own default instead', async () => {
    const graph = 'nodes:\n  - { id: P, deps: [], description: d, acceptanceCriteria: [a], model: opencode/big-pickle }\n  - { id: O, deps: [], description: d, acceptanceCriteria: [a], runner: opencode, model: opencode/big-pickle }';
    const h = makeHarness({ graph });
    open.push(h);
    await h.orch.tick();
    expect(h.launchOf('P')).toMatchObject({ runner: 'claude-code', model: 'claude-opus-5-5' });
    expect(h.launchOf('O')).toMatchObject({ runner: 'opencode', model: 'opencode/big-pickle', commitPolicy: 'agent' });
    expect(h.orch.selectionFor('P')).toEqual({ runner: 'claude-code', model: 'claude-opus-5-5', effort: 'medium' });
    expect(h.orch.selectionFor('O')).toEqual({ runner: 'opencode', model: 'opencode/big-pickle', effort: 'medium' });
  });
});
