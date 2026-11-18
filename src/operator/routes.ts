/**
 * Operator HTTP routes. Every action is an event (recorded by the orchestrator).
 */
import type { ApiServer } from '../agent/server.js';
import { type ApiResponse, type Orchestrator, workerUsageError } from '../loop/orchestrator.js';
import { constants as fsc } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { GraphValidationError, parseGraph } from '../graph/load.js';
import * as q from '../graph/query.js';
import { trackerSchema } from '../import/mapping.js';
import { zeroByKind } from '../runner/selection.js';
import type { ShutdownCaller } from '../runs/runDir.js';
import { logPath } from '../runner/subprocess.js';
import { type OutboxEffect, setTracker, trackerOf } from '../state/store.js';
import { storeLag } from '../state/gate.js';
import { assertStorableId } from '../state/storable.js';
import { policyReport } from '../tracker/policy.js';
import { cutSubmittedEvent, parseCutSubmitted, parseReviewQuery, reviewAnswer } from './review.js';
import { git } from '../workspace/git.js';

export function digestOf(orch: Orchestrator): Record<string, unknown> {
  const tracker = { outboxPending: orch.store.countOutbox('pending'), trackerErrors: orch.trackerErrors() };
  /** Keys still unresolved; `checkCommand` here means submitted work is held until it is set. See specs/operator-control "Status report: configuration". */
  const needsConfig = orch.effective().needsConfig;
  if (!orch.hasGraph()) return { graphLoaded: false, openQuestions: [], awaitingReview: [], finished: false, stalled: false, running: [], blocked: [], stuck: [], pausedReason: orch.pausedReason(), proposals: [], claimable: 0, claimableByKind: zeroByKind(), preparing: 0, preparingByKind: zeroByKind(), deferred: 0, needsConfig, profileHeld: [], ...tracker };
  const s = orch.status();
  const g = orch.graph();
  return {
    graphLoaded: true,
    needsConfig,
    ...tracker,
    /** Runner kinds with tasks held at admission for a model or effort that would come from a built-in default. See specs/operator-mcp "Wait digest: profileHeld". */
    profileHeld: orch.profileHeld(s.profiles),
    stuck: s.stuck,
    pausedReason: s.pausedReason,
    proposals: s.proposals,
    claimable: s.claimable.length,
    claimableByKind: s.claimableByKind,
    /** Launches being prepared plus tasks waiting for a prepare retry. See specs/operator-control "Status report: launches being prepared". */
    preparing: Object.values(s.preparingByKind).reduce((a, b) => a + b, 0),
    preparingByKind: s.preparingByKind,
    /** Candidates skipped by the scope filter; `status` names their blockers. */
    deferred: s.deferred.length,
    openQuestions: s.openQuestions,
    /** Milestones awaiting a human; tasks awaiting the verifier are `verifying`. */
    awaitingReview: s.awaitingReview.filter((id) => g.nodes.get(id)?.kind === 'milestone'),
    verifying: s.verifying,
    finished: s.finished,
    stalled: s.stalled,
    stallRoots: s.stallRoots,
    running: s.byStatus.running,
    waiting: s.byStatus.waiting,
    blocked: s.byStatus.blocked,
    done: s.byStatus.done.length,
    paused: s.paused,
  };
}

function validateGraphContent(content: string): ApiResponse | undefined {
  try {
    parseGraph(content);
    return undefined;
  } catch (err) {
    if (err instanceof GraphValidationError) return { status: 400, body: { error: err.message, code: err.code, details: err.details } };
    throw err;
  }
}

/** A run whose state is in Postgres keeps its graph in the store: the proposed slot, not a file. See specs/graph-import. */
export function graphInStore(orch: Orchestrator): boolean {
  return orch.config.store?.kind === 'postgres';
}

/**
 * Write the proposed graph, then reload at once. The caller validated the content. Under a Postgres store the document
 * goes to the store's proposed slot; otherwise the run's graph file is replaced atomically. A rejected document stays
 * where it was written and the accepted snapshot is unchanged.
 */
export async function writeGraphAndReload(orch: Orchestrator, content: string): Promise<ApiResponse> {
  const rev = parseGraph(content).rev;
  if (graphInStore(orch)) {
    const proposed = orch.store.setProposedGraph(rev, content);
    orch.store.appendEvent({ kind: 'graph.imported', payload: { rev, slot: 'proposed', stamp: proposed.stamp } }, orch.now());
    await orch.loadGraph();
    const active = orch.hasGraph() ? orch.graph().rev : undefined;
    const accepted = active === rev;
    return { status: 200, body: { rev, accepted, active, reasons: accepted ? [] : (orch.graphRejected()?.reasons ?? []), slot: 'proposed' } };
  }
  const target = orch.config.graphPath;
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, target);
  orch.store.appendEvent({ kind: 'graph.imported', payload: { rev, path: target } }, orch.now());
  await orch.loadGraph();
  const active = orch.hasGraph() ? orch.graph().rev : undefined;
  const accepted = active === rev;
  return { status: 200, body: { rev, accepted, active, reasons: accepted ? [] : (orch.graphRejected()?.reasons ?? []), path: target } };
}

type FileNode = Record<string, unknown> & { id: string; deps?: unknown };

/** The run's proposed graph (the file, or the store's proposed slot under Postgres) as a node list; rebuilt from the active graph when there is none. */
async function readGraphFile(orch: Orchestrator): Promise<{ nodes: FileNode[] }> {
  const text = graphInStore(orch) ? orch.store.getProposedGraph()?.content : await readFile(orch.config.graphPath, 'utf8').catch(() => undefined);
  if (text) {
    const parsed = parseYaml(text) as { nodes?: unknown } | undefined;
    if (parsed && Array.isArray(parsed.nodes)) return { nodes: parsed.nodes as FileNode[] };
  }
  const nodes: FileNode[] = [...orch.graph().nodes.values()].map((n) => ({
    id: n.id,
    ...(n.kind !== 'task' ? { kind: n.kind } : {}),
    ...(n.gated ? { gated: true } : {}),
    ...(n.kind === 'external' ? { done: n.done } : {}),
    deps: [...n.deps],
    ...n.payload,
  }));
  return { nodes };
}

/**
 * Accept a proposal: append its node to the graph file, join the proposer's gated
 * milestones, write, reload, and mark it accepted. Idempotent on the node id.
 */
export async function acceptProposal(orch: Orchestrator, id: string, opts: { nodeId?: string; payload?: Record<string, unknown> }): Promise<ApiResponse> {
  const p = orch.store.getProposal(id);
  if (!p) return { status: 404, body: { error: `no proposal ${id}` } };
  if (p.status === 'rejected') return { status: 409, body: { ok: false, reason: `proposal ${id} is rejected` } };
  if (p.status === 'accepted') return { status: 200, body: { ok: true, id: p.id, nodeId: p.nodeId, duplicate: true, written: false } };
  if (!orch.hasGraph()) return { status: 409, body: { ok: false, reason: 'graph not loaded' } };
  const nodeId = opts.nodeId?.trim() || p.id;
  const now = orch.now();
  orch.store.appendEvent({ kind: 'operator.acceptProposal', taskId: p.taskId, payload: { id: p.id, nodeId, payload: opts.payload ?? null } }, now);
  const doc = await readGraphFile(orch);
  if (doc.nodes.some((n) => n.id === nodeId)) {
    orch.store.updateProposal(p.id, { status: 'accepted', nodeId, decidedAt: now });
    return { status: 200, body: { ok: true, id: p.id, nodeId, duplicate: true, written: false } };
  }
  const deps = [...new Set([...(p.payload.deps ?? []), p.taskId])];
  doc.nodes.push({
    id: nodeId,
    deps,
    title: p.payload.title,
    description: p.payload.description,
    acceptanceCriteria: p.payload.acceptanceCriteria,
    ...(p.payload.labels ? { labels: p.payload.labels } : {}),
    ...(p.payload.scope ? { scope: p.payload.scope } : {}),
    ...(opts.payload ?? {}),
    proposal: p.id,
    proposedBy: p.taskId,
  });
  const joined: string[] = [];
  if (orch.config.proposals.joinMilestone) {
    const g = orch.graph();
    for (const m of q.milestones(g)) {
      const mn = g.nodes.get(m);
      if (!mn?.gated || !q.closure(g, m).has(p.taskId)) continue;
      const fileNode = doc.nodes.find((n) => n.id === m);
      if (!fileNode) continue;
      const mdeps = Array.isArray(fileNode.deps) ? (fileNode.deps as string[]) : [];
      if (!mdeps.includes(nodeId)) fileNode.deps = [...mdeps, nodeId];
      joined.push(m);
    }
  }
  const content = toYaml({ nodes: doc.nodes });
  const invalid = validateGraphContent(content);
  if (invalid) return { status: 400, body: { ...invalid.body, ok: false, id: p.id, nodeId } };
  const written = await writeGraphAndReload(orch, content);
  orch.store.updateProposal(p.id, { status: 'accepted', nodeId, decidedAt: orch.now() });
  return { status: 200, body: { ok: true, id: p.id, nodeId, joined, written: true, ...written.body } };
}

/** The configuration facts every status response carries, graph or not. */
function configFacts(orch: Orchestrator): Record<string, unknown> {
  const r = orch.configReport();
  return { config: r.config, toolchain: r.toolchain, needsConfig: r.needsConfig };
}

function result(r: { ok: true } | { ok: false; reason: string; blockers?: string[] }): ApiResponse {
  return r.ok ? { status: 200, body: { ok: true } } : { status: 409, body: { ok: false, reason: r.reason, blockers: (r as { blockers?: string[] }).blockers } };
}

/** Why the daemon cannot do work right now: the store, the repository, the integration branch. Empty when ready. See specs/cluster-runtime "Probes". */
export async function readinessFailures(orch: Orchestrator): Promise<string[]> {
  const reasons: string[] = [];
  try {
    orch.store.latestEventSeq();
  } catch (err) {
    reasons.push(`store: ${String(err)}`);
  }
  // A journaled store: lag above zero for longer than one flush retry, a lost run lock, a fatal flush. See specs/cluster-runtime "Probes".
  reasons.push(...(orch.store.readiness?.() ?? []));
  const repo = orch.config.repoPath;
  const branch = orch.config.integrationBranch;
  try {
    await access(repo, fsc.R_OK | fsc.X_OK);
  } catch (err) {
    reasons.push(`repo: ${repo} is not readable (${(err as NodeJS.ErrnoException).code ?? String(err)})`);
    return [...reasons, `branch: ${branch} not checked because the repository is unreadable`];
  }
  const r = await git(repo, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`], { allowFail: true });
  if (r.code !== 0 || !r.stdout.trim()) reasons.push(`branch: ${branch} does not resolve to a commit`);
  return reasons;
}

export function registerOperatorRoutes(server: ApiServer, orch: Orchestrator): void {
  // Probes: unauthenticated, and never activity for the idle exit (the dispatch exempts them). See specs/cluster-runtime "Probes".
  server.addRoute('GET', /^\/healthz$/, async () => ({ status: 200, body: { ok: true } }));
  server.addRoute('GET', /^\/readyz$/, async () => {
    const reasons = await readinessFailures(orch);
    return reasons.length ? { status: 503, body: { ok: false, reasons } } : { status: 200, body: { ok: true } };
  });
  server.addRoute('GET', /^\/v1\/status$/, async () => ({
    status: 200,
    body: orch.hasGraph()
      ? (orch.status() as unknown as Record<string, unknown>)
      : {
          ...configFacts(orch),
          graphRev: undefined,
          graphRejected: orch.graphRejected(),
          finished: false,
          stalled: false,
          paused: orch.isPaused(),
          byStatus: { unstarted: [], running: [], waiting: [], submitted: [], done: [], failed: [], blocked: [], cancelled: [] },
          stallRoots: [],
          awaitingReview: [],
          openQuestions: [],
          liveLaunches: [],
          stuck: [],
          pausedReason: orch.pausedReason(),
          proposals: [],
          runner: { mode: orch.effectiveMode(), claimWindowMs: orch.config.runner.claimWindowMs, confirmProfile: orch.confirmProfile() },
          profiles: [],
          claimable: [],
          claimableByKind: zeroByKind(),
          preparing: [],
          prepareRetry: [],
          preparingByKind: zeroByKind(),
          workers: [],
          foreignCommits: [],
          latestSeq: orch.store.durability().eventSeq,
          ...storeLag(orch.store),
          tracker: trackerOf(orch.store),
          outboxPending: orch.store.countOutbox('pending'),
          trackerErrors: orch.trackerErrors(),
          error: 'graph not loaded',
        },
  }));
  // Configuration: the resolved block with provenance, and runtime overrides. See specs/operator-control "Configuration route".
  server.addRoute('GET', /^\/v1\/config$/, async () => ({ status: 200, body: orch.configReport() as unknown as Record<string, unknown> }));
  server.addRoute('PUT', /^\/v1\/config$/, async (_req, body) => {
    // endLive confirms a change that would end live launches; it is not a configuration key and is never stored.
    const { endLive, ...patch } = body;
    const r = orch.setConfig(patch, { endLive: endLive === true || endLive === 'true' });
    if (!r.ok) {
      if (r.status === 400) return { status: 400, body: { error: r.error, key: r.key } };
      return 'wouldEnd' in r ? { status: 409, body: { ok: false, error: r.error, wouldEnd: r.wouldEnd } } : { status: 409, body: { ok: false, error: r.error, startOnly: r.startOnly } };
    }
    const { config, toolchain, needsConfig, overrides } = r.report;
    return { status: 200, body: { ok: true, applied: r.applied, config, toolchain, needsConfig, overrides } };
  });
  server.addRoute('POST', /^\/v1\/tasks\/([^/]+)\/answer$/, async (_req, body, [id]) => result(orch.answer(id as string, String(body['text'] ?? ''))));
  server.addRoute('POST', /^\/v1\/tasks\/([^/]+)\/cancel$/, async (_req, body, [id]) =>
    result(orch.cancel(id as string, String(body['reason'] ?? 'cancelled by operator'), body['release'] === true || body['release'] === 'true')),
  );
  server.addRoute('POST', /^\/v1\/tasks\/([^/]+)\/reopen$/, async (_req, body, [id]) => {
    const r = orch.reopen(id as string, { cascade: body['cascade'] === true || body['cascade'] === 'true' });
    return r.ok ? { status: 200, body: { ok: true, reset: r.reset } } : { status: 409, body: { ok: false, reason: r.reason, blockers: r.blockers, publishing: r.publishing } };
  });
  server.addRoute('POST', /^\/v1\/tasks\/([^/]+)\/unblock$/, async (_req, body, [id]) =>
    result(orch.unblock(id as string, { answer: body['answer'] ? String(body['answer']) : undefined, acceptCandidate: body['acceptCandidate'] === true })),
  );
  server.addRoute('POST', /^\/v1\/milestones\/([^/]+)\/accept$/, async (_req, body, [id]) => result(orch.acceptMilestone(id as string, String(body['sha'] ?? ''), Number(body['version']))));
  server.addRoute('POST', /^\/v1\/milestones\/([^/]+)\/reject$/, async (_req, body, [id]) => result(orch.rejectMilestone(id as string, String(body['note'] ?? ''))));
  server.addRoute('POST', /^\/v1\/pause$/, async () => {
    orch.pause();
    return { status: 200, body: { ok: true, paused: true } };
  });
  server.addRoute('POST', /^\/v1\/resume$/, async (_req, body) => {
    const r = orch.resume({ overrideBudget: body['overrideBudget'] === true || body['overrideBudget'] === 'true' });
    return r.ok ? { status: 200, body: { ok: true, paused: false } } : { status: 409, body: { ok: false, reason: r.reason, runUsd: r.runUsd, ceilingUsd: r.ceilingUsd, paused: orch.isPaused() } };
  });
  server.addRoute('POST', /^\/v1\/tasks\/([^/]+)\/nudge$/, async (_req, body, [id]) => result(orch.nudge(id as string, String(body['message'] ?? ''))));
  // Pull runner: claims, releases, worker usage, and the mode override. See specs/operator-control "Claims and releases".
  server.addRoute('POST', /^\/v1\/claims$/, async (_req, body) => {
    if (!orch.hasGraph()) return { status: 409, body: { ok: false, reason: 'graph not loaded' } };
    const args = {
      workerId: String(body['workerId'] ?? ''),
      taskId: typeof body['taskId'] === 'string' ? body['taskId'] : undefined,
      access: typeof body['access'] === 'string' ? body['access'] : undefined,
      attachment: typeof body['attachment'] === 'string' && body['attachment'] ? body['attachment'] : undefined,
      // One kind or a list of the kinds the worker can run, passed through as given so that claim() refuses
      // anything outside the kinds, null included; only an absent key means no filter. See specs/pull-runner "Claim".
      runner: body['runner'],
    };
    // Ids the store would rewrite are refused before anything is written, the event included: a worker id kept rewritten
    // would never match its own next claim. The server answers 400 naming the field. See specs/state-backend "Storable ids".
    assertStorableId('workerId', args.workerId);
    if (args.taskId !== undefined) assertStorableId('taskId', args.taskId);
    if (args.attachment !== undefined) assertStorableId('attachment', args.attachment);
    orch.store.appendEvent({ kind: 'operator.claim', taskId: args.taskId, payload: { ...args } }, orch.now());
    return orch.claim(args);
  });
  server.addRoute('POST', /^\/v1\/launches\/([^/]+)\/release$/, async (_req, body, [id]) => {
    const reason = String(body['reason'] ?? 'released by worker');
    const keep = body['keep'] === true || body['keep'] === 'true';
    orch.store.appendEvent({ kind: 'operator.release', launchId: id as string, payload: { reason, keep } }, orch.now());
    return orch.release(id as string, reason, { keep });
  });
  // The work loop renews a claimed launch's lease while its agent process lives; authenticated by the launch token like an agent call,
  // but not a progress signal. See specs/pull-runner "Lease renewal by the work loop".
  server.addRoute('POST', /^\/v1\/launches\/([^/]+)\/renew$/, async (req, _body, [id]) => {
    const h = req.headers.authorization ?? '';
    return orch.renewClaim(id as string, h.startsWith('Bearer ') ? h.slice(7).trim() : '');
  });
  // A claimed launch has no log: its worker posts the usage it read after the agent exited. See specs/pull-runner "Worker usage".
  server.addRoute('POST', /^\/v1\/launches\/([^/]+)\/usage$/, async (_req, body, [id]) => {
    // A malformed body (a token count that is not a safe integer) is refused before anything is written. See specs/agent-protocol "Integer fields".
    const bad = workerUsageError(body);
    if (bad) return bad;
    orch.store.appendEvent({ kind: 'operator.usage', launchId: id as string, payload: { ...body } }, orch.now());
    return orch.recordWorkerUsage(id as string, body);
  });
  // Session attachments: a session's operator server registers, ends on close, and a session end posts its ancestry. See specs/operator-control "Session attachments".
  server.addRoute('POST', /^\/v1\/attachments$/, async (_req, body) => {
    const id = typeof body['id'] === 'string' ? body['id'].trim() : '';
    const pids = Array.isArray(body['pids']) ? (body['pids'] as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (!id || !pids.length) return { status: 400, body: { error: 'id and a non-empty pids list are required' } };
    // The id is the kv key attachment:<id>; one the store would rewrite is refused. See specs/state-backend "Storable ids".
    assertStorableId('id', id);
    orch.attach({ id, pids });
    return { status: 200, body: { ok: true, id, pids } };
  });
  server.addRoute('POST', /^\/v1\/attachments\/([^/]+)\/end$/, async (_req, body, [id]) => {
    const reason = String(body['reason'] ?? 'sessionEnded');
    orch.store.appendEvent({ kind: 'operator.attachmentEnd', payload: { id, reason } }, orch.now());
    const ended = orch.endAttachment(id as string, reason);
    return { status: 200, body: { ok: true, id, ended } };
  });
  server.addRoute('POST', /^\/v1\/attachments\/ended$/, async (_req, body) => {
    const pids = Array.isArray(body['pids']) ? (body['pids'] as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    const reason = String(body['reason'] ?? 'sessionEnded');
    if (!pids.length) return { status: 400, body: { error: 'pids is required' } };
    orch.store.appendEvent({ kind: 'operator.attachmentEnd', payload: { pids, reason } }, orch.now());
    const ended = orch.endAttachmentsByPids(pids, reason);
    return { status: 200, body: { ok: true, ended } };
  });
  server.addRoute('PUT', /^\/v1\/runner$/, async (_req, body) => {
    const mode = body['mode'];
    if (mode !== 'spawn' && mode !== 'pull' && mode !== 'mixed') return { status: 400, body: { error: 'mode must be spawn, pull, or mixed' } };
    // A remote run has no worktree to spawn an agent in: it stays in pull mode. See specs/pull-runner "Access modes".
    if (orch.config.runner.access === 'remote' && mode !== 'pull') return { status: 409, body: { ok: false, reason: `runner.access is remote, so runner.mode must stay pull, not ${mode}`, access: 'remote', mode } };
    orch.setMode(mode);
    return { status: 200, body: { ok: true, runner: { mode, claimWindowMs: orch.config.runner.claimWindowMs } } };
  });
  server.addRoute('GET', /^\/v1\/tasks\/([^/]+)\/logs$/, async (_req, query, [id]) => {
    const launches = orch.store.listLaunches({ taskId: id as string });
    const wanted = query['launch'] ? Number(query['launch']) : undefined;
    const launch = wanted ? launches.find((l) => l.launchNo === wanted) : launches[launches.length - 1];
    if (!launch) return { status: 404, body: { error: `no launch for ${id}` } };
    const file = logPath(path.join(orch.config.dataDir, 'logs'), launch.launchId);
    const text = await readFile(file, 'utf8').catch(() => '');
    return { status: 200, body: { launchId: launch.launchId, launchNo: launch.launchNo, log: text } };
  });
  server.addRoute('GET', /^\/v1\/events$/, async (_req, query) => {
    // Opt-in: other readers (deploy/smoke.sh) need whole events. See specs/operator-control "Cut submitted events on request".
    const cutParam = parseCutSubmitted(query);
    if (!cutParam.ok) return { status: 400, body: cutParam };
    const asked = Number(query['after'] ?? 0);
    const after = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 0;
    const limit = Math.max(1, Math.min(500, Number(query['limit'] ?? 200)));
    const kinds = typeof query['kinds'] === 'string' && query['kinds'] ? String(query['kinds']).split(',').filter(Boolean) : undefined;
    const wait = Math.max(0, Math.min(120_000, Number(query['wait'] ?? 0)));
    const deadline = Date.now() + wait;
    // Only durable events: after a crash an unflushed sequence number is given to a different event. See specs/state-backend "Reads".
    const durableEvents = () => {
      const upTo = orch.store.durability().eventSeq;
      return { upTo, events: orch.store.listEvents({ afterSeq: after, kinds, limit }).filter((e) => e.seq <= upTo) };
    };
    let read = durableEvents();
    while (read.events.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      read = durableEvents();
    }
    // The cursor never moves backwards: at most the durable sequence number, never below the `after` given, and at a
    // page cut by the limit the last event served, so the next read starts where this one stopped. See specs/state-backend "Durable cursor in the status".
    const last = read.events[read.events.length - 1];
    const upTo = read.events.length >= limit && last ? last.seq : Math.min(orch.store.latestEventSeq(), read.upTo);
    const seq = Math.max(after, upTo);
    // The cut changes payloads only, on copies; which events are served and the cursor stay as above.
    const cuts = { statLines: orch.config.review.statLines, summaryChars: orch.config.review.summaryChars };
    const events = cutParam.cut ? read.events.map((e) => cutSubmittedEvent(e, cuts)) : read.events;
    return { status: 200, body: { events, seq, digest: digestOf(orch) } };
  });
  // An index by default; `task` for one task's report, `full=true` for the whole bundle. See specs/operator-control "Review bundle".
  server.addRoute('GET', /^\/v1\/milestones\/([^/]+)\/review$/, async (_req, query, [id]) => {
    if (!orch.hasGraph()) return { status: 409, body: { ok: false, reason: 'graph not loaded' } };
    const parsed = parseReviewQuery(query);
    if (!parsed.ok) return { status: 400, body: parsed };
    return reviewAnswer(orch, id as string, parsed.params);
  });
  server.addRoute('PUT', /^\/v1\/graph$/, async (_req, body) => {
    let content: string;
    if (typeof body['content'] === 'string') content = body['content'];
    else if (Array.isArray(body['nodes'])) content = toYaml({ nodes: body['nodes'] });
    else return { status: 400, body: { error: 'content (string) or nodes (array) required' } };
    const invalid = validateGraphContent(content);
    if (invalid) return invalid;
    if (body['tracker'] !== undefined) {
      const parsed = trackerSchema.safeParse(body['tracker']);
      if (!parsed.success) return { status: 400, body: { error: 'invalid tracker', issues: parsed.error.issues } };
      const rec = { ...parsed.data, recordedAt: orch.now() };
      orch.store.transaction(() => {
        setTracker(orch.store, rec);
        orch.store.appendEvent({ kind: 'tracker.recorded', payload: { ...rec } }, orch.now());
      });
    }
    return writeGraphAndReload(orch, content);
  });
  // Proposals: held until a human accepts or rejects them. See specs/operator-control "Proposals".
  server.addRoute('GET', /^\/v1\/proposals$/, async (_req, query) => {
    const status = typeof query['status'] === 'string' && query['status'] ? String(query['status']) : 'pending';
    const proposals = status === 'all' ? orch.store.listProposals() : orch.store.listProposals({ status: status as 'pending' | 'accepted' | 'rejected' });
    return { status: 200, body: { proposals } };
  });
  server.addRoute('POST', /^\/v1\/proposals\/([^/]+)\/accept$/, async (_req, body, [id]) =>
    acceptProposal(orch, id as string, {
      nodeId: typeof body['nodeId'] === 'string' ? body['nodeId'] : undefined,
      payload: body['payload'] && typeof body['payload'] === 'object' ? (body['payload'] as Record<string, unknown>) : undefined,
    }),
  );
  server.addRoute('POST', /^\/v1\/proposals\/([^/]+)\/reject$/, async (_req, body, [id]) => {
    const p = orch.store.getProposal(id as string);
    if (!p) return { status: 404, body: { error: `no proposal ${id}` } };
    if (p.status !== 'pending') return { status: 409, body: { ok: false, reason: `proposal ${id} is ${p.status}` } };
    const note = String(body['note'] ?? '').trim();
    if (!note) return { status: 409, body: { ok: false, reason: 'a note is required' } };
    orch.store.transaction(() => {
      orch.store.appendEvent({ kind: 'operator.rejectProposal', taskId: p.taskId, payload: { id: p.id, note } }, orch.now());
      orch.store.updateProposal(p.id, { status: 'rejected', note, decidedAt: orch.now() });
    });
    return { status: 200, body: { ok: true, id: p.id, rejected: true } };
  });
  // Tracker outbox: what a drainer reads and acknowledges. See specs/tracker-sync "Drainer contract".
  // An ack or nack answers the effect's id and state, never its payload: the drainer has it from the listing. See specs/operator-control "Tracker outbox".
  const effectState = (e: OutboxEffect | undefined) => {
    if (!e) return undefined;
    const out: Pick<OutboxEffect, 'id' | 'taskId' | 'kind' | 'status' | 'attempts' | 'result' | 'error'> = { id: e.id, taskId: e.taskId, kind: e.kind, status: e.status, attempts: e.attempts };
    if (e.result !== undefined) out.result = e.result;
    if (e.error !== undefined) out.error = e.error;
    return out;
  };
  server.addRoute('GET', /^\/v1\/outbox$/, async (_req, query) => {
    const after = Number(query['after'] ?? 0);
    const limit = Math.max(1, Math.min(500, Number(query['limit'] ?? 50)));
    // Only durable effects: the operator writes to the tracker from this listing. See specs/state-backend "Reads".
    const upTo = orch.store.durability().outboxId;
    const effects = orch.store.listOutbox({ status: 'pending', afterId: Number.isFinite(after) ? after : 0, limit }).filter((e) => e.id <= upTo);
    return { status: 200, body: { effects, policy: policyReport(orch.config, orch.store) } };
  });
  server.addRoute('POST', /^\/v1\/outbox\/([^/]+)\/ack$/, async (_req, body, [idStr]) => {
    const id = Number(idStr);
    const cur = orch.store.getOutbox(id);
    if (!cur) return { status: 404, body: { error: `no effect ${idStr}` } };
    if (cur.status === 'applied') return { status: 200, body: { ok: true, effect: effectState(cur), duplicate: true } };
    const effect = orch.store.transaction(() => {
      orch.store.appendEvent({ kind: 'operator.ack', taskId: cur.taskId, payload: { effectId: id, result: body['result'] ?? null } }, orch.now());
      return orch.store.ackOutbox(id, body['result'] ?? null, orch.now());
    });
    return { status: 200, body: { ok: true, effect: effectState(effect) } };
  });
  server.addRoute('POST', /^\/v1\/outbox\/([^/]+)\/nack$/, async (_req, body, [idStr]) => {
    const id = Number(idStr);
    const cur = orch.store.getOutbox(id);
    if (!cur) return { status: 404, body: { error: `no effect ${idStr}` } };
    if (cur.status === 'applied') return { status: 409, body: { ok: false, reason: `effect ${id} is already applied`, effect: effectState(cur) } };
    const error = String(body['error'] ?? 'unknown error');
    const effect = orch.store.transaction(() => {
      orch.store.appendEvent({ kind: 'operator.nack', taskId: cur.taskId, payload: { effectId: id, error } }, orch.now());
      return orch.store.nackOutbox(id, error, orch.config.tracker.maxAttempts);
    });
    return { status: 200, body: { ok: true, effect: effectState(effect) } };
  });
  server.addRoute('POST', /^\/v1\/shutdown$/, async (req, body) => {
    const reap = body['reap'] === true || body['reap'] === 'true';
    if (!orch.requestShutdown) return { status: 409, body: { ok: false, reason: 'shutdown not available in this host' } };
    // Who asked is recorded before anything stops, in the event log and in the exit record. See specs/operator-control "Shutdown".
    const header = req.headers['x-orch-attachment'];
    const by: ShutdownCaller = {
      ...(typeof header === 'string' && header ? { attachment: header } : {}),
      ...(req.socket.remoteAddress ? { remote: req.socket.remoteAddress } : {}),
      ...(typeof req.headers['user-agent'] === 'string' ? { userAgent: req.headers['user-agent'] } : {}),
    };
    orch.store.appendEvent({ kind: 'operator.shutdown', payload: { reap, by } }, orch.now());
    setTimeout(() => orch.requestShutdown?.('stop', reap, by), 50);
    return { status: 200, body: { ok: true, reap, by } };
  });
  server.addRoute('POST', /^\/v1\/tick$/, async () => {
    await orch.tick();
    return { status: 200, body: { ok: true } };
  });
}
