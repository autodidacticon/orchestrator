/**
 * Process ancestry, for session attachments: a process and its parents up to a
 * few levels (never pid 1), and the rule that matches a session end's chain to an
 * attachment's chain by their nearest shared pid. See specs/operator-control
 * "Session attachments".
 */
import { execFile } from 'node:child_process';

/** `[pid, ppid, ...]` walked with `ps -o ppid=`, stopping before pid 1 (never in the chain), at an unknown pid, the level cap, or the deadline. */
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
    if (parent === undefined || parent <= 1 || chain.includes(parent)) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/**
 * Whether a session end's chain (`ended`: the hook's own pid, then its ancestors) ends an attachment whose chain is
 * `attachment`. The nearest pid of `ended` that is also in `attachment`, never counting pid 1, must be the hook's
 * parent or grandparent (`ended[1]` or `ended[2]`). A session nested under a shell or another process further down
 * shares a farther pid with its outer session, so the outer session stays attached.
 */
export function sessionEndMatches(ended: readonly number[], attachment: readonly number[]): boolean {
  const nearest = ended.findIndex((p) => p !== 1 && attachment.includes(p));
  return nearest === 1 || nearest === 2;
}
