import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killTree } from '../../src/runner/subprocess.js';

// See specs/health-monitoring "Usage accounting": a reap waits for the launch's process group.
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
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-kill-'));
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

describe('killTree', () => {
  it('waits for a child that writes a marker 300 ms after SIGTERM', async () => {
    const { pid, dir } = await start(`
const fs = require('node:fs'); const path = require('node:path'); const dir = process.argv[2];
process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(path.join(dir, 'marker'), 'x'); process.exit(0); }, 300));
fs.writeFileSync(path.join(dir, 'ready'), 'x');
setInterval(() => {}, 1000);
`);
    await killTree(pid, 2000);
    expect(existsSync(path.join(dir, 'marker'))).toBe(true);
    expect(() => process.kill(-pid, 0)).toThrow();
  });

  it('kills a child that ignores SIGTERM after the grace and leaves no process of the group', async () => {
    const { pid, dir } = await start(`
const fs = require('node:fs'); const path = require('node:path'); const dir = process.argv[2];
process.on('SIGTERM', () => {});
fs.writeFileSync(path.join(dir, 'ready'), 'x');
setInterval(() => {}, 1000);
`);
    const t0 = Date.now();
    await killTree(pid, 300);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(groupGone(pid)).toBe(true);
  });
});
