/**
 * Scripted test agent. Runs as a real subprocess in a launch worktree.
 * Behaviour comes from the task payload's `behavior` field (see tasks 3.10).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface Brief {
  launchId: string;
  taskId: string;
  token: string;
  apiBaseUrl: string;
  worktree: string;
  branch: string;
  baseSha: string;
  retryWindowMs: number;
  fallbackPath: string;
  attempt: number;
  launchNo: number;
  task: Record<string, unknown>;
  acceptanceCriteria: string[];
  context?: Record<string, unknown>;
}

const briefPath = process.argv[2] ?? path.join(process.cwd(), '.orchestrator', 'brief.json');
const brief = JSON.parse(readFileSync(briefPath, 'utf8')) as Brief;
const cwd = brief.worktree;
const behaviorRaw = String(brief.task['behavior'] ?? 'commitAndSubmit');
const [behavior, param] = behaviorRaw.split(':') as [string, string | undefined];
let seq = 0;

function pidlog(event: string): void {
  const f = process.env['ORCH_PIDLOG'];
  if (f) appendFileSync(f, `${process.pid} ${brief.launchId} ${brief.taskId} ${event} ${Date.now()}\n`);
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'agent', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'agent', GIT_COMMITTER_EMAIL: 'a@x' } });
}

function writeAndCommit(file = `${brief.taskId}.txt`, content = `${brief.taskId} launch ${brief.launchNo} attempt ${brief.attempt}\n`): void {
  writeFileSync(path.join(cwd, file), content);
  git('add', '-A', '--', '.');
  git('commit', '-q', '-m', `${brief.taskId}: ${file}`);
}

async function api(op: string, body: Record<string, unknown> = {}, method = 'POST'): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `${brief.apiBaseUrl}/v1/launches/${brief.launchId}/${op}`;
  const deadline = Date.now() + brief.retryWindowMs;
  let delay = 50;
  for (;;) {
    try {
      const res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${brief.token}`, 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (res.status === 401) {
        pidlog('got401');
        if (behavior !== 'ignore401') {
          process.exit(3);
        }
      }
      return { status: res.status, body: json };
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, 1000);
    }
  }
}

function submitBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: ++seq,
    kind: 'submit',
    summary: `${brief.taskId} done by scripted agent (launch ${brief.launchNo})`,
    acceptance: brief.acceptanceCriteria.map((c) => ({ criterion: c, evidence: `checked ${c}` })),
    ...extra,
  };
}

function writeFallback(kind: 'submit' | 'fail' | 'block', body: Record<string, unknown>): void {
  writeFileSync(brief.fallbackPath, JSON.stringify({ launchId: brief.launchId, seq: ++seq, kind, body }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  pidlog('start');
  switch (behavior) {
    case 'commitAndSubmit': {
      writeAndCommit();
      await api('report', submitBody());
      break;
    }
    case 'slowSubmit': {
      await sleep(Number(param ?? 1500));
      writeAndCommit();
      await api('report', submitBody());
      break;
    }
    case 'heartbeatThenSubmit': {
      const until = Date.now() + Number(param ?? 1000);
      while (Date.now() < until) {
        await api('heartbeat', { progress: 'working' });
        await sleep(100);
      }
      writeAndCommit();
      await api('report', submitBody());
      break;
    }
    case 'submitDirtyThenFix': {
      writeFileSync(path.join(cwd, `${brief.taskId}.txt`), 'dirty\n');
      const first = await api('report', submitBody());
      if (first.status !== 409) throw new Error(`expected 409, got ${first.status}`);
      git('add', '-A', '--', '.');
      git('commit', '-q', '-m', 'fix');
      // Same seq: a 409 is not deduplicated, so the retry is re-evaluated.
      await api('report', { ...submitBody(), seq });
      break;
    }
    case 'submitNoEvidence': {
      writeAndCommit();
      await api('report', submitBody({ acceptance: [] }));
      break;
    }
    case 'fail': {
      await api('report', { seq: ++seq, kind: 'fail', tried: 'x', why: param ?? 'scripted failure', whatWouldUnblock: 'y' });
      break;
    }
    case 'blockThenExit': {
      writeFallback('block', { kind: 'needsAccess', message: 'need credentials' });
      break;
    }
    case 'blockAndWait': {
      const carried = brief.context?.['answer'];
      if (carried !== undefined) {
        writeAndCommit(`${brief.taskId}.txt`, `answer: ${String(carried)}\n`);
        await api('report', submitBody());
        break;
      }
      const res = await api('block', { seq: ++seq, kind: 'needsDecision', message: param ?? 'which option?', options: ['a', 'b'] });
      if (res.body['timeout']) {
        pidlog('timeout');
        break;
      }
      writeAndCommit(`${brief.taskId}.txt`, `answer: ${String(res.body['answer'])}\n`);
      await api('report', submitBody());
      break;
    }
    case 'proposeThenSubmit': {
      writeAndCommit();
      const count = Number(param ?? 2);
      const proposals = Array.from({ length: count }, (_, i) => ({
        title: `Follow-up ${i + 1} from ${brief.taskId}`,
        description: `Follow-up work discovered while doing ${brief.taskId}.`,
        acceptanceCriteria: [`follow-up ${i + 1} works`],
        ...(i === 0 ? { labels: ['follow-up'] } : {}),
      }));
      await api('report', submitBody({ proposals }));
      break;
    }
    case 'rebaseThenSubmit': {
      // Commit, wait for a baseMoved notice, rebase onto the new head, commit again, submit.
      writeAndCommit();
      const deadline = Date.now() + Number(param ?? 10000);
      let head: string | undefined;
      while (!head && Date.now() < deadline) {
        const r = await api('inbox', {}, 'GET');
        const notices = (r.body['notices'] as Array<{ kind: string; head?: string }> | undefined) ?? [];
        head = notices.find((n) => n.kind === 'baseMoved')?.head;
        if (!head) await sleep(100);
      }
      if (!head) throw new Error('no baseMoved notice arrived');
      git('rebase', head);
      writeAndCommit(`${brief.taskId}-after.txt`, `after rebase onto ${head}\n`);
      await api('report', submitBody());
      break;
    }
    case 'hang': {
      // A pending promise alone does not keep Node alive; hold a timer.
      await new Promise(() => setInterval(() => undefined, 1 << 30));
      break;
    }
    case 'exitSilently':
      break;
    case 'noopDeclared': {
      await api('report', submitBody({ noChanges: { justification: 'nothing to change' } }));
      break;
    }
    case 'noopUndeclared': {
      await api('report', submitBody());
      break;
    }
    case 'conflictWith': {
      writeAndCommit(param ?? 'shared.txt', `line from ${brief.taskId} launch ${brief.launchNo}\n`);
      await api('report', submitBody());
      break;
    }
    case 'offlineSubmit': {
      writeAndCommit();
      writeFallback('submit', { summary: 'offline submission', acceptance: brief.acceptanceCriteria.map((c) => ({ criterion: c, evidence: 'e' })) });
      break;
    }
    case 'ignore401': {
      writeAndCommit();
      for (let i = 0; i < 15; i++) {
        writeAndCommit(`${brief.taskId}-${i}.txt`, `${i}\n`);
        await api('report', submitBody());
        await sleep(200);
      }
      break;
    }
    default:
      throw new Error(`unknown behavior ${behaviorRaw}`);
  }
  pidlog('exit');
}

main().catch((err) => {
  pidlog(`error ${String(err).replace(/\s+/g, ' ')}`);
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
