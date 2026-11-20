import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InprocRunner } from '../../src/runner/inproc.js';
import { MultiRunner } from '../../src/runner/multi.js';
import { killTrees } from '../../src/runner/subprocess.js';
import type { Launch } from '../../src/state/store.js';

// See specs/health-monitoring "Usage accounting: launches reaped together".
const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const p of pids.splice(0)) {
    try {
      process.kill(-p, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A detached `/bin/sh -c` that stays the parent of a node child running `script`, as SubprocessRunner.spawn starts a launch. */
async function start(script: string): Promise<{ pid: number; dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-reapall-'));
  dirs.push(dir);
  const file = path.join(dir, 'child.cjs');
  writeFileSync(file, script);
  const child = spawn('/bin/sh', ['-c', `${q(process.execPath)} ${q(file)} ${q(dir)}; :`], { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid!;
  pids.push(pid);
  const ready = path.join(dir, 'ready');
  for (let i = 0; i < 200 && !existsSync(ready); i++) await sleep(25);
  expect(existsSync(ready)).toBe(true);
  return { pid, dir };
}

function groupGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

const IGNORES_TERM = `
const fs = require('node:fs'); const path = require('node:path'); const dir = process.argv[2];
process.on('SIGTERM', () => { fs.writeFileSync(path.join(dir, 'term'), String(Date.now())); });
fs.writeFileSync(path.join(dir, 'ready'), 'x');
setInterval(() => {}, 1000);
`;

describe('killTrees', () => {
  it('signals five groups that ignore SIGTERM together and waits once for all of them', async () => {
    const groups = await Promise.all([1, 2, 3, 4, 5].map(() => start(IGNORES_TERM)));
    const t0 = Date.now();
    await killTrees(
      groups.map((g) => g.pid),
      500,
    );
    const took = Date.now() - t0;
    const terms = groups.map((g) => Number(readFileSync(path.join(g.dir, 'term'), 'utf8')));
    expect(Math.max(...terms) - Math.min(...terms)).toBeLessThan(500);
    expect(took).toBeGreaterThanOrEqual(500);
    expect(took).toBeLessThan(2000);
    for (const g of groups) expect(groupGone(g.pid)).toBe(true);
  });

  it('waits for a group that exits 300 ms after SIGTERM and kills one that ignores it', async () => {
    const exits = await start(`
const fs = require('node:fs'); const path = require('node:path'); const dir = process.argv[2];
process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(path.join(dir, 'marker'), 'x'); process.exit(0); }, 300));
fs.writeFileSync(path.join(dir, 'ready'), 'x');
setInterval(() => {}, 1000);
`);
    const ignores = await start(IGNORES_TERM);
    const t0 = Date.now();
    await killTrees([exits.pid, ignores.pid], 1000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(existsSync(path.join(exits.dir, 'marker'))).toBe(true);
    expect(groupGone(exits.pid)).toBe(true);
    expect(groupGone(ignores.pid)).toBe(true);
  });

  it('returns at once with no pid, a dead pid, or a pid listed twice', async () => {
    await killTrees([], 500);
    const g = await start(`
const fs = require('node:fs'); const path = require('node:path');
fs.writeFileSync(path.join(process.argv[2], 'ready'), 'x');
setInterval(() => {}, 1000);
`);
    await killTrees([g.pid, g.pid], 500);
    expect(groupGone(g.pid)).toBe(true);
    const t0 = Date.now();
    await killTrees([g.pid], 500);
    expect(Date.now() - t0).toBeLessThan(250);
  });
});

function launch(launchId: string, runner?: Launch['runner']): Launch {
  return { launchId, taskId: `T-${launchId}`, attempt: 1, launchNo: 1, status: 'launching', token: launchId, branch: 'b', worktree: '/w', baseSha: 'a', graphRev: 'r', createdAt: 0, ...(runner ? { runner } : {}) };
}

describe('MultiRunner.reapAll', () => {
  it("hands each registered kind its own launches in one call and skips a kind with no runner", async () => {
    const claude = new InprocRunner();
    const codex = new InprocRunner();
    const multi = new MultiRunner({ 'claude-code': claude, codex });
    const ls = [launch('a', 'claude-code'), launch('b', 'codex'), launch('c', 'claude-code'), launch('d', 'opencode')];
    for (const l of ls.slice(0, 3)) await multi.spawn(l, {});
    const calls: Record<string, string[][]> = { claude: [], codex: [] };
    const origClaude = claude.reapAll.bind(claude);
    const origCodex = codex.reapAll.bind(codex);
    claude.reapAll = async (xs) => {
      calls['claude']!.push(xs.map((l) => l.launchId));
      await origClaude(xs);
    };
    codex.reapAll = async (xs) => {
      calls['codex']!.push(xs.map((l) => l.launchId));
      await origCodex(xs);
    };
    await expect(multi.reapAll(ls)).resolves.toBeUndefined();
    expect(calls['claude']).toEqual([['a', 'c']]);
    expect(calls['codex']).toEqual([['b']]);
    expect(claude.isAlive('a')).toBe(false);
    expect(claude.isAlive('c')).toBe(false);
    expect(codex.isAlive('b')).toBe(false);
  });

  it('rejects with a kind\'s error only after every other kind has settled', async () => {
    const claude = new InprocRunner();
    const codex = new InprocRunner();
    const multi = new MultiRunner({ 'claude-code': claude, codex });
    let claudeDone = false;
    claude.reapAll = async () => {
      await sleep(100);
      claudeDone = true;
    };
    codex.reapAll = async () => {
      throw new Error('codex reap failed');
    };
    const p = multi.reapAll([launch('a', 'claude-code'), launch('b', 'codex')]);
    let settledAt: boolean | undefined;
    await expect(
      p.catch((err: unknown) => {
        settledAt = claudeDone;
        throw err;
      }),
    ).rejects.toThrow('codex reap failed');
    expect(settledAt).toBe(true);
  });
});
