/**
 * Operator MCP server. See specs/operator-mcp. A stdio server a host session
 * runs; every tool forwards to the daemon's HTTP routes. Never opens the store.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { mapIssues, ImportError, importOptionsSchema, issueRecordSchema, trackerSchema } from '../import/mapping.js';
import { daemonState, listRuns, startDaemon, stopDaemon } from '../runs/lifecycle.js';
import { resolveRepoPath, runPaths } from '../runs/runDir.js';

export const WAIT_DEFAULT_MS = 60_000;
export const WAIT_CAP_MS = 90_000;
/** Each daemon-side long-poll is shorter than the cap so a cancelled client never leaves a long server wait. */
const POLL_SLICE_MS = 20_000;

export const TOOL_NAMES = [
  'start', 'stop', 'status', 'runs', 'import_issues', 'import_graph', 'wait', 'review',
  'answer', 'cancel', 'reopen', 'unblock', 'accept', 'reject', 'pause', 'resume', 'logs',
  'outbox', 'ack', 'nudge',
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

  async call(method: 'GET' | 'POST' | 'PUT', route: string, body?: Record<string, unknown>, timeoutMs = 30_000): Promise<{ status: number; body: Record<string, unknown> }> {
    const base = await this.url();
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
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

  server.registerTool('start', { description: 'Start the daemon for this repository (idempotent). Returns url, pid, run directory, graph path.', inputSchema: {} }, async () =>
    guarded(async () => ({ status: 200, body: await startDaemon({ repo: values.repo, env }) })),
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
  server.registerTool('reopen', { description: 'Reopen a done or cancelled task (only when no dependent has started).', inputSchema: task }, async (a) =>
    guarded(() => client.call('POST', `/v1/tasks/${encodeURIComponent(a.task)}/reopen`)),
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

  await server.connect(new StdioServerTransport());
}
