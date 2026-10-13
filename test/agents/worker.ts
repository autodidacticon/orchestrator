/**
 * Scripted pull worker. Loops claim -> commit -> submit over HTTP with a fixed
 * worker id, retrying connection failures through daemon restarts, re-claiming
 * after a 401, and exiting when the run is finished or stalled.
 * Env: ORCH_API, ORCH_WORKER_ID, ORCH_RETRY_WINDOW_MS (default 60000), ORCH_WORKER_LOG.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const api = process.env['ORCH_API'] ?? '';
const workerId = process.env['ORCH_WORKER_ID'] ?? `w-${process.pid}`;
const retryWindowMs = Number(process.env['ORCH_RETRY_WINDOW_MS'] ?? 60_000);
const workSleepMs = Number(process.env['ORCH_WORKER_SLEEP_MS'] ?? 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(line: string): void {
  const f = process.env['ORCH_WORKER_LOG'];
  if (f) appendFileSync(f, `${workerId} ${Date.now()} ${line}\n`);
}

async function http(method: 'GET' | 'POST', route: string, body?: Record<string, unknown>, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const deadline = Date.now() + retryWindowMs;
  let delay = 100;
  for (;;) {
    try {
      const res = await fetch(`${api}${route}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    } catch (err) {
      if (Date.now() + delay > deadline) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, 1000);
    }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'worker', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'worker', GIT_COMMITTER_EMAIL: 'w@x' } });
}

async function work(claim: Record<string, unknown>): Promise<void> {
  const launchId = String(claim['launchId']);
  const token = String(claim['token']);
  const taskId = String(claim['taskId']);
  const worktree = String(claim['worktree']);
  const brief = (claim['brief'] ?? {}) as { acceptanceCriteria?: string[] };
  log(`work ${taskId} ${launchId}`);
  if (workSleepMs > 0) await sleep(workSleepMs);
  writeFileSync(path.join(worktree, `${taskId}.txt`), `${taskId} by worker ${workerId}\n`);
  git(worktree, 'add', '-A', '--', '.');
  git(worktree, 'commit', '-q', '-m', `${taskId}: ${taskId}.txt`);
  const acceptance = (brief.acceptanceCriteria ?? []).map((c) => ({ criterion: c, evidence: `checked ${c}` }));
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await http('POST', `/v1/launches/${launchId}/report`, { seq: 1, kind: 'submit', summary: `${taskId} done by worker ${workerId}`, acceptance }, token);
    if (r.status === 409 && r.body['error'] === 'dirtyWorktree') {
      git(worktree, 'add', '-A', '--', '.');
      git(worktree, 'commit', '-q', '-m', 'fix');
      continue;
    }
    log(`report ${taskId} ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    return;
  }
}

async function main(): Promise<void> {
  log('start');
  for (;;) {
    const c = await http('POST', '/v1/claims', { workerId });
    if (c.status === 200) {
      try {
        await work(c.body);
      } catch (err) {
        // A vanished worktree or a fenced token: log it and claim again.
        log(`cycle error ${String(err).replace(/\s+/g, ' ').slice(0, 200)}`);
        await sleep(250);
      }
      continue;
    }
    if (c.status === 404) {
      const s = await http('GET', '/v1/status');
      if (s.body['finished'] === true || s.body['stalled'] === true) break;
    }
    await sleep(250);
  }
  log('exit');
}

main().catch((err) => {
  log(`error ${String(err).replace(/\s+/g, ' ')}`);
  process.exit(1);
});
