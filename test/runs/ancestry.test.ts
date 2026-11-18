import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ancestorPids } from '../../src/runs/ancestry.js';

describe('process ancestry', () => {
  it('starts with the pid and its parent, and is capped at the level count', async () => {
    const chain = await ancestorPids(process.pid);
    expect(chain[0]).toBe(process.pid);
    expect(chain[1]).toBe(process.ppid);
    expect(chain.length).toBeLessThanOrEqual(7);
    expect(new Set(chain).size).toBe(chain.length);
    expect(await ancestorPids(process.pid, { levels: 1 })).toEqual([process.pid, process.ppid]);
  });

  it('walks to the top of the tree and stops before pid 1', async () => {
    const chain = await ancestorPids(process.pid, { levels: 256, timeoutMs: 20_000 });
    expect(chain[0]).toBe(process.pid);
    expect(chain).not.toContain(1);
    // The walk reached the top: the last pid's parent is pid 1, which the chain leaves out.
    const top = chain[chain.length - 1]!;
    expect(Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(top)]).toString().trim())).toBeLessThanOrEqual(1);
  });

  it('returns only the pid for a process that does not exist', async () => {
    expect(await ancestorPids(999_999)).toEqual([999_999]);
  });
});
