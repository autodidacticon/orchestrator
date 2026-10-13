/**
 * Process ancestry, for session attachments: a process and its parents up to a
 * few levels, so a session end can be matched by any pid in the chain. See
 * specs/operator-control "Session attachments".
 */
import { execFile } from 'node:child_process';

/** `[pid, ppid, ...]` walked with `ps -o ppid=`, stopping at pid 1, an unknown pid, the level cap, or the deadline. */
export async function ancestorPids(pid: number, opts: { levels?: number; timeoutMs?: number } = {}): Promise<number[]> {
  const levels = opts.levels ?? 6;
  const deadline = Date.now() + (opts.timeoutMs ?? 300);
  const chain = [pid];
  let current = pid;
  for (let i = 0; i < levels; i++) {
    if (current <= 1) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const parent = await new Promise<number | undefined>((resolve) => {
      execFile('ps', ['-o', 'ppid=', '-p', String(current)], { timeout: remaining }, (err, stdout) => {
        if (err) return resolve(undefined);
        const n = Number(String(stdout).trim());
        resolve(Number.isInteger(n) && n > 0 ? n : undefined);
      });
    });
    if (parent === undefined || chain.includes(parent)) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}
