import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs host script without type declarations
import { parseWorkArgs, stopVerdict } from '../../hosts/codex/bin/work.mjs';

/** A status whose only verdict-bearing field is workByKind; the older fields say "quiet, nothing to do". */
function statusWith(verdicts: Record<string, string>, extra: Record<string, unknown> = {}) {
  const workByKind: Record<string, unknown> = {};
  for (const kind of ['claude-code', 'codex', 'opencode']) {
    workByKind[kind] = { verdict: verdicts[kind] ?? 'idle', claimable: 0, preparing: 0, working: 0 };
  }
  return {
    finished: false,
    stalled: false,
    paused: false,
    claimableByKind: { 'claude-code': 0, codex: 0, opencode: 0 },
    preparingByKind: { 'claude-code': 0, codex: 0, opencode: 0 },
    liveLaunches: [],
    verifying: [],
    openQuestions: [],
    awaitingReview: [],
    workByKind,
    ...extra,
  };
}

describe('stopVerdict reads workByKind.<kind>.verdict', () => {
  it('finished, stalled and human stop with today\'s sentences', () => {
    expect(stopVerdict(statusWith({ codex: 'finished' }), undefined, 0, 1000, 'codex')).toEqual({ stop: true, why: 'the run is finished' });
    expect(stopVerdict(statusWith({ codex: 'stalled' }), undefined, 0, 1000, 'codex')).toEqual({ stop: true, why: 'the run is stalled' });
    expect(stopVerdict(statusWith({ codex: 'human' }), undefined, 0, 1000, 'codex')).toEqual({
      stop: true,
      why: 'nothing is claimable for codex and the run waits on a human',
    });
  });

  it('idle is quiet before the idle limit and stops at it', () => {
    const s = statusWith({ codex: 'idle' });
    expect(stopVerdict(s, undefined, 0, 1000, 'codex')).toEqual({ stop: false, quiet: true });
    expect(stopVerdict(s, 0, 999, 1000, 'codex')).toEqual({ stop: false, quiet: true });
    expect(stopVerdict(s, 0, 1000, 1000, 'codex')).toEqual({ stop: true, why: 'nothing claimable for codex for 1000ms' });
  });

  it('claim, standby, paused and an unknown word keep polling with the idle timer reset', () => {
    for (const v of ['claim', 'standby', 'paused', 'snoozing']) {
      expect(stopVerdict(statusWith({ codex: v }), 0, 10_000, 1000, 'codex')).toEqual({ stop: false, quiet: false });
    }
  });

  it('the verdict wins over the other fields', () => {
    // An open question, nothing claimable, nothing preparing, no live launch: the older rule would stop.
    const s = statusWith({ codex: 'standby' }, { openQuestions: ['T1'] });
    expect(stopVerdict(s, 0, 10_000, 1000, 'codex')).toEqual({ stop: false, quiet: false });
    // And a finished flag the verdict does not carry is not read.
    expect(stopVerdict({ ...s, finished: true }, 0, 10_000, 1000, 'codex')).toEqual({ stop: false, quiet: false });
  });

  it('a loop started with --runner opencode reads workByKind.opencode', () => {
    const kind = parseWorkArgs(['--runner', 'opencode']).runner;
    expect(kind).toBe('opencode');
    const s = statusWith({ codex: 'standby', opencode: 'human' });
    expect(stopVerdict(s, undefined, 0, 1000, kind)).toEqual({ stop: true, why: 'nothing is claimable for opencode and the run waits on a human' });
    expect(stopVerdict(statusWith({ codex: 'finished', opencode: 'claim' }), undefined, 0, 1000, kind)).toEqual({ stop: false, quiet: false });
  });

  it('a status without the kind\'s verdict goes through the older rule', () => {
    const s = { ...statusWith({}), workByKind: { codex: { claimable: 0 } }, openQuestions: ['T1'] };
    expect(stopVerdict(s, undefined, 0, 1000, 'codex')).toEqual({ stop: true, why: 'nothing is claimable for codex and the run waits on a human' });
    const { workByKind: _w, ...older } = statusWith({});
    expect(stopVerdict({ ...older, liveLaunches: [{ runner: 'codex' }] }, 0, 10_000, 1000, 'codex')).toEqual({ stop: false, quiet: false });
  });
});
