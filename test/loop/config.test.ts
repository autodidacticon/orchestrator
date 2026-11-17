import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigInput } from '../../src/config.js';
import { Orchestrator } from '../../src/loop/orchestrator.js';
import { BASE_RULES } from '../../src/toolchain/tools.js';
import { makeHarness, type Harness } from './harness.js';

const three = `nodes:
  - { id: A, deps: [], description: d, acceptanceCriteria: [a] }
  - { id: B, deps: [], description: d, acceptanceCriteria: [a] }
  - { id: C, deps: [], description: d, acceptanceCriteria: [a] }`;

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});
const harness = (config: ConfigInput = {}) => {
  const h = makeHarness({ graph: three, config: { capacity: 2, ...config } });
  open.push(h);
  return h;
};

// See specs/toolchain-discovery "Runtime overrides and start-only keys" and "Resolved configuration record".
describe('effective configuration', () => {
  it('reports provenance for the harness config and the base rules with no detection', async () => {
    // An in-memory config stands for the file layer: a value that differs from the default is `file`, one equal to it is `default`.
    const h = harness({ capacity: 3 });
    await h.orch.loadGraph();
    const r = h.orch.configReport();
    expect(r.config.checkCommand).toEqual({ value: 'true', source: 'file' });
    expect(r.config.capacity).toEqual({ value: 3, source: 'file' });
    expect(harness().orch.configReport().config.capacity).toEqual({ value: 2, source: 'default' });
    expect(r.config.integrationBranch).toEqual({ value: 'main', source: 'default' });
    expect(r.config.runnerCommand.source).toBe('default');
    expect(r.config.allowedTools).toMatchObject({ value: [...BASE_RULES], source: 'composed', applied: true, parts: { default: [...BASE_RULES], detected: [], file: [], argument: [] } });
    expect(r.config.model).toEqual({ value: 'claude-opus-5-5', source: 'default', applied: true });
    expect(r.config.effort).toEqual({ value: 'medium', source: 'default', applied: true });
    expect(r.toolchain).toBeUndefined();
    expect(r.needsConfig).toEqual([]);
    expect(r.overrides).toEqual({});
    const s = h.orch.status();
    expect(s.config.capacity).toEqual({ value: 3, source: 'file' });
    expect(s.needsConfig).toEqual([]);
  });

  it('a capacity override admits the third ready task on the next tick and survives a new orchestrator over the same store', async () => {
    const h = harness();
    await h.orch.tick();
    expect(h.orch.status().byStatus.running.sort()).toEqual(['A', 'B']);
    expect(h.orch.setConfig({ capacity: 3 })).toMatchObject({ ok: true, applied: ['capacity'] });
    expect(h.orch.configReport().config.capacity).toEqual({ value: 3, source: 'argument' });
    await h.orch.tick();
    expect(h.orch.status().byStatus.running.sort()).toEqual(['A', 'B', 'C']);
    const kinds = h.store.listEvents().map((e) => e.kind).filter((k) => k === 'operator.config' || k === 'config.resolved');
    expect(kinds).toEqual(['operator.config', 'config.resolved']);
    expect(h.store.listEvents({ kind: 'operator.config' })[0]?.payload).toMatchObject({ patch: { capacity: 3 }, overrides: { capacity: 3 } });
    expect(h.store.listEvents({ kind: 'config.resolved' })[0]?.payload).toMatchObject({ capacity: { value: 3, source: 'argument' }, needsConfig: [], overrides: ['capacity'] });
    const again = new Orchestrator({ store: h.store, config: h.orch.config, graphSource: h.source, runner: h.runner, workspace: h.workspace, verifier: h.verifier, clock: () => h.now.value });
    expect(again.configReport().config.capacity).toEqual({ value: 3, source: 'argument' });
  });

  it('refuses a start-only key with 409 and applies nothing from the mixed patch', () => {
    const h = harness();
    expect(h.orch.setConfig({ integrationBranch: 'develop', capacity: 5 })).toMatchObject({ ok: false, status: 409, startOnly: ['integrationBranch'] });
    expect(h.orch.effective().config.capacity).toBe(2);
    expect(h.store.listEvents({ kind: 'operator.config' })).toEqual([]);
  });

  // See specs/worker-runners "Runner kinds and defaults" and "Per-kind effort sets".
  it('selects the runner kind at runtime, binds the flat model and effort to the kind in force, and names the kind in an effort refusal', () => {
    const h = harness();
    expect(h.orch.setConfig({ runnerKind: 'cursor' })).toMatchObject({ ok: false, status: 400, key: 'runnerKind' });
    const ultra = h.orch.setConfig({ effort: 'ultra' });
    expect(ultra).toMatchObject({ ok: false, status: 400, key: 'effort' });
    expect((ultra as { error: string }).error).toContain('claude-code');
    expect(h.store.listEvents({ kind: 'operator.config' })).toEqual([]);
    expect(h.orch.setConfig({ model: 'claude-sonnet-5-5' })).toMatchObject({ ok: true, applied: ['model'] });
    expect(h.orch.setConfig({ runnerKind: 'codex' })).toMatchObject({ ok: true, applied: ['runnerKind'] });
    const r = h.orch.configReport();
    expect(r.config.runnerKind).toEqual({ value: 'codex', source: 'argument' });
    expect(r.config.model).toEqual({ value: 'gpt-6-astra', source: 'default', applied: true });
    expect(r.config.codex).toMatchObject({ model: { value: 'gpt-6-astra', source: 'default' }, sandbox: { value: 'workspace-write', source: 'default' }, command: { source: 'default' } });
    expect(r.config.allowedTools).toMatchObject({ value: [], applied: false });
    const huge = h.orch.setConfig({ effort: 'huge' });
    expect(huge).toMatchObject({ ok: false, status: 400, key: 'effort' });
    expect((huge as { error: string }).error).toContain('codex');
    expect(h.orch.setConfig({ effort: 'ultra', codex: { sandbox: 'read-only' } })).toMatchObject({ ok: true, applied: ['effort', 'codex'] });
    expect(h.orch.configReport().config.effort).toEqual({ value: 'ultra', source: 'argument', applied: true });
    expect(h.orch.configReport().overrides).toEqual({ runnerKind: 'codex', claude: { model: 'claude-sonnet-5-5' }, codex: { effort: 'ultra', sandbox: 'read-only' } });
    expect(h.orch.setConfig({ runnerKind: null, codex: { sandbox: null } })).toMatchObject({ ok: true });
    expect(h.orch.configReport().config).toMatchObject({ runnerKind: { value: 'claude-code', source: 'default' }, model: { value: 'claude-sonnet-5-5', source: 'argument' }, codex: { sandbox: { value: 'workspace-write', source: 'default' }, effort: { value: 'ultra', source: 'argument' } } });
  });

  it('refuses invalid values with 400 naming the key, the unsafe rule, or the unknown key, and applies nothing', () => {
    const h = harness();
    expect(h.orch.setConfig({ capacity: 0 })).toMatchObject({ ok: false, status: 400, key: 'capacity' });
    expect(h.orch.setConfig({ capacity: 3, checkCommand: '' })).toMatchObject({ ok: false, status: 400, key: 'checkCommand' });
    expect(h.orch.effective().config.capacity).toBe(2);
    const unsafe = h.orch.setConfig({ allowedTools: ['Bash(echo "$HOME")'] });
    expect(unsafe).toMatchObject({ ok: false, status: 400, key: 'allowedTools' });
    expect((unsafe as { error: string }).error).toContain('Bash(echo');
    expect(h.orch.setConfig({ nope: 1 })).toMatchObject({ ok: false, status: 400, key: 'nope' });
    // apiBind and apiBaseUrl are read once at start; they are file keys, not runtime overrides. See specs/cluster-runtime "Bind host and advertised URL".
    expect(h.orch.setConfig({ apiBind: '0.0.0.0' })).toMatchObject({ ok: false, status: 400, key: 'apiBind' });
    expect(h.orch.setConfig({ apiBaseUrl: 'http://orchestrator:8080' })).toMatchObject({ ok: false, status: 400, key: 'apiBaseUrl' });
    // See specs/model-selection "Run default model and effort".
    expect(h.orch.setConfig({ effort: 'huge' })).toMatchObject({ ok: false, status: 400, key: 'effort' });
    expect(h.orch.setConfig({ model: 'opus; rm -rf /' })).toMatchObject({ ok: false, status: 400, key: 'model' });
    expect(h.orch.setConfig('x')).toMatchObject({ ok: false, status: 400 });
    expect(h.store.getKv('config.overrides')).toBeUndefined();
    expect(h.store.listEvents({ kind: 'operator.config' })).toEqual([]);
  });

  it('null clears an override so the value falls back to the next layer', () => {
    const h = harness();
    h.orch.setConfig({ checkCommand: 'make check', allowedTools: ['Bash(docker:*)'] });
    expect(h.orch.configReport().config.checkCommand).toEqual({ value: 'make check', source: 'argument' });
    expect(h.orch.configReport().config.allowedTools.parts.argument).toEqual(['Bash(docker:*)']);
    expect(h.orch.setConfig({ checkCommand: null })).toMatchObject({ ok: true, applied: ['checkCommand'] });
    expect(h.orch.configReport().config.checkCommand).toEqual({ value: 'true', source: 'file' });
    expect(h.orch.configReport().overrides).toEqual({ allowedTools: ['Bash(docker:*)'] });
    expect(h.orch.setConfig({})).toMatchObject({ ok: true, applied: [] });
  });
});

// See specs/toolchain-discovery "Runtime limit overrides" and specs/operator-control "Status report: limits in force".
describe('limit overrides', () => {
  it('0 disables a stuck fail limit at runtime, and null falls back to the file value or the default', async () => {
    const h = harness({ health: { stuckAfterMs: 1000, stuckFailAfterMs: 3000 } });
    await h.orch.tick();
    const a = h.store.listLaunches({ status: 'live' }).find((l) => l.taskId === 'A')!;
    expect(h.orch.setConfig({ health: { stuckFailAfterMs: 0 } })).toMatchObject({ ok: true, applied: ['health'] });
    expect(h.orch.status().budgets.stuckFailAfterMs).toBe(0);
    expect(h.orch.configReport().config.health.stuckFailAfterMs).toEqual({ value: 0, source: 'argument' });
    expect(h.orch.status().config.health.stuckFailAfterMs).toEqual({ value: 0, source: 'argument' });
    h.advance(10_000);
    await h.orch.tick();
    expect(h.store.getLaunch(a.launchId)).toMatchObject({ status: 'live' });
    expect(h.orch.entry('A')).toMatchObject({ attempts: 0, status: { kind: 'running' } });
    expect(h.orch.status().stuck).toContain('A');

    // On a run with no live launch, a null brings back the file value, or the default.
    const file = harness({ health: { stuckAfterMs: 1000, stuckFailAfterMs: 3000 } });
    await file.orch.loadGraph();
    expect(file.orch.setConfig({ health: { stuckFailAfterMs: 0 } })).toMatchObject({ ok: true });
    expect(file.orch.setConfig({ health: { stuckFailAfterMs: null } })).toMatchObject({ ok: true, applied: ['health'] });
    expect(file.orch.status().budgets.stuckFailAfterMs).toBe(3000);
    expect(file.orch.configReport().config.health.stuckFailAfterMs).toEqual({ value: 3000, source: 'file' });
    expect(file.orch.configReport().overrides).toEqual({});
    const dflt = harness();
    await dflt.orch.loadGraph();
    expect(dflt.orch.setConfig({ health: { stuckFailAfterMs: 0 } })).toMatchObject({ ok: true });
    expect(dflt.orch.setConfig({ health: { stuckFailAfterMs: null } })).toMatchObject({ ok: true });
    expect(dflt.orch.status().budgets.stuckFailAfterMs).toBe(2_700_000);
    expect(dflt.orch.configReport().config.health.stuckFailAfterMs).toEqual({ value: 2_700_000, source: 'default' });
    expect(dflt.orch.status().budgets).toEqual({ maxLaunchMs: 7_200_000, maxRunCostUsd: 0, stuckAfterMs: 900_000, stuckFailAfterMs: 2_700_000 });
  });

  it('refuses bad limit values with 400 naming the dotted key, and applies nothing', () => {
    const h = harness();
    for (const v of [-1, 1.5, '5000', Number.MAX_SAFE_INTEGER + 2]) {
      expect(h.orch.setConfig({ budgets: { maxLaunchMs: v } }), String(v)).toMatchObject({ ok: false, status: 400, key: 'budgets.maxLaunchMs' });
      expect(h.orch.setConfig({ health: { stuckAfterMs: v } }), String(v)).toMatchObject({ ok: false, status: 400, key: 'health.stuckAfterMs' });
    }
    const unknown = h.orch.setConfig({ health: { reportGraceMs: 1 } });
    expect(unknown).toMatchObject({ ok: false, status: 400, key: 'health.reportGraceMs' });
    expect(h.orch.setConfig({ budgets: { maxRunCostUsd: 5 } })).toMatchObject({ ok: false, status: 400, key: 'budgets.maxRunCostUsd' });
    const pair = h.orch.setConfig({ health: { stuckFailAfterMs: 600_000 } });
    expect(pair).toMatchObject({ ok: false, status: 400, key: 'health.stuckFailAfterMs' });
    expect((pair as { error: string }).error).toMatch(/^health\.stuckFailAfterMs: .*600000.*900000/);
    expect(h.store.getKv('config.overrides')).toBeUndefined();
    expect(h.store.listEvents({ kind: 'operator.config' })).toEqual([]);
  });

  it('a stored limit survives a restart: the new orchestrator reports it as an argument and its first tick uses it', async () => {
    const h = harness({ budgets: { maxLaunchMs: 10_000 } });
    await h.orch.tick();
    const a = h.store.listLaunches({ status: 'live' }).find((l) => l.taskId === 'A')!;
    expect(h.orch.setConfig({ budgets: { maxLaunchMs: 40_000 } })).toMatchObject({ ok: true });
    const again = new Orchestrator({ store: h.store, config: h.orch.config, graphSource: h.source, runner: h.runner, workspace: h.workspace, verifier: h.verifier, clock: () => h.now.value });
    expect(again.configReport().config.budgets.maxLaunchMs).toEqual({ value: 40_000, source: 'argument' });
    await again.loadGraph();
    expect(again.status().budgets.maxLaunchMs).toBe(40_000);
    h.advance(15_000);
    await again.tick();
    expect(h.store.getLaunch(a.launchId)).toMatchObject({ status: 'live' });
    expect(again.entry('A')).toMatchObject({ attempts: 0, status: { kind: 'running' } });
    h.advance(26_000);
    await again.tick();
    expect(h.store.getLaunch(a.launchId)).toMatchObject({ status: 'ended', endReason: 'timeBudget' });
  });
});
