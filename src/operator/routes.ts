/**
 * Operator HTTP routes. Every action is an event (recorded by the orchestrator).
 */
import type { ApiServer } from '../agent/server.js';
import type { ApiResponse, Orchestrator } from '../loop/orchestrator.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { GraphValidationError, parseGraph } from '../graph/load.js';
import * as q from '../graph/query.js';
import { trackerSchema } from '../import/mapping.js';
import { logPath } from '../runner/subprocess.js';
import { setTracker, trackerOf } from '../state/store.js';
import { policyReport } from '../tracker/policy.js';

export function digestOf(orch: Orchestrator): Record<string, unknown> {
  const tracker = { outboxPending: orch.store.countOutbox('pending'), trackerErrors: orch.trackerErrors() };
  if (!orch.hasGraph()) return { graphLoaded: false, openQuestions: [], awaitingReview: [], finished: false, stalled: false, running: [], blocked: [], stuck: [], pausedReason: orch.pausedReason(), proposals: [], claimable: 0, ...tracker };
  const s = orch.status();
  const g = orch.graph();
  return {
    graphLoaded: true,
    ...tracker,
    stuck: s.stuck,
    pausedReason: s.pausedReason,
    proposals: s.proposals,
    claimable: s.claimable.length,
    openQuestions: s.openQuestions,
    /** Milestones awaiting a human; tasks awaiting the verifier are `verifying`. */
    awaitingReview: s.awaitingReview.filter((id) => g.nodes.get(id)?.kind === 'milestone'),
    verifying: s.awaitingReview.filter((id) => g.nodes.get(id)?.kind === 'task'),
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

/** Atomic write of the run's graph file, then an immediate reload. The caller validated the content. */
export async function writeGraphAndReload(orch: Orchestrator, content: string): Promise<ApiResponse> {
  const rev = parseGraph(content).rev;
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

/** The run's graph file as a node list; rebuilt from the active graph when the file is missing. */
async function readGraphFile(orch: Orchestrator): Promise<{ nodes: FileNode[] }> {
  const text = await readFile(orch.config.graphPath, 'utf8').catch(() => undefined);
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

function result(r: { ok: true } | { ok: false; reason: string; blockers?: string[] }): ApiResponse {
  return r.ok ? { status: 200, body: { ok: true } } : { status: 409, body: { ok: false, reason: r.reason, blockers: (r as { blockers?: string[] }).blockers } };
}

export function registerOperatorRoutes(server: ApiServer, orch: Orchestrator): void {
  server.addRoute('GET', /^\/v1\/status$/, async () => ({
    status: 200,
    body: orch.hasGraph()
      ? (orch.status() as unknown as Record<string, unknown>)
      : {
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
          runner: { mode: orch.effectiveMode(), claimWindowMs: orch.config.runner.claimWindowMs },
          claimable: [],
          workers: [],
          foreignCommits: [],
          latestSeq: orch.store.latestEventSeq(),
          tracker: trackerOf(orch.store),
          outboxPending: orch.store.countOutbox('pending'),
          trackerErrors: orch.trackerErrors(),
          error: 'graph not loaded',
        },
  }));
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
  // Pull runner: claims, releases, and the mode override. See specs/operator-control "Claims and releases".
  server.addRoute('POST', /^\/v1\/claims$/, async (_req, body) => {
    if (!orch.hasGraph()) return { status: 409, body: { ok: false, reason: 'graph not loaded' } };
    const args = { workerId: String(body['workerId'] ?? ''), taskId: typeof body['taskId'] === 'string' ? body['taskId'] : undefined, access: typeof body['access'] === 'string' ? body['access'] : undefined };
    orch.store.appendEvent({ kind: 'operator.claim', taskId: args.taskId, payload: { ...args } }, orch.now());
    return orch.claim(args);
  });
  server.addRoute('POST', /^\/v1\/launches\/([^/]+)\/release$/, async (_req, body, [id]) => {
    const reason = String(body['reason'] ?? 'released by worker');
    orch.store.appendEvent({ kind: 'operator.release', launchId: id as string, payload: { reason } }, orch.now());
    return orch.release(id as string, reason);
  });
  server.addRoute('PUT', /^\/v1\/runner$/, async (_req, body) => {
    const mode = body['mode'];
    if (mode !== 'spawn' && mode !== 'pull' && mode !== 'mixed') return { status: 400, body: { error: 'mode must be spawn, pull, or mixed' } };
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
    const after = Number(query['after'] ?? 0);
    const limit = Math.max(1, Math.min(500, Number(query['limit'] ?? 200)));
    const kinds = typeof query['kinds'] === 'string' && query['kinds'] ? String(query['kinds']).split(',').filter(Boolean) : undefined;
    const wait = Math.max(0, Math.min(120_000, Number(query['wait'] ?? 0)));
    const deadline = Date.now() + wait;
    let events = orch.store.listEvents({ afterSeq: after, kinds, limit });
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      events = orch.store.listEvents({ afterSeq: after, kinds, limit });
    }
    return { status: 200, body: { events, seq: orch.store.latestEventSeq(), digest: digestOf(orch) } };
  });
  server.addRoute('GET', /^\/v1\/milestones\/([^/]+)\/review$/, async (_req, _query, [id]) => {
    if (!orch.hasGraph()) return { status: 409, body: { ok: false, reason: 'graph not loaded' } };
    const r = await orch.reviewBundle(id as string);
    return r.ok ? { status: 200, body: r.bundle } : { status: 409, body: { ok: false, reason: r.reason } };
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
  server.addRoute('GET', /^\/v1\/outbox$/, async (_req, query) => {
    const after = Number(query['after'] ?? 0);
    const limit = Math.max(1, Math.min(500, Number(query['limit'] ?? 50)));
    const effects = orch.store.listOutbox({ status: 'pending', afterId: Number.isFinite(after) ? after : 0, limit });
    return { status: 200, body: { effects, policy: policyReport(orch.config, orch.store) } };
  });
  server.addRoute('POST', /^\/v1\/outbox\/([^/]+)\/ack$/, async (_req, body, [idStr]) => {
    const id = Number(idStr);
    const cur = orch.store.getOutbox(id);
    if (!cur) return { status: 404, body: { error: `no effect ${idStr}` } };
    if (cur.status === 'applied') return { status: 200, body: { ok: true, effect: cur, duplicate: true } };
    const effect = orch.store.transaction(() => {
      orch.store.appendEvent({ kind: 'operator.ack', taskId: cur.taskId, payload: { effectId: id, result: body['result'] ?? null } }, orch.now());
      return orch.store.ackOutbox(id, body['result'] ?? null, orch.now());
    });
    return { status: 200, body: { ok: true, effect } };
  });
  server.addRoute('POST', /^\/v1\/outbox\/([^/]+)\/nack$/, async (_req, body, [idStr]) => {
    const id = Number(idStr);
    const cur = orch.store.getOutbox(id);
    if (!cur) return { status: 404, body: { error: `no effect ${idStr}` } };
    if (cur.status === 'applied') return { status: 409, body: { ok: false, reason: `effect ${id} is already applied`, effect: cur } };
    const error = String(body['error'] ?? 'unknown error');
    const effect = orch.store.transaction(() => {
      orch.store.appendEvent({ kind: 'operator.nack', taskId: cur.taskId, payload: { effectId: id, error } }, orch.now());
      return orch.store.nackOutbox(id, error, orch.config.tracker.maxAttempts);
    });
    return { status: 200, body: { ok: true, effect } };
  });
  server.addRoute('POST', /^\/v1\/shutdown$/, async (_req, body) => {
    const reap = body['reap'] === true || body['reap'] === 'true';
    if (!orch.requestShutdown) return { status: 409, body: { ok: false, reason: 'shutdown not available in this host' } };
    setTimeout(() => orch.requestShutdown?.(reap), 50);
    return { status: 200, body: { ok: true, reap } };
  });
  server.addRoute('POST', /^\/v1\/tick$/, async () => {
    await orch.tick();
    return { status: 200, body: { ok: true } };
  });
}
