/**
 * Operator MCP server. See specs/operator-mcp. A stdio server a host session
 * runs; every tool forwards to the daemon's HTTP routes. Never opens the store.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { mapIssues, ImportError, importOptionsSchema, issueRecordSchema, trackerSchema } from '../import/mapping.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ancestorPids } from '../runs/ancestry.js';
import { daemonState, listRuns, remoteDaemonUrl, reviveDaemon, startDaemon, stopDaemon } from '../runs/lifecycle.js';
import { CODEX_SANDBOXES, COMMIT_POLICIES, EFFORT_LEVELS_ALL, EFFORT_LEVELS_BY_KIND, isRunnerKind, OPENCODE_DATA_DIRS, OPENCODE_PERMISSIONS, RUNNER_KINDS, type RunnerKind } from '../runner/selection.js';
import { foldRunnerArgs, type Overrides } from '../runs/resolve.js';
import { gitTopLevel, readConfigJson, readRepoConfigRaw, resolveRepoPath, runPaths } from '../runs/runDir.js';

/**
 * The cap keeps every tool call under the host's tool-call timeout: Claude Code's two-minute
 * foreground limit, Codex's mcp_servers.<id>.tool_timeout_sec. ORCH_WAIT_CAP_MS shortens it
 * (for tests, and for a Codex registration that keeps the 60 s default timeout).
 */
export const WAIT_CAP_MS = Number(process.env['ORCH_WAIT_CAP_MS'] ?? 90_000);
export const WAIT_DEFAULT_MS = Math.min(60_000, WAIT_CAP_MS);
/** Each daemon-side long-poll is shorter than the cap so a cancelled client never leaves a long server wait. */
const POLL_SLICE_MS = 20_000;

export const TOOL_NAMES = [
  'start', 'stop', 'status', 'runs', 'import_issues', 'import_graph', 'wait', 'review',
  'answer', 'cancel', 'reopen', 'unblock', 'accept', 'reject', 'pause', 'resume', 'logs',
  'outbox', 'ack', 'nudge', 'proposals', 'accept_proposal', 'reject_proposal',
  'claim', 'release', 'launch_heartbeat', 'launch_report', 'launch_block', 'launch_inbox', 'launch_log',
  'configure',
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

/** The runner arguments `start` and `configure` share. See specs/operator-mcp "Start tool" and "Configure tool". */
const RUNNER_ARG_TEXT = {
  runnerKind: 'The runner kind for launches prepared from now on: claude-code (the default), codex, or opencode. A task payload runner or a runner:<kind> label overrides it per task.',
  model: 'The worker model of the kind in force, or of runnerKind in the same call, for launches prepared from now on (defaults: claude-code claude-opus-5-5, codex gpt-6-astra, opencode anthropic/claude-opus-5-5, a provider/model id); a task payload or a model:<name> label overrides it per task.',
  effort: 'The worker effort of the kind in force, or of runnerKind in the same call (default medium); low, medium, high, xhigh, or max for claude-code and opencode (opencode passes it as --variant), and ultra for codex only (refused for claude-code and opencode). A task payload or an effort:<level> label overrides it per task.',
  codex: 'The codex model and effort (default gpt-6-astra at medium), whichever kind is in force.',
  opencode: 'The opencode model (provider/model) and effort (default anthropic/claude-opus-5-5 at medium), whichever kind is in force.',
  sandbox: 'The codex sandbox (codex.sandbox): read-only, workspace-write (the default), or danger-full-access.',
  permission: 'The opencode permission (opencode.permission): derived (the default; commands outside the derived allow list are rejected and the agent asks with needsAccess) or allow (every command runs).',
  dataDir: 'The opencode data directory (opencode.dataDir): shared (the default; the user\'s opencode data directory) or launch (a fresh one per launch).',
  commit: 'The commit policy of runnerKind in the same call, else of the kind in force: agent (the agent commits) or daemon (the orchestrator commits at submit). Defaults: claude-code agent; codex daemon, or agent under danger-full-access; opencode agent.',
};

/** The repo argument every tool takes. See specs/operator-mcp "Operator MCP server". */
export const REPO_ARG_TEXT =
  "The absolute path of the session's project (any directory inside its git repository). Optional: without it the call uses the repo this session last passed, else the server's --repo, ORCH_REPO, or the git top level of the server's working directory. A server whose working directory is not inside a git repository (a Codex or OpenCode plugin install runs it in the plugin root) refuses a call naming this argument until a repo is passed; pass it on every call.";

/** The plugin's start-mode default: pull-mode workers are this session's Claude subagents, so a codex or opencode run starts in spawn. */
export function defaultModeFor(kind: RunnerKind): 'spawn' | 'pull' {
  return kind === 'claude-code' ? 'pull' : 'spawn';
}

/** What start says about the mode: that the spawn default applied for a non-Claude kind, or that such a run is in pull mode. */
export function modeNoteFor(kind: RunnerKind, r: { mode?: string; started?: boolean }, modeGiven: boolean): string | undefined {
  if (kind === 'claude-code') return undefined;
  // Named with --runner for every kind, codex too, though codex is the loop's default.
  const workLoop = `orchestrator-work --runner ${kind}`;
  if (r.mode === 'pull') {
    return `runner kind ${kind} in pull mode: ${kind} launches park until a ${kind} worker claims them (pull-mode workers for ${kind} come from \`${workLoop}\`), and this session's workers claim only claude-code launches; call start with mode spawn or mixed to have the daemon run them`;
  }
  if (!modeGiven && r.started && r.mode === 'spawn') {
    return `runner kind ${kind}: the run is in spawn (the plugin's default for a ${kind} run, unless orchestrator.yaml or the run chose a mode), because pull-mode workers are this session's Claude subagents; the daemon runs the ${kind} agents, and pull-mode workers for ${kind} come from \`${workLoop}\``;
  }
  return undefined;
}

/** The runner kind a run would start with when the start call names none: the run's stored override (config.json), else orchestrator.yaml, else claude-code. */
export function kindOfRun(repo: string, env: NodeJS.ProcessEnv): RunnerKind {
  const stored = readConfigJson(runPaths(repo, env).runDir)?.overrides?.runnerKind;
  if (isRunnerKind(stored)) return stored;
  const file = (readRepoConfigRaw(repo)?.['runner'] as { kind?: unknown } | undefined)?.kind;
  return isRunnerKind(file) ? file : 'claude-code';
}

export interface OperatorContext {
  repo?: string;
  env: NodeJS.ProcessEnv;
}

type Reply = { status: number; body: Record<string, unknown> };

/** One call's view of the client: every request goes to the daemon of the repository the call was bound to. */
export interface RepoClient {
  repo(): Promise<string>;
  call(method: 'GET' | 'POST' | 'PUT', route: string, body?: Record<string, unknown>, timeoutMs?: number, headers?: Record<string, string>): Promise<Reply>;
  wait(opts: { afterSeq?: number; timeoutMs?: number; until?: Until }): Promise<Reply>;
  register(): Promise<void>;
}

export class OperatorClient {
  /** This session's attachment: registered with the daemon on first contact, carried on claims, ended on close. See specs/operator-mcp "Operator MCP server". */
  readonly attachmentId = randomUUID();
  private pids: number[] | undefined;
  /** The daemons this attachment is registered with, by URL, each with the pid it was registered under; a session that passes several repos holds one per daemon. */
  private readonly attachedToPid = new Map<string, number | undefined>();

  /** The repository the session last passed as a tool's `repo`; it wins over --repo, ORCH_REPO, and the working directory. */
  private sessionRepo: string | undefined;

  constructor(private readonly ctx: OperatorContext) {}

  /** Record a call's `repo`: an absolute path inside a git repository, kept as that repository's real top level. Returns the repository the call is bound to: its own, else the one the session last passed, else undefined for the server's default. */
  async useRepo(repo: string | undefined): Promise<string | undefined> {
    if (repo === undefined) return this.sessionRepo;
    if (!path.isAbsolute(repo)) throw new Error(`repo must be an absolute path, got ${repo}`);
    let top: string;
    try {
      top = await gitTopLevel(repo);
    } catch {
      throw new Error(`repo ${repo} is not inside a git repository`);
    }
    this.sessionRepo = top;
    return top;
  }

  /** This client bound to one call's repository; a later call naming another repo does not move it. */
  at(bound: string | undefined): RepoClient {
    return {
      repo: () => this.repo(bound),
      call: (...a) => this.call(bound, ...a),
      wait: (opts) => this.wait(bound, opts),
      register: async () => this.register(await this.url(bound)),
    };
  }

  async repo(bound: string | undefined): Promise<string> {
    if (bound) return bound;
    try {
      return await resolveRepoPath({ repo: this.ctx.repo, env: this.ctx.env });
    } catch (err) {
      // A plugin-installed server runs in the plugin root, so its working directory says nothing about the session's project.
      throw new Error(`${err instanceof Error ? err.message : String(err)}; pass repo, the absolute path of the session's project, as a tool argument`);
    }
  }

  /** The daemon's URL, reviving it after an idle exit or a crash; refused after an explicit stop or for a repository with no run directory. */
  async url(bound: string | undefined): Promise<string> {
    // A remote daemon (ORCH_URL on a non-loopback host) is used as is, without an attachment (its pids are not ours); reviveDaemon reports it unreachable rather than spawning one here.
    const remote = remoteDaemonUrl(this.ctx.env);
    if (remote) {
      await reviveDaemon({ env: this.ctx.env });
      return remote;
    }
    const repo = await this.repo(bound);
    const paths = runPaths(repo, this.ctx.env);
    const state = await daemonState(paths.runDir);
    if (state.healthy && state.url) {
      await this.ensureAttached(state.url, state.pid);
      return state.url;
    }
    const revived = await reviveDaemon({ repo, env: this.ctx.env });
    if (revived) {
      await this.ensureAttached(revived.url, revived.pid);
      return revived.url;
    }
    throw new Error(`no running daemon for ${repo} (run dir ${paths.runDir}); call the start tool first`);
  }

  /** Register the attachment once per daemon process (the pid changes on every restart). */
  private async ensureAttached(base: string, daemonPid: number | undefined): Promise<void> {
    if (daemonPid !== undefined && this.attachedToPid.get(base) === daemonPid) return;
    await this.register(base);
    this.attachedToPid.set(base, daemonPid);
  }

  async register(url: string): Promise<void> {
    this.pids ??= await ancestorPids(process.pid);
    await fetch(`${url}/v1/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: this.attachmentId, pids: this.pids }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
  }

  /** Tell the daemon this session is gone; best effort, half a second at most. */
  async detach(reason = 'sessionEnded'): Promise<void> {
    await Promise.all(
      [...this.attachedToPid.keys()].map((base) =>
        fetch(`${base}/v1/attachments/${encodeURIComponent(this.attachmentId)}/end`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason }),
          signal: AbortSignal.timeout(500),
        }).catch(() => undefined /* best effort */),
      ),
    );
  }

  async call(bound: string | undefined, method: 'GET' | 'POST' | 'PUT', route: string, body?: Record<string, unknown>, timeoutMs = 30_000, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const base = await this.url(bound);
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-orch-attachment': this.attachmentId, ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const out = { status: res.status, body: (await res.json()) as Record<string, unknown> };
    // The operation stands; a session that survived its SessionEnd (for example /clear) registers again for the next call.
    if (res.headers.get('x-orch-attachment') === 'unknown') await this.register(base);
    return out;
  }

  /** Every slice polls the daemon of the repository the wait was bound to, whatever later calls pass. */
  async wait(bound: string | undefined, opts: { afterSeq?: number; timeoutMs?: number; until?: Until }): Promise<{ status: number; body: Record<string, unknown> }> {
    const budget = clampWait(opts.timeoutMs);
    const deadline = Date.now() + budget;
    let after = opts.afterSeq;
    if (after === undefined) {
      const s = await this.call(bound, 'GET', '/v1/status');
      after = Number(s.body['latestSeq'] ?? 0);
    }
    const collected: unknown[] = [];
    let seq = after;
    let digest: Record<string, unknown> = {};
    for (;;) {
      const remaining = deadline - Date.now();
      const slice = Math.max(0, Math.min(POLL_SLICE_MS, remaining));
      const r = await this.call(bound, 'GET', `/v1/events?after=${seq}&wait=${slice}`, undefined, slice + 15_000);
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
  const server = new McpServer({ name: 'orchestrator-operator', version: '0.5.0' });
  // Every tool takes the optional repo; it is recorded for the session and never forwarded. The call is bound to its repository once, here, so concurrent calls naming different repos each reach their own daemon. See specs/operator-mcp "Operator MCP server".
  const tool = <S extends z.ZodRawShape>(name: string, config: { description: string; inputSchema: S }, cb: (a: z.objectOutputType<S, z.ZodTypeAny>, c: RepoClient) => Promise<ReturnType<typeof text>>) =>
    server.registerTool(name, { ...config, inputSchema: { ...config.inputSchema, repo: z.string().optional().describe(REPO_ARG_TEXT) } }, (async (args: Record<string, unknown>) => {
      const { repo, ...rest } = args;
      let bound: string | undefined;
      try {
        bound = await client.useRepo(repo as string | undefined);
      } catch (err) {
        return failure(err);
      }
      return cb(rest as z.objectOutputType<S, z.ZodTypeAny>, client.at(bound));
    }) as never);
  const task = { task: z.string().describe('Task id as it appears in the graph, e.g. ENG-123') };
  const milestone = { milestone: z.string().describe('Milestone id') };

  tool(
    'start',
    {
      description:
        'Start the daemon for this repository (idempotent): the repository named by repo, else the one this session last passed, else the server\'s --repo, ORCH_REPO, or working directory. Returns url, pid, run directory, graph path, the runner mode in force, and the resolved configuration: config (every key as { value, source }: argument, file, pinned, detected, default, or unresolved; runnerKind and the claude, codex, and opencode leaves included), toolchain (what detection found in the repository root), needsConfig (keys no layer supplied; checkCommand there means submitted work is held until it is set), and applied / rejected for the configuration arguments. mode: spawn (the daemon runs headless agents), pull (workers claim launches; this session works them through the run skill), or mixed; applied to a daemon already running too. Without mode, a run started from this plugin defaults to pull, or to spawn when the runner kind is codex or opencode (runnerKind here, or already in force for the run), because pull-mode workers are this session\'s Claude subagents and never claim codex or opencode launches (pull-mode workers for those kinds come from orchestrator-work --runner <kind>); orchestrator.yaml runner.mode, or a mode the run chose before, wins, and a running daemon keeps its mode. modeNote in the result says when the spawn default applied, or warns that a codex or opencode run is in pull mode, naming the kind. Configuration arguments become durable overrides for the run: passed to a daemon this call spawns, applied through the configuration route to one already running; integrationBranch is start-only and lands under rejected on a running daemon. After an idle exit or a crash every other tool revives the daemon by itself.',
      inputSchema: {
        mode: z.enum(['spawn', 'pull', 'mixed']).optional(),
        checkCommand: z.string().optional().describe('The command the verifier runs on every rebased submission, e.g. "npm test".'),
        integrationBranch: z.string().optional().describe('Start-only: the branch work is published to; pinned for the run once chosen.'),
        capacity: z.number().int().optional().describe('Agents in parallel.'),
        allowedTools: z.array(z.string()).optional().describe('Rules appended to the derived allow list for spawned Claude Code agents, e.g. "Bash(docker:*)".'),
        runnerCommand: z.string().optional().describe('The Claude Code runner command template; {allowedTools}, {model}, and {effort} are filled at spawn.'),
        runnerKind: z.enum(RUNNER_KINDS).optional().describe(RUNNER_ARG_TEXT.runnerKind),
        model: z.string().optional().describe(RUNNER_ARG_TEXT.model),
        effort: z.enum(EFFORT_LEVELS_ALL).optional().describe(RUNNER_ARG_TEXT.effort),
        codex: z.object({ model: z.string().optional(), effort: z.enum(EFFORT_LEVELS_BY_KIND.codex).optional() }).optional().describe(RUNNER_ARG_TEXT.codex),
        opencode: z.object({ model: z.string().optional(), effort: z.enum(EFFORT_LEVELS_BY_KIND.opencode).optional() }).optional().describe(RUNNER_ARG_TEXT.opencode),
        sandbox: z.enum(CODEX_SANDBOXES).optional().describe(RUNNER_ARG_TEXT.sandbox),
        permission: z.enum(OPENCODE_PERMISSIONS).optional().describe(RUNNER_ARG_TEXT.permission),
        dataDir: z.enum(OPENCODE_DATA_DIRS).optional().describe(RUNNER_ARG_TEXT.dataDir),
        commit: z.enum(COMMIT_POLICIES).optional().describe(RUNNER_ARG_TEXT.commit),
      },
    },
    async (a, c) =>
      guarded(async () => {
        const { mode, ...rest } = a;
        const repo = await c.repo();
        // The kind in force decides the plugin's mode default: the argument, else the run's stored override, else orchestrator.yaml. See specs/operator-mcp "Start tool".
        const kind = rest.runnerKind ?? kindOfRun(repo, env);
        const defaultMode = defaultModeFor(kind);
        const overrides = foldRunnerArgs(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), kind) as Overrides;
        const r = await startDaemon({ repo, env, mode, ...(mode ? {} : { defaultMode }), ...(Object.keys(overrides).length ? { overrides } : {}) });
        const kindNow = r.config?.runnerKind.value ?? kind;
        // A pull run is judged by the kind the daemon resolved; the spawn default by the kind that chose it.
        const modeNote = modeNoteFor(r.mode === 'pull' ? kindNow : kind, r, mode !== undefined);
        return { status: 200, body: { ...r, ...(modeNote ? { modeNote } : {}) } };
      }),
  );
  tool(
    'configure',
    {
      description:
        'Set or clear configuration overrides on the running daemon through the configuration route: checkCommand (applies to every verifier job that starts checking afterwards), capacity (the next admission pass), allowedTools and runnerCommand (every Claude Code launch spawned afterwards), runnerKind (claude-code, codex, or opencode), model and effort (the worker defaults of the kind in force, or of runnerKind in the same call), codex { model, effort } and opencode { model, effort } (that kind\'s defaults whichever kind is in force), sandbox (codex.sandbox), permission and dataDir (opencode.permission, opencode.dataDir), and commit (the commit policy of the kind in force), all for every launch prepared afterwards. Defaults: claude-code runs claude-opus-5-5 at medium, codex runs gpt-6-astra at medium with sandbox workspace-write, opencode runs anthropic/claude-opus-5-5 (a provider/model id) at medium with permission derived and dataDir shared; effort is low, medium, high, xhigh, or max, and ultra is codex-only (refused with 400 naming the kind for a claude-code or opencode effort); a task payload or a runner:/model:/effort: label overrides them per task. A value sets the key; null clears it so the value falls back to the file, detection, or the default. Returns the new config block with applied; a 400 names an invalid key and value, a 409 names a start-only key (integrationBranch belongs to start).',
      inputSchema: {
        checkCommand: z.string().nullable().optional(),
        capacity: z.number().int().nullable().optional(),
        allowedTools: z.array(z.string()).nullable().optional(),
        runnerCommand: z.string().nullable().optional(),
        runnerKind: z.enum(RUNNER_KINDS).nullable().optional().describe(RUNNER_ARG_TEXT.runnerKind),
        model: z.string().nullable().optional().describe(RUNNER_ARG_TEXT.model),
        effort: z.enum(EFFORT_LEVELS_ALL).nullable().optional().describe(RUNNER_ARG_TEXT.effort),
        codex: z.object({ model: z.string().nullable().optional(), effort: z.enum(EFFORT_LEVELS_BY_KIND.codex).nullable().optional() }).nullable().optional().describe(RUNNER_ARG_TEXT.codex),
        opencode: z.object({ model: z.string().nullable().optional(), effort: z.enum(EFFORT_LEVELS_BY_KIND.opencode).nullable().optional() }).nullable().optional().describe(RUNNER_ARG_TEXT.opencode),
        sandbox: z.enum(CODEX_SANDBOXES).nullable().optional().describe(RUNNER_ARG_TEXT.sandbox),
        permission: z.enum(OPENCODE_PERMISSIONS).nullable().optional().describe(RUNNER_ARG_TEXT.permission),
        dataDir: z.enum(OPENCODE_DATA_DIRS).nullable().optional().describe(RUNNER_ARG_TEXT.dataDir),
        commit: z.enum(COMMIT_POLICIES).nullable().optional().describe(RUNNER_ARG_TEXT.commit),
      },
    },
    async (a, c) =>
      guarded(async () => {
        const patch = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined));
        // The commit policy binds to runnerKind in the same call, else to the kind in force on the daemon.
        const kind = a.commit === undefined || a.runnerKind ? (a.runnerKind ?? 'claude-code') : (((await c.call('GET', '/v1/config')).body['config'] as { runnerKind?: { value?: RunnerKind } } | undefined)?.runnerKind?.value ?? 'claude-code');
        return c.call('PUT', '/v1/config', foldRunnerArgs(patch, kind));
      }),
  );
  tool('stop', { description: 'Stop the daemon. Agents keep running for adoption unless reap is true.', inputSchema: { reap: z.boolean().optional() } }, async (a, c) =>
    guarded(async () => {
      const r = await stopDaemon({ repo: await c.repo(), env, reap: a.reap });
      return { status: r.stopped ? 200 : 409, body: r };
    }),
  );
  tool('status', { description: 'Current run status: sets by state, stall roots, open questions, milestones awaiting review, run facts, stuck tasks, pause reason, cost and budgets, per-launch health (with interruptions, the kept releases a task absorbed), deferred: ready tasks held back because their scope overlaps a running, waiting, submitted, or claimable task (each with the ids it overlaps), idle: whether the daemon is quiescent and how long it has been idle against its exit window, attachments: the sessions attached and the launches each holds, config: every configuration key as { value, source } (runnerKind, the kind in force; allowedTools with its parts and whether the runner command applies it, claude-code only; model and effort of the kind in force likewise; the claude, codex, and opencode leaves such as codex.sandbox, codex.commit, and opencode.permission; each live launch also listing its own runner, model, and effort), claimableByKind: parked launches per runner kind, toolchain: the detection record for the repository root, and needsConfig: keys no layer supplied (checkCommand there holds submitted work until configure sets it). Present even before a graph is loaded.', inputSchema: {} }, async (_a, c) =>
    guarded(() => c.call('GET', '/v1/status')),
  );
  tool('runs', { description: 'List every run under ORCH_HOME with its repository, daemon liveness, and, for a daemon that is gone, its exit record (idle, stop, or signal with the last digest) or none after a crash.', inputSchema: {} }, async () =>
    guarded(async () => ({ status: 200, body: { runs: await listRuns(env) } })),
  );
  tool(
    'import_issues',
    {
      description:
        'Map normalized tracker issues to the run graph and import it. Children of root become tasks; blockedBy becomes deps; blockers outside the set, done, cancelled and in-progress issues become external nodes (done and cancelled ones already satisfied); root becomes a gated milestone. Acceptance criteria are parsed from the description under the configured heading. Records come from any tracker the session can read: Linear, Jira, or GitHub Issues (ids GH-<number>, urls on every record).',
      inputSchema: {
        root: z.string(),
        issues: z.array(issueRecordSchema),
        options: importOptionsSchema.partial().optional(),
        tracker: trackerSchema.optional().describe('The tracker these issues came from; recorded by the daemon so the run skill can mirror states and comments back. kind linear | atlassian | github; workspace is the Linear workspace, the Jira site, or the GitHub owner/repo; inProgressLabel (github only) names the label that stands for in progress.'),
      },
    },
    async (a, c) =>
      guarded(async () => {
        let mapped;
        try {
          mapped = mapIssues(a);
        } catch (err) {
          if (err instanceof ImportError) return { status: 400, body: { error: err.message, details: err.details } };
          throw err;
        }
        const r = await c.call('PUT', '/v1/graph', { content: mapped.content, ...(a.tracker ? { tracker: a.tracker } : {}) });
        return { status: r.status, body: { ...r.body, summary: mapped.summary } };
      }),
  );
  tool('import_graph', { description: 'Import a graph file verbatim (YAML or JSON content) or as a node list.', inputSchema: { content: z.string().optional(), nodes: z.array(z.record(z.unknown())).optional() } }, async (a, c) =>
    guarded(() => c.call('PUT', '/v1/graph', a)),
  );
  tool(
    'wait',
    {
      description: `Block until something happens. Returns events after afterSeq (default: now), the latest seq, and a digest (openQuestions, awaitingReview, finished, stalled, stuck, pausedReason, deferred: the count of ready tasks held back by scope overlap, needsConfig: configuration keys still unresolved, with checkCommand meaning submitted work is held until configure sets it, outboxPending, trackerErrors). until: question | review | finished | stalled | any; any also returns on launch.stuck, launch.unstuck, and budget.exceeded. timeoutMs default ${WAIT_DEFAULT_MS}, cap ${WAIT_CAP_MS}. Loop on this instead of polling status.`,
      inputSchema: { afterSeq: z.number().int().nonnegative().optional(), timeoutMs: z.number().int().nonnegative().optional(), until: z.enum(['question', 'review', 'finished', 'stalled', 'any']).optional() },
    },
    async (a, c) => guarded(() => c.wait(a)),
  );
  tool('review', { description: 'Review bundle for a submitted gated milestone: pinned sha, version, tag, diff stat, closure task summaries, acceptance criteria.', inputSchema: milestone }, async (a, c) =>
    guarded(() => c.call('GET', `/v1/milestones/${encodeURIComponent(a.milestone)}/review`)),
  );
  tool('answer', { description: 'Answer a waiting or blocked task\'s question.', inputSchema: { ...task, text: z.string() } }, async (a, c) =>
    guarded(() => c.call('POST', `/v1/tasks/${encodeURIComponent(a.task)}/answer`, { text: a.text })),
  );
  tool('cancel', { description: 'Cancel a task. release: let dependents proceed as if it were done.', inputSchema: { ...task, reason: z.string().optional(), release: z.boolean().optional() } }, async (a, c) =>
    guarded(() => c.call('POST', `/v1/tasks/${encodeURIComponent(a.task)}/cancel`, { reason: a.reason ?? 'cancelled by operator', release: a.release ?? false })),
  );
  tool(
    'reopen',
    {
      description:
        'Reopen a done or cancelled task. Without cascade it is refused with blockers when a started task depends on it (milestones are transparent and reset). With cascade it records a plan that resets every started dependent and returns it as reset: [{ id, from }].',
      inputSchema: { ...task, cascade: z.boolean().optional() },
    },
    async (a, c) => guarded(() => c.call('POST', `/v1/tasks/${encodeURIComponent(a.task)}/reopen`, { cascade: a.cascade ?? false })),
  );
  tool('proposals', { description: 'Agent proposals for follow-up tasks: pending by default, or accepted, rejected, all.', inputSchema: { status: z.enum(['pending', 'accepted', 'rejected', 'all']).optional() } }, async (a, c) =>
    guarded(() => c.call('GET', `/v1/proposals${a.status ? `?status=${a.status}` : ''}`)),
  );
  tool(
    'accept_proposal',
    {
      description: 'Accept a proposal into the graph: appends a task depending on the proposer (and joins its gated milestone). nodeId: the tracker issue key when the session created one; payload: extra fields for the node.',
      inputSchema: { id: z.string(), nodeId: z.string().optional(), payload: z.record(z.unknown()).optional() },
    },
    async (a, c) => guarded(() => c.call('POST', `/v1/proposals/${encodeURIComponent(a.id)}/accept`, { nodeId: a.nodeId, payload: a.payload })),
  );
  tool('reject_proposal', { description: 'Reject a proposal with a note.', inputSchema: { id: z.string(), note: z.string() } }, async (a, c) =>
    guarded(() => c.call('POST', `/v1/proposals/${encodeURIComponent(a.id)}/reject`, { note: a.note })),
  );
  tool('unblock', { description: 'Return a blocked task to unstarted, optionally with an answer or accepting a remediation candidate.', inputSchema: { ...task, answer: z.string().optional(), acceptCandidate: z.boolean().optional() } }, async (a, c) =>
    guarded(() => c.call('POST', `/v1/tasks/${encodeURIComponent(a.task)}/unblock`, { answer: a.answer, acceptCandidate: a.acceptCandidate ?? false })),
  );
  tool('accept', { description: 'Accept a submitted milestone at the given pinned sha and review version (from review).', inputSchema: { ...milestone, sha: z.string(), version: z.number().int() } }, async (a, c) =>
    guarded(() => c.call('POST', `/v1/milestones/${encodeURIComponent(a.milestone)}/accept`, { sha: a.sha, version: a.version })),
  );
  tool('reject', { description: 'Reject a submitted milestone with a note; it becomes blocked until repaired and unblocked.', inputSchema: { ...milestone, note: z.string() } }, async (a, c) =>
    guarded(() => c.call('POST', `/v1/milestones/${encodeURIComponent(a.milestone)}/reject`, { note: a.note })),
  );
  tool('pause', { description: 'Stop admitting new launches; running work continues and is verified.', inputSchema: {} }, async (_a, c) => guarded(() => c.call('POST', '/v1/pause')));
  tool('resume', { description: 'Resume admission after a pause. Refused with 409 while the run cost is at or above the ceiling unless overrideBudget is true, which raises the ceiling by one budget.', inputSchema: { overrideBudget: z.boolean().optional() } }, async (a, c) =>
    guarded(() => c.call('POST', '/v1/resume', { overrideBudget: a.overrideBudget ?? false })),
  );
  tool('nudge', { description: 'Queue a message for a running task\'s agent (delivered on its next inbox call). 409 when the task has no live launch.', inputSchema: { ...task, message: z.string() } }, async (a, c) =>
    guarded(() => c.call('POST', `/v1/tasks/${encodeURIComponent(a.task)}/nudge`, { message: a.message })),
  );
  tool('logs', { description: 'Captured output of a task\'s launch (latest by default).', inputSchema: { ...task, launch: z.number().int().optional() } }, async (a, c) =>
    guarded(() => c.call('GET', `/v1/tasks/${encodeURIComponent(a.task)}/logs${a.launch ? `?launch=${a.launch}` : ''}`)),
  );

  tool(
    'outbox',
    {
      description: 'Pending tracker effects (setState, comment) in id order with the tracker policy. Apply each with the session\'s tracker tools, then ack.',
      inputSchema: { after: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() },
    },
    async (a, c) => guarded(() => c.call('GET', `/v1/outbox?after=${a.after ?? 0}&limit=${a.limit ?? 50}`)),
  );
  tool(
    'ack',
    {
      description: 'Acknowledge an outbox effect with the vendor result (e.g. { commentId }), or reject it with error text; exactly one of result or error.',
      inputSchema: { id: z.number().int(), result: z.record(z.unknown()).optional(), error: z.string().optional() },
    },
    async (a, c) =>
      guarded(async () => {
        const hasResult = a.result !== undefined;
        const hasError = a.error !== undefined;
        if (hasResult === hasError) return { status: 400, body: { error: 'exactly one of result or error is required' } };
        return hasError
          ? c.call('POST', `/v1/outbox/${a.id}/nack`, { error: a.error })
          : c.call('POST', `/v1/outbox/${a.id}/ack`, { result: a.result });
      }),
  );

  // Pull runner: a session subagent claims a prepared launch and acts as its agent through token-scoped tools. See specs/operator-mcp "Worker tools".
  tool(
    'claim',
    {
      description: 'Claim the oldest parked launch (or a named task\'s) for a worker id. Returns launchId, taskId, token, worktree, briefPath, brief, baseSha, apiUrl, runner (the CLI the launch was prepared for), model, effort, and pending when a question is open. runner filters by the kinds this worker can run (one or a list); a named task of another kind is 409. Idempotent: the same worker id gets its launch back. 404 when nothing is claimable (for the runner filter) or the run is paused.',
      inputSchema: { workerId: z.string(), taskId: z.string().optional(), access: z.enum(['local', 'remote']).optional(), runner: z.union([z.enum(RUNNER_KINDS), z.array(z.enum(RUNNER_KINDS))]).optional() },
    },
    async (a, c) =>
      guarded(async () => {
        await c.register();
        return c.call('POST', '/v1/claims', { workerId: a.workerId, taskId: a.taskId, access: a.access, runner: a.runner, attachment: client.attachmentId });
      }),
  );
  tool(
    'release',
    {
      description: 'Hand a claimed launch back with a reason. Untouched: the task returns to unstarted at no cost; after progress: a failed attempt, unless keep is true, which commits uncommitted work on the launch branch, keeps the branch, and returns the task to unstarted at no cost with an interrupted context for the next brief (bounded by daemon.maxKeptReleases).',
      inputSchema: { launchId: z.string(), reason: z.string(), keep: z.boolean().optional() },
    },
    async (a, c) => guarded(() => c.call('POST', `/v1/launches/${encodeURIComponent(a.launchId)}/release`, { reason: a.reason, ...(a.keep ? { keep: true } : {}) })),
  );
  const scoped = { launchId: z.string(), token: z.string() };
  const forwardLaunch = (c: RepoClient, op: 'heartbeat' | 'report' | 'block' | 'log' | 'inbox', launchId: string, token: string, body: Record<string, unknown>, timeoutMs = 30_000) =>
    c.call(op === 'inbox' ? 'GET' : 'POST', `/v1/launches/${encodeURIComponent(launchId)}/${op}`, body, timeoutMs, { authorization: `Bearer ${token}` });
  tool('launch_heartbeat', { description: 'Worker: renew the lease and report progress text for a claimed launch.', inputSchema: { ...scoped, progress: z.string().optional() } }, async ({ launchId, token, ...body }, c) =>
    guarded(() => forwardLaunch(c, 'heartbeat', launchId, token, body)),
  );
  tool(
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
    async ({ launchId, token, ...body }, c) => guarded(() => forwardLaunch(c, 'report', launchId, token, body)),
  );
  tool(
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
    async ({ launchId, token, ...body }, c) =>
      guarded(async () => {
        try {
          return await forwardLaunch(c, 'block', launchId, token, body, WAIT_CAP_MS);
        } catch (err) {
          if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return { status: 200, body: { pending: true, seq: body['seq'] } };
          throw err;
        }
      }),
  );
  tool('launch_inbox', { description: 'Worker: pending notices for a claimed launch (stuck, nudge, baseMoved, payloadChanged).', inputSchema: scoped }, async ({ launchId, token }, c) =>
    guarded(() => forwardLaunch(c, 'inbox', launchId, token, {})),
  );
  tool('launch_log', { description: 'Worker: append a log line to a claimed launch.', inputSchema: { ...scoped, text: z.string(), seq: z.number().int().optional() } }, async ({ launchId, token, ...body }, c) =>
    guarded(() => forwardLaunch(c, 'log', launchId, token, body)),
  );

  const transport = new StdioServerTransport();
  // The session is gone when the transport closes or the process is signalled: end this attachment so the daemon hands back claimed launches with keep.
  let ending = false;
  const end = async (exitCode: number | undefined) => {
    if (ending) return;
    ending = true;
    await client.detach('sessionEnded');
    if (exitCode !== undefined) process.exit(exitCode);
  };
  server.server.onclose = () => void end(0);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => void end(0));
  await server.connect(transport);
}
