/**
 * Operator MCP server. See specs/operator-mcp. A stdio server a host session
 * runs; every tool forwards to the daemon's HTTP routes. Never opens the store.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { mapIssues, ImportError, importOptionsSchema, issueRecordSchema, trackerSchema } from '../import/mapping.js';
import { daemonState, listRuns, startDaemon, stopDaemon } from '../runs/lifecycle.js';
import { resolveRepoPath, runPaths } from '../runs/runDir.js';

/** The cap keeps every tool call under Claude Code's two-minute foreground limit; ORCH_WAIT_CAP_MS shortens it for tests. */
export const WAIT_CAP_MS = Number(process.env['ORCH_WAIT_CAP_MS'] ?? 90_000);
export const WAIT_DEFAULT_MS = Math.min(60_000, WAIT_CAP_MS);
/** Each daemon-side long-poll is shorter than the cap so a cancelled client never leaves a long server wait. */
const POLL_SLICE_MS = 20_000;

export const TOOL_NAMES = [
  'start', 'stop', 'status', 'runs', 'import_issues', 'import_graph', 'wait', 'review',
  'answer', 'cancel', 'reopen', 'unblock', 'accept', 'reject', 'pause', 'resume', 'logs',
  'outbox', 'ack', 'nudge', 'proposals', 'accept_proposal', 'reject_proposal',
  'claim', 'release', 'launch_heartbeat', 'launch_report', 'launch_block', 'launch_inbox', 'launch_log',
] as const;

export function clampWait(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return WAIT_DEFAULT_MS;
  return Math.max(0, Math.min(WAIT_CAP_MS, Math.floor(ms)));
}

export type Until = 'question' | 'review' | 'finished' | 'stalled' | 'any';

export function digestSatisfies(digest: Record<string, unknown>, until: Until | undefined, newEvents: number): boolean {
  switch (until) {
    case undefined:
    case 'any':
      return newEvents > 0;
    case 'question':
      return Array.isArray(digest['openQuestions']) && (digest['openQuestions'] as unknown[]).length > 0;
    case 'review':
      return Array.isArray(digest['awaitingReview']) && (digest['awaitingReview'] as unknown[]).length > 0;
    case 'finished':
      return digest['finished'] === true;
    case 'stalled':
      return digest['stalled'] === true;
  }
}

export interface OperatorContext {
  repo?: string;
  env: NodeJS.ProcessEnv;
}

export class OperatorClient {
  constructor(private readonly ctx: OperatorContext) {}

  async repo(): Promise<string> {
    return resolveRepoPath({ repo: this.ctx.repo, env: this.ctx.env });
  }

  async url(): Promise<string> {
    const repo = await this.repo();
    const paths = runPaths(repo, this.ctx.env);
    const state = await daemonState(paths.runDir);
    if (!state.healthy || !state.url) {
      throw new Error(`no running daemon for ${repo} (run dir ${paths.runDir}); call the start tool first`);
    }
    return state.url;
  }

  async call(method: 'GET' | 'POST' | 'PUT', route: string, body?: Record<string, unknown>, timeoutMs = 30_000, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const base = await this.url();
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async wait(opts: { afterSeq?: number; timeoutMs?: number; until?: Until }): Promise<{ status: number; body: Record<string, unknown> }> {
    const budget = clampWait(opts.timeoutMs);
    const deadline = Date.now() + budget;
    let after = opts.afterSeq;
    if (after === undefined) {
      const s = await this.call('GET', '/v1/status');
      after = Number(s.body['latestSeq'] ?? 0);
    }
    const collected: unknown[] = [];
    let seq = after;
    let digest: Record<string, unknown> = {};
    for (;;) {
      const remaining = deadline - Date.now();
      const slice = Math.max(0, Math.min(POLL_SLICE_MS, remaining));
      const r = await this.call('GET', `/v1/events?after=${seq}&wait=${slice}`, undefined, slice + 15_000);
      const events = (r.body['events'] as unknown[]) ?? [];
      collected.push(...events);
      seq = Number(r.body['seq'] ?? seq);
      digest = (r.body['digest'] as Record<string, unknown>) ?? {};
      if (digestSatisfies(digest, opts.until, collected.length)) {
        return { status: 200, body: { matched: true, until: opts.until ?? 'any', events: collected, seq, digest } };
      }
      if (Date.now() >= deadline) {
        return { status: 200, body: { matched: false, until: opts.until ?? 'any', events: collected, seq, digest } };
      }
    }
  }
}

const text = (r: { status: number; body: unknown }) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ status: r.status, ...(typeof r.body === 'object' && r.body ? (r.body as object) : { body: r.body }) }) }],
  isError: r.status >= 400,
});

const failure = (err: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ status: 500, error: err instanceof Error ? err.message : String(err) }) }], isError: true });

async function guarded(fn: () => Promise<{ status: number; body: unknown }>) {
  try {
    return text(await fn());
  } catch (err) {
    return failure(err);
  }
}

export async function startOperatorServer(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { repo: { type: 'string' } }, allowPositionals: true });
  const client = new OperatorClient({ repo: values.repo, env });
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = new McpServer({ name: 'orchestrator-operator', version: '0.1.0' });
  const task = { task: z.string().describe('Task id as it appears in the graph, e.g. ENG-123') };
  const milestone = { milestone: z.string().describe('Milestone id') };

  server.registerTool(
    'start',
    {
      description: 'Start the daemon for this repository (idempotent). Returns url, pid, run directory, graph path. mode: spawn (the daemon runs headless agents), pull (workers claim launches), or mixed; applied to a daemon already running too.',
      inputSchema: { mode: z.enum(['spawn', 'pull', 'mixed']).optional() },
    },
    async (a) => guarded(async () => ({ status: 200, body: await startDaemon({ repo: values.repo, env, mode: a.mode }) })),
  );
  server.registerTool('stop', { description: 'Stop the daemon. Agents keep running for adoption unless reap is true.', inputSchema: { reap: z.boolean().optional() } }, async (a) =>
    guarded(async () => {
      const r = await stopDaemon({ repo: values.repo, env, reap: a.reap });
      return { status: r.stopped ? 200 : 409, body: r };
    }),
  );
  server.registerTool('status', { description: 'Current run status: sets by state, stall roots, open questions, milestones awaiting review, run facts, stuck tasks, pause reason, cost and budgets, per-launch health.', inputSchema: {} }, async () =>
    guarded(() => client.call('GET', '/v1/status')),
  );
  server.registerTool('runs', { description: 'List every run under ORCH_HOME with its repository and daemon liveness.', inputSchema: {} }, async () =>
    guarded(async () => ({ status: 200, body: { runs: await listRuns(env) } })),
  );
  server.registerTool(
    'import_issues',
    {
      description:
        'Map normalized tracker issues to the run graph and import it. Children of root become tasks; blockedBy becomes deps; blockers outside the set, done, cancelled and in-progress issues become external nodes; root becomes a gated milestone. Acceptance criteria are parsed from the description under the configured heading.',
      inputSchema: {
        root: z.string(),
        issues: z.array(issueRecordSchema),
        options: importOptionsSchema.partial().optional(),
        tracker: trackerSchema.optional().describe('The tracker these issues came from; recorded by the daemon so the run skill can mirror states and comments back.'),
      },
    },
    async (a) =>
      guarded(async () => {
        let mapped;
        try {
          mapped = mapIssues(a);
        } catch (err) {
          if (err instanceof ImportError) return { status: 400, body: { error: err.message, details: err.details } };
          throw err;
        }
        const r = await client.call('PUT', '/v1/graph', { content: mapped.content, ...(a.tracker ? { tracker: a.tracker } : {}) });
        return { status: r.status, body: { ...r.body, summary: mapped.summary } };
      }),
  );
  server.registerTool('import_graph', { description: 'Import a graph file verbatim (YAML or JSON content) or as a node list.', inputSchema: { content: z.string().optional(), nodes: z.array(z.record(z.unknown())).optional() } }, async (a) =>
    guarded(() => client.call('PUT', '/v1/graph', a)),
  );
  server.registerTool(
    'wait',
    {
      description: `Block until something happens. Returns events after afterSeq (default: now), the latest seq, and a digest (openQuestions, awaitingReview, finished, stalled, stuck, pausedReason, outboxPending, trackerErrors). until: question | review | finished | stalled | any; any also returns on launch.stuck, launch.unstuck, and budget.exceeded. timeoutMs default ${WAIT_DEFAULT_MS}, cap ${WAIT_CAP_MS}. Loop on this instead of polling status.`,
      inputSchema: { afterSeq: z.number().int().nonnegative().optional(), timeoutMs: z.number().int().nonnegative().optional(), until: z.enum(['question', 'review', 'finished', 'stalled', 'any']).optional() },
    },
    async (a) => guarded(() => client.wait(a)),
  );
  server.registerTool('review', { description: 'Review bundle for a submitted gated milestone: pinned sha, version, tag, diff stat, closure task summaries, acceptance criteria.', inputSchema: milestone }, async (a) =>
    guarded(() => client.call('GET', `/v1/milestones/${encodeURIComponent(a.milestone)}/review`)),
  );
  server.registerTool('answer', { description: 'Answer a waiting or blocked task\'s question.', inputSchema: { ...task, text: z.string() } }, async (a) =>
    guarded(() => client.call('POST', `/v1/tasks/${encodeURIComponent(a.task)}/answer`, { text: a.text })),
  );
  server.registerTool('cancel', { description: 'Cancel a task. release: let dependents proceed as if it were done.', inputSchema: { ...task, reason: z.string().optional(), release: z.boolean().optional() } }, async (a) =>
    guarded(() => client.call('POST', `/v1/tasks/${encodeURIComponent(a.task)}/cancel`, { reason: a.reason ?? 'cancelled by operator', release: a.release ?? false })),
  );
  server.registerTool(
    'reopen',
    {
      description:
        'Reopen a done or cancelled task. Without cascade it is refused with blockers when a started task depends on it (milestones are transparent and reset). With cascade it records a plan that resets every started dependent and returns it as reset: [{ id, from }].',
      inputSchema: { ...task, cascade: z.boolean().optional() },
    },
    async (a) => guarded(() => client.call('POST', `/v1/tasks/${encodeURIComponent(a.task)}/reopen`, { cascade: a.cascade ?? false })),
  );
  server.registerTool('proposals', { description: 'Agent proposals for follow-up tasks: pending by default, or accepted, rejected, all.', inputSchema: { status: z.enum(['pending', 'accepted', 'rejected', 'all']).optional() } }, async (a) =>
    guarded(() => client.call('GET', `/v1/proposals${a.status ? `?status=${a.status}` : ''}`)),
  );
  server.registerTool(
    'accept_proposal',
    {
      description: 'Accept a proposal into the graph: appends a task depending on the proposer (and joins its gated milestone). nodeId: the tracker issue key when the session created one; payload: extra fields for the node.',
      inputSchema: { id: z.string(), nodeId: z.string().optional(), payload: z.record(z.unknown()).optional() },
    },
    async (a) => guarded(() => client.call('POST', `/v1/proposals/${encodeURIComponent(a.id)}/accept`, { nodeId: a.nodeId, payload: a.payload })),
  );
  server.registerTool('reject_proposal', { description: 'Reject a proposal with a note.', inputSchema: { id: z.string(), note: z.string() } }, async (a) =>
    guarded(() => client.call('POST', `/v1/proposals/${encodeURIComponent(a.id)}/reject`, { note: a.note })),
  );
  server.registerTool('unblock', { description: 'Return a blocked task to unstarted, optionally with an answer or accepting a remediation candidate.', inputSchema: { ...task, answer: z.string().optional(), acceptCandidate: z.boolean().optional() } }, async (a) =>
    guarded(() => client.call('POST', `/v1/tasks/${encodeURIComponent(a.task)}/unblock`, { answer: a.answer, acceptCandidate: a.acceptCandidate ?? false })),
  );
  server.registerTool('accept', { description: 'Accept a submitted milestone at the given pinned sha and review version (from review).', inputSchema: { ...milestone, sha: z.string(), version: z.number().int() } }, async (a) =>
    guarded(() => client.call('POST', `/v1/milestones/${encodeURIComponent(a.milestone)}/accept`, { sha: a.sha, version: a.version })),
  );
  server.registerTool('reject', { description: 'Reject a submitted milestone with a note; it becomes blocked until repaired and unblocked.', inputSchema: { ...milestone, note: z.string() } }, async (a) =>
    guarded(() => client.call('POST', `/v1/milestones/${encodeURIComponent(a.milestone)}/reject`, { note: a.note })),
  );
  server.registerTool('pause', { description: 'Stop admitting new launches; running work continues and is verified.', inputSchema: {} }, async () => guarded(() => client.call('POST', '/v1/pause')));
  server.registerTool('resume', { description: 'Resume admission after a pause. Refused with 409 while the run cost is at or above the ceiling unless overrideBudget is true, which raises the ceiling by one budget.', inputSchema: { overrideBudget: z.boolean().optional() } }, async (a) =>
    guarded(() => client.call('POST', '/v1/resume', { overrideBudget: a.overrideBudget ?? false })),
  );
  server.registerTool('nudge', { description: 'Queue a message for a running task\'s agent (delivered on its next inbox call). 409 when the task has no live launch.', inputSchema: { ...task, message: z.string() } }, async (a) =>
    guarded(() => client.call('POST', `/v1/tasks/${encodeURIComponent(a.task)}/nudge`, { message: a.message })),
  );
  server.registerTool('logs', { description: 'Captured output of a task\'s launch (latest by default).', inputSchema: { ...task, launch: z.number().int().optional() } }, async (a) =>
    guarded(() => client.call('GET', `/v1/tasks/${encodeURIComponent(a.task)}/logs${a.launch ? `?launch=${a.launch}` : ''}`)),
  );

  server.registerTool(
    'outbox',
    {
      description: 'Pending tracker effects (setState, comment) in id order with the tracker policy. Apply each with the session\'s tracker tools, then ack.',
      inputSchema: { after: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() },
    },
    async (a) => guarded(() => client.call('GET', `/v1/outbox?after=${a.after ?? 0}&limit=${a.limit ?? 50}`)),
  );
  server.registerTool(
    'ack',
    {
      description: 'Acknowledge an outbox effect with the vendor result (e.g. { commentId }), or reject it with error text; exactly one of result or error.',
      inputSchema: { id: z.number().int(), result: z.record(z.unknown()).optional(), error: z.string().optional() },
    },
    async (a) =>
      guarded(async () => {
        const hasResult = a.result !== undefined;
        const hasError = a.error !== undefined;
        if (hasResult === hasError) return { status: 400, body: { error: 'exactly one of result or error is required' } };
        return hasError
          ? client.call('POST', `/v1/outbox/${a.id}/nack`, { error: a.error })
          : client.call('POST', `/v1/outbox/${a.id}/ack`, { result: a.result });
      }),
  );

  // Pull runner: a session subagent claims a prepared launch and acts as its agent through token-scoped tools. See specs/operator-mcp "Worker tools".
  server.registerTool(
    'claim',
    {
      description: 'Claim the oldest parked launch (or a named task\'s) for a worker id. Returns launchId, taskId, token, worktree, briefPath, brief, baseSha, apiUrl, and pending when a question is open. Idempotent: the same worker id gets its launch back. 404 when nothing is claimable or the run is paused.',
      inputSchema: { workerId: z.string(), taskId: z.string().optional(), access: z.enum(['local', 'remote']).optional() },
    },
    async (a) => guarded(() => client.call('POST', '/v1/claims', { workerId: a.workerId, taskId: a.taskId, access: a.access })),
  );
  server.registerTool('release', { description: 'Hand a claimed launch back with a reason. Untouched: the task returns to unstarted at no cost; after progress: a failed attempt.', inputSchema: { launchId: z.string(), reason: z.string() } }, async (a) =>
    guarded(() => client.call('POST', `/v1/launches/${encodeURIComponent(a.launchId)}/release`, { reason: a.reason })),
  );
  const scoped = { launchId: z.string(), token: z.string() };
  const forwardLaunch = (op: 'heartbeat' | 'report' | 'block' | 'log' | 'inbox', launchId: string, token: string, body: Record<string, unknown>, timeoutMs = 30_000) =>
    client.call(op === 'inbox' ? 'GET' : 'POST', `/v1/launches/${encodeURIComponent(launchId)}/${op}`, body, timeoutMs, { authorization: `Bearer ${token}` });
  server.registerTool('launch_heartbeat', { description: 'Worker: renew the lease and report progress text for a claimed launch.', inputSchema: { ...scoped, progress: z.string().optional() } }, async ({ launchId, token, ...body }) =>
    guarded(() => forwardLaunch('heartbeat', launchId, token, body)),
  );
  server.registerTool(
    'launch_report',
    {
      description: 'Worker: final report for a claimed launch. kind=submit needs a committed, clean worktree (409 with the dirty files otherwise: commit and call again with the same seq); kind=fail gives up. seq increases per call.',
      inputSchema: {
        ...scoped,
        seq: z.number().int().nonnegative(),
        kind: z.enum(['submit', 'fail']),
        summary: z.string().optional(),
        interfaces: z.array(z.string()).optional(),
        decisions: z.array(z.string()).optional(),
        deviations: z.array(z.string()).optional(),
        followUps: z.array(z.string()).optional(),
        tests: z.array(z.string()).optional(),
        acceptance: z.array(z.object({ criterion: z.string(), evidence: z.string() })).optional(),
        noChanges: z.object({ justification: z.string() }).optional(),
        proposals: z.array(z.object({ title: z.string(), description: z.string(), acceptanceCriteria: z.array(z.string()), deps: z.array(z.string()).optional(), scope: z.array(z.string()).optional(), labels: z.array(z.string()).optional() })).optional(),
        tried: z.string().optional(),
        why: z.string().optional(),
        whatWouldUnblock: z.string().optional(),
      },
    },
    async ({ launchId, token, ...body }) => guarded(() => forwardLaunch('report', launchId, token, body)),
  );
  server.registerTool(
    'launch_block',
    {
      description: `Worker: ask a human a question for a claimed launch. Returns { answer } when it arrives within ${WAIT_CAP_MS / 1000}s, otherwise { pending: true, seq }: call again with the same seq until the answer comes.`,
      inputSchema: {
        ...scoped,
        seq: z.number().int().nonnegative(),
        kind: z.enum(['needsDecision', 'needsAccess', 'impossible', 'dependencyCancelled', 'outOfScope', 'insufficientSpec', 'milestoneRejected']),
        message: z.string(),
        options: z.array(z.string()).optional(),
      },
    },
    async ({ launchId, token, ...body }) =>
      guarded(async () => {
        try {
          return await forwardLaunch('block', launchId, token, body, WAIT_CAP_MS);
        } catch (err) {
          if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return { status: 200, body: { pending: true, seq: body['seq'] } };
          throw err;
        }
      }),
  );
  server.registerTool('launch_inbox', { description: 'Worker: pending notices for a claimed launch (stuck, nudge, baseMoved, payloadChanged).', inputSchema: scoped }, async ({ launchId, token }) =>
    guarded(() => forwardLaunch('inbox', launchId, token, {})),
  );
  server.registerTool('launch_log', { description: 'Worker: append a log line to a claimed launch.', inputSchema: { ...scoped, text: z.string(), seq: z.number().int().optional() } }, async ({ launchId, token, ...body }) =>
    guarded(() => forwardLaunch('log', launchId, token, body)),
  );

  await server.connect(new StdioServerTransport());
}
