import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigInput } from '../../src/config.js';
import { digestOf } from '../../src/operator/routes.js';
import { makeHarness, type Harness } from './harness.js';

// See specs/model-selection "Profile hold at admission" and "Profile sources of a task",
// specs/operator-control "Profile hold key" and "Status report: profiles", specs/operator-mcp "Wait digest: profileHeld".

const task = (id: string, extra = '', deps: string[] = []) => `  - { id: ${id}, deps: [${deps.join(', ')}], description: d, acceptanceCriteria: [a]${extra ? `, ${extra}` : ''} }`;
const graphOf = (...lines: string[]) => `nodes:\n${lines.join('\n')}`;
const BOTH = 'model: claude-sonnet-5-5, effort: high';
const HOLD: ConfigInput = { runner: { confirmProfile: true } };
/** A template with neither the {model} nor the {effort} slot. */
const NO_SLOTS = 'node agent.js {briefJson}';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

function harness(graph: string, config: ConfigInput = HOLD): Harness {
  const h = makeHarness({ graph, config });
  open.push(h);
  return h;
}

const launches = (h: Harness, id: string) => h.store.listLaunches({ taskId: id });
const created = (h: Harness, id: string) => h.store.listEvents({ kind: 'launch.created', taskId: id });
const entryOf = (h: Harness, id: string) => h.orch.status().profiles.find((p) => p.sample.includes(id));

describe('profile hold: off by default', () => {
  it('criterion 1: with no key nothing is held; the default profile is listed and the first tick launches', async () => {
    const h = harness(graphOf(task('A')), {});
    await h.orch.loadGraph();
    const s = h.orch.status();
    expect(s.runner.confirmProfile).toBe(false);
    expect(s.profiles).toEqual([
      { runner: 'claude-code', model: 'claude-opus-5-5', effort: 'medium', modelSource: 'default', effortSource: 'default', held: false, missing: [], tasks: 1, sample: ['A'] },
    ]);
    expect(digestOf(h.orch)['profileHeld']).toEqual([]);
    await h.orch.tick();
    expect(h.launchOf('A')).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
  });
});

describe('profile hold at admission', () => {
  it('criteria 2 and 3: a task on built-in defaults is held without a launch, event, pause or deferral; setting the built-in values releases it', async () => {
    const h = harness(graphOf(task('A'), task('B', BOTH)));
    await h.orch.tick();
    expect(h.launchOf('B')).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(h.statusOf('A')).toBe('unstarted');
    expect(launches(h, 'A')).toEqual([]);
    expect(created(h, 'A')).toEqual([]);
    let s = h.orch.status();
    expect(s.paused).toBe(false);
    expect(s.stalled).toBe(false);
    expect(s.deferred.length).toBe(0);
    expect(s.runner.confirmProfile).toBe(true);
    expect(s.profiles).toEqual([
      { runner: 'claude-code', model: 'claude-opus-5-5', effort: 'medium', modelSource: 'default', effortSource: 'default', held: true, missing: ['model', 'effort'], tasks: 1, sample: ['A'] },
    ]);
    expect(digestOf(h.orch)['profileHeld']).toEqual([{ runner: 'claude-code', missing: ['model', 'effort'], tasks: 1 }]);
    // No transition was written for the held task.
    expect(h.store.listEvents({ kind: 'transition', taskId: 'A' })).toEqual([]);

    // Confirming is setting, also to the built-in values.
    expect(h.orch.setConfig({ model: 'claude-opus-5-5', effort: 'medium' })).toMatchObject({ ok: true });
    await h.orch.tick();
    expect(h.launchOf('A')).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
    s = h.orch.status();
    expect(s.config.model.source).toBe('argument');
    expect(s.profiles).toEqual([]);
    expect(digestOf(h.orch)['profileHeld']).toEqual([]);
  });

  it('criterion 4: one key set is not enough', async () => {
    const h = harness(graphOf(task('A')));
    expect(h.orch.setConfig({ model: 'claude-opus-5-5' })).toMatchObject({ ok: true });
    await h.orch.tick();
    expect(h.statusOf('A')).toBe('unstarted');
    expect(launches(h, 'A')).toEqual([]);
    expect(digestOf(h.orch)['profileHeld']).toEqual([{ runner: 'claude-code', missing: ['effort'], tasks: 1 }]);
    expect(entryOf(h, 'A')).toMatchObject({ modelSource: 'argument', effortSource: 'default', held: true, missing: ['effort'] });
  });

  it('criterion 5: the hold is per kind (claude-code run, codex task)', async () => {
    const h = harness(graphOf(task('C', 'runner: codex')));
    expect(h.orch.setConfig({ model: 'claude-opus-5-5', effort: 'medium' })).toMatchObject({ ok: true });
    await h.orch.tick();
    expect(launches(h, 'C')).toEqual([]);
    expect(entryOf(h, 'C')).toMatchObject({ runner: 'codex', model: 'gpt-6-astra', effort: 'medium', held: true, missing: ['model', 'effort'] });
    expect(digestOf(h.orch)['profileHeld']).toEqual([{ runner: 'codex', missing: ['model', 'effort'], tasks: 1 }]);
    expect(h.orch.setConfig({ codex: { model: 'gpt-6-astra', effort: 'medium' } })).toMatchObject({ ok: true });
    await h.orch.tick();
    expect(h.launchOf('C')).toMatchObject({ runner: 'codex', model: 'gpt-6-astra', effort: 'medium' });
  });

  it('criterion 5: the hold is per kind (codex run, claude-code task)', async () => {
    const h = harness(graphOf(task('K', 'runner: claude-code')));
    expect(h.orch.setConfig({ runnerKind: 'codex', codex: { model: 'gpt-6-astra', effort: 'medium' } })).toMatchObject({ ok: true });
    await h.orch.tick();
    expect(launches(h, 'K')).toEqual([]);
    expect(entryOf(h, 'K')).toMatchObject({ runner: 'claude-code', held: true, missing: ['model', 'effort'] });
    expect(h.orch.setConfig({ claude: { model: 'claude-opus-5-5', effort: 'medium' } })).toMatchObject({ ok: true });
    await h.orch.tick();
    expect(h.launchOf('K')).toMatchObject({ runner: 'claude-code', model: 'claude-opus-5-5', effort: 'medium' });
  });

  it('criterion 6: a held task takes no capacity', async () => {
    const h = harness(graphOf(task('H'), task('S', BOTH)), { capacity: 1, runner: { confirmProfile: true } });
    await h.orch.tick();
    expect(h.launchOf('S')).toBeDefined();
    expect(launches(h, 'H')).toEqual([]);
    expect(h.orch.status().deferred).toEqual([]);
  });

  it('criterion 7: a value the kind does not take does not confirm; an effort fallback comes from the task', async () => {
    const h = harness(graphOf(task('M', 'model: opencode/big-pickle, effort: high'), task('U', 'effort: ultra')));
    await h.orch.tick();
    expect(launches(h, 'M')).toEqual([]);
    expect(entryOf(h, 'M')).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', modelSource: 'default', effortSource: 'task', held: true, missing: ['model'] });
    // U is held for its model only; its effort is the task's `ultra`, run as `max`.
    expect(entryOf(h, 'U')).toMatchObject({ effort: 'max', effortSource: 'task', modelSource: 'default', held: true, missing: ['model'] });
    expect(digestOf(h.orch)['profileHeld']).toEqual([{ runner: 'claude-code', missing: ['model'], tasks: 2 }]);
  });

  it('criterion 8: a task that still waits on a dependency counts', async () => {
    const h = harness(graphOf(task('T1', BOTH), task('T2', '', ['T1'])));
    await h.orch.tick();
    expect(h.statusOf('T1')).toBe('running');
    const s = h.orch.status();
    const held = s.profiles.find((p) => p.held);
    expect(held?.sample).toContain('T2');
    expect(s.profiles.some((p) => p.sample.includes('T1'))).toBe(false);
    const digest = digestOf(h.orch)['profileHeld'] as Array<{ tasks: number }>;
    expect(digest[0]?.tasks).toBe(1);
  });

  it('criterion 9: only admission is held: a resume and a live launch go on; a retry waits for both keys', async () => {
    const h = harness(graphOf(task('W'), task('F')));
    expect(h.orch.setConfig({ model: 'claude-opus-5-5', effort: 'medium' })).toMatchObject({ ok: true });
    await h.orch.tick();
    const fLaunch = h.launchOf('F').launchId;
    void h.block('W', 'which way?');
    await new Promise((r) => setTimeout(r, 10));
    expect(h.statusOf('W')).toBe('waiting');

    expect(h.orch.setConfig({ model: null, effort: null })).toMatchObject({ ok: true });
    expect(h.orch.status().config.model.source).toBe('default');
    expect(h.orch.answer('W', 'left')).toEqual({ ok: true });
    await h.orch.tick();
    expect(h.statusOf('W')).toBe('running');
    expect(h.store.listEvents({ kind: 'transition', taskId: 'W' }).some((e) => e.payload?.['trigger'] === 'resumed')).toBe(true);
    // The launch prepared before the clearing stays live through the tick.
    expect(h.launchOf('F').launchId).toBe(fLaunch);
    expect(h.store.getLaunch(fLaunch)?.status).toBe('live');

    // A retry comes from admission and is held like a first launch.
    await h.failTask('F', 'first try');
    expect(h.statusOf('F')).toBe('unstarted');
    await h.orch.tick();
    expect(launches(h, 'F')).toHaveLength(1);
    expect(entryOf(h, 'F')).toMatchObject({ held: true, missing: ['model', 'effort'] });
    expect(h.orch.setConfig({ model: 'claude-opus-5-5' })).toMatchObject({ ok: true });
    await h.orch.tick();
    expect(launches(h, 'F')).toHaveLength(1);
    expect(h.orch.setConfig({ effort: 'medium' })).toMatchObject({ ok: true });
    await h.orch.tick();
    expect(launches(h, 'F')).toHaveLength(2);
    expect(h.launchOf('F').attempt).toBe(2);
  });

  it('criterion 10: a file value confirms', async () => {
    const h = harness(graphOf(task('A')), { runner: { confirmProfile: true, claude: { model: 'claude-sonnet-5-5', effort: 'high' } } });
    await h.orch.loadGraph();
    expect(entryOf(h, 'A')).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', modelSource: 'file', effortSource: 'file', held: false, missing: [] });
    await h.orch.tick();
    expect(h.launchOf('A')).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
  });

  it('criterion 11: a key the template does not apply does not hold in spawn mode; pull and mixed ignore the slot', async () => {
    const spawn = harness(graphOf(task('A')), { runnerCommand: NO_SLOTS, runner: { mode: 'spawn', confirmProfile: true } });
    await spawn.orch.loadGraph();
    expect(spawn.orch.status().config.model.applied).toBe(false);
    expect(entryOf(spawn, 'A')).toMatchObject({ modelSource: 'default', effortSource: 'default', held: false, missing: [] });
    await spawn.orch.tick();
    expect(launches(spawn, 'A')).toHaveLength(1);

    for (const mode of ['pull', 'mixed'] as const) {
      const h = harness(graphOf(task('A')), { runnerCommand: NO_SLOTS, runner: { mode, confirmProfile: true } });
      await h.orch.tick();
      expect(launches(h, 'A')).toEqual([]);
      expect(entryOf(h, 'A')).toMatchObject({ held: true, missing: ['model', 'effort'] });
      if (mode === 'pull') {
        // The mode is read every time the rule is evaluated.
        h.orch.setMode('spawn');
        expect(entryOf(h, 'A')).toMatchObject({ held: false, missing: [] });
        await h.orch.tick();
        expect(launches(h, 'A')).toHaveLength(1);
      }
    }
  });

  it('criterion 12: the stored choice is read before the configuration', async () => {
    const on = harness(graphOf(task('A')), { runner: { confirmProfile: false } });
    on.store.setKv('runner.confirmProfile', 'on');
    await on.orch.tick();
    expect(launches(on, 'A')).toEqual([]);
    expect(on.orch.status().runner.confirmProfile).toBe(true);
    expect(entryOf(on, 'A')).toMatchObject({ held: true });

    const off = harness(graphOf(task('A')), { runner: { confirmProfile: true } });
    off.store.setKv('runner.confirmProfile', 'off');
    await off.orch.tick();
    expect(launches(off, 'A')).toHaveLength(1);
    expect(off.orch.status().runner.confirmProfile).toBe(false);

    // Any other stored value falls back to the configuration.
    const other = harness(graphOf(task('A')), { runner: { confirmProfile: true } });
    other.store.setKv('runner.confirmProfile', 'maybe');
    expect(other.orch.confirmProfile()).toBe(true);
  });

  it('criterion 13: status.profiles groups and orders, with at most five ids per entry', async () => {
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
    const h = harness(graphOf(task('S', 'model: claude-sonnet-5-5'), ...ids.map((id) => task(id))), {});
    await h.orch.loadGraph();
    let s = h.orch.status();
    expect(s.profiles).toHaveLength(2);
    expect(s.profiles[0]).toMatchObject({ tasks: 1, sample: ['S'], model: 'claude-sonnet-5-5', modelSource: 'task', effortSource: 'default' });
    expect(s.profiles[1]).toMatchObject({ tasks: 6, sample: ids.slice(0, 5), modelSource: 'default', effortSource: 'default' });

    // A task that has a launch is in no entry.
    const h1 = harness(graphOf(task('S', 'model: claude-sonnet-5-5'), ...ids.map((id) => task(id))), { capacity: 1 });
    await h1.orch.tick();
    expect(h1.launchOf('S')).toBeDefined();
    s = h1.orch.status();
    expect(s.profiles).toHaveLength(1);
    expect(s.profiles[0]).toMatchObject({ tasks: 6, sample: ids.slice(0, 5) });
  });
});
