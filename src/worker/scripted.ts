/**
 * The scripted agent of the remote worker loop (`ORCH_WORKER_AGENT=scripted`): a deterministic stand-in for a model,
 * ported from the scripted pull worker in test/agents/worker.ts. It appends one line naming the task to `README.md`,
 * commits on the launch branch, pushes the branch to origin, and submits with `sealedSha` and one evidence entry per
 * acceptance criterion, by position. It ships in the image so the cluster smoke test needs no model.
 * See specs/worker-pool "Scripted agent".
 */
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gitOut } from './clone.js';
import type { ApiCall, ApiResult } from './http.js';

export interface AgentLaunch {
  launchId: string;
  taskId: string;
  token: string;
  branch: string;
  /** The criteria of the brief, in order. */
  acceptanceCriteria: string[];
}

export interface ScriptedAgentContext {
  call: ApiCall;
  launch: AgentLaunch;
  clone: string;
  workerId: string;
  sleep: (ms: number) => Promise<void>;
  /** A silent step before the agent starts: it sleeps this long without calling the API (tests of the loop's heartbeat). */
  idleMs?: number;
}

/** The identity the scripted agent commits as. */
export const SCRIPTED_IDENTITY = { GIT_AUTHOR_NAME: 'orchestrator-worker', GIT_AUTHOR_EMAIL: 'worker@orchestrator.local', GIT_COMMITTER_NAME: 'orchestrator-worker', GIT_COMMITTER_EMAIL: 'worker@orchestrator.local' };

/** The line the scripted agent appends to README.md. */
export const scriptedLine = (taskId: string, workerId: string): string => `- ${taskId} by worker ${workerId}`;

/** Submit attempts while origin cannot be fetched (503): the seal recorded nothing, so the same seq is sent again. */
const SUBMIT_ATTEMPTS = 5;

/** Run the scripted agent in `clone`. Answers the last submit response, or undefined when a call answered 401 (the launch ended). */
export async function runScriptedAgent(ctx: ScriptedAgentContext): Promise<ApiResult | undefined> {
  const { launch, clone } = ctx;
  const env = { ...process.env, ...SCRIPTED_IDENTITY };
  if (ctx.idleMs && ctx.idleMs > 0) await ctx.sleep(ctx.idleMs);
  const readme = path.join(clone, 'README.md');
  const text = await readFile(readme, 'utf8').catch(() => '');
  await appendFile(readme, `${text && !text.endsWith('\n') ? '\n' : ''}${scriptedLine(launch.taskId, ctx.workerId)}\n`);
  await gitOut(clone, ['add', '--', 'README.md'], env);
  await gitOut(clone, ['commit', '-q', '-m', `${launch.taskId}: README line`], env);
  // The launch branch belongs to this launch alone; a re-run after a repeated claim replaces what an earlier run pushed.
  await gitOut(clone, ['push', '-q', '--force', 'origin', `HEAD:refs/heads/${launch.branch}`], env);
  const sealedSha = await gitOut(clone, ['rev-parse', 'HEAD']);
  const acceptance = launch.acceptanceCriteria.map((c, i) => ({ criterion: String(i + 1), evidence: `scripted agent: appended a README line for ${launch.taskId} (criterion ${i + 1}: ${c})` }));
  let res: ApiResult | undefined;
  for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt++) {
    res = await ctx.call('POST', `/v1/launches/${launch.launchId}/report`, { seq: 1, kind: 'submit', summary: `${launch.taskId} done by scripted worker ${ctx.workerId}`, sealedSha, acceptance }, launch.token);
    if (res.status === 401) return undefined;
    if (res.status !== 503) return res;
    await ctx.sleep(1000 * (attempt + 1));
  }
  return res;
}
