import { describe, expect, it } from 'vitest';
import { InprocRunner } from '../../src/runner/inproc.js';
import { MultiRunner } from '../../src/runner/multi.js';
import type { Launch } from '../../src/state/store.js';

// See specs/worker-runners "Runner dispatch by launch kind".
function launch(launchId: string, runner?: Launch['runner']): Launch {
  return { launchId, taskId: `T-${launchId}`, attempt: 1, launchNo: 1, status: 'launching', token: launchId, branch: 'b', worktree: '/w', baseSha: 'a', graphRev: 'r', createdAt: 0, ...(runner ? { runner } : {}) };
}

describe('MultiRunner', () => {
  it('routes spawn, liveness, reap, and readUsage by the kind on the launch row', async () => {
    const claude = new InprocRunner();
    const codex = new InprocRunner();
    const multi = new MultiRunner({ 'claude-code': claude, codex });
    const a = launch('a', 'claude-code');
    const b = launch('b', 'codex');
    await multi.spawn(a, {});
    await multi.spawn(b, {});
    expect(claude.spawned.map((l) => l.launchId)).toEqual(['a']);
    expect(codex.spawned.map((l) => l.launchId)).toEqual(['b']);
    expect(await multi.liveness(a)).toBe('alive');
    expect(await multi.alive(b)).toBe(true);

    claude.usageScript.set('a', { costUsd: 1 });
    codex.usageScript.set('b', { costUsd: 2 });
    expect(await multi.readUsage(a)).toEqual({ costUsd: 1 });
    expect(await multi.readUsage(b)).toEqual({ costUsd: 2 });

    await multi.reap(b);
    expect(codex.isAlive('b')).toBe(false);
    expect(claude.isAlive('a')).toBe(true);
    expect(await multi.liveness(b)).toBe('dead');
  });

  it('treats a row without a kind as claude-code', async () => {
    const claude = new InprocRunner();
    const codex = new InprocRunner();
    const multi = new MultiRunner({ 'claude-code': claude, codex });
    const old = launch('old');
    await multi.spawn(old, {});
    expect(claude.spawned.map((l) => l.launchId)).toEqual(['old']);
    expect(codex.spawned).toEqual([]);
    claude.usageScript.set('old', { turns: 3 });
    expect(await multi.readUsage(old)).toEqual({ turns: 3 });
  });

  it('fans killByLaunchId out to every registered runner', async () => {
    const claude = new InprocRunner();
    const codex = new InprocRunner();
    const multi = new MultiRunner({ 'claude-code': claude, codex });
    await multi.spawn(launch('a', 'claude-code'), {});
    await multi.spawn(launch('b', 'codex'), {});
    const killed: string[] = [];
    const origClaude = claude.killByLaunchId.bind(claude);
    const origCodex = codex.killByLaunchId.bind(codex);
    claude.killByLaunchId = async (id) => {
      killed.push(`claude-code:${id}`);
      await origClaude(id);
    };
    codex.killByLaunchId = async (id) => {
      killed.push(`codex:${id}`);
      await origCodex(id);
    };
    await multi.killByLaunchId('b');
    expect(killed.sort()).toEqual(['claude-code:b', 'codex:b']);
    expect(codex.isAlive('b')).toBe(false);
    expect(claude.isAlive('a')).toBe(true);
  });

  it('fails a spawn for a kind with no runner, naming the kind', async () => {
    const multi = new MultiRunner({ 'claude-code': new InprocRunner() });
    await expect(multi.spawn(launch('c', 'codex'), {})).rejects.toThrow(/no runner is registered for kind codex/);
    // Nothing to observe or read for that kind.
    expect(await multi.liveness(launch('c', 'codex'))).toBe('unknown');
    expect(await multi.readUsage(launch('c', 'codex'))).toBeUndefined();
  });
});
