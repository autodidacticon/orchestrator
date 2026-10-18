import { describe, expect, it } from 'vitest';
import { foldRunnerArgs } from '../../src/runs/resolve.js';
import { RUNNER_KINDS, zeroByKind } from '../../src/runner/selection.js';

// specs/operator-control "Configuration route": a key cleared and set in one call is refused, not folded.
describe('foldRunnerArgs', () => {
  it('folds --sandbox under codex and --commit under the kind in force or the runnerKind of the call', () => {
    expect(foldRunnerArgs({ sandbox: 'read-only' }, 'claude-code')).toEqual({ codex: { sandbox: 'read-only' } });
    expect(foldRunnerArgs({ commit: 'daemon' }, 'claude-code')).toEqual({ claude: { commit: 'daemon' } });
    expect(foldRunnerArgs({ commit: 'daemon', runnerKind: 'codex' }, 'claude-code')).toEqual({ runnerKind: 'codex', codex: { commit: 'daemon' } });
    expect(foldRunnerArgs({ codex: { model: 'gpt-6-pro' }, sandbox: 'read-only' }, 'codex')).toEqual({ codex: { model: 'gpt-6-pro', sandbox: 'read-only' } });
  });

  it('refuses a namespace cleared and a leaf set into it in the same call', () => {
    expect(() => foldRunnerArgs({ codex: null, sandbox: 'read-only' }, 'codex')).toThrow(/codex is cleared and codex\.sandbox is set/);
    expect(() => foldRunnerArgs({ claude: null, commit: 'daemon' }, 'claude-code')).toThrow(/claude is cleared and claude\.commit is set/);
  });

  it('refuses a leaf both cleared and set in the same call, and keeps a clear of another leaf', () => {
    expect(() => foldRunnerArgs({ codex: { sandbox: null }, sandbox: 'read-only' }, 'codex')).toThrow(/codex\.sandbox is both cleared and set/);
    expect(foldRunnerArgs({ codex: { model: null }, sandbox: 'read-only' }, 'codex')).toEqual({ codex: { model: null, sandbox: 'read-only' } });
  });
});

describe('zeroByKind', () => {
  it('names every runner kind at zero, in RUNNER_KINDS order', () => {
    expect(Object.keys(zeroByKind())).toEqual([...RUNNER_KINDS]);
    expect(Object.values(zeroByKind()).every((n) => n === 0)).toBe(true);
  });
});
