/**
 * Operator HTTP routes. Every action is an event (recorded by the orchestrator).
 */
import type { ApiServer } from '../agent/server.js';
import type { ApiResponse, Orchestrator } from '../loop/orchestrator.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify as toYaml } from 'yaml';
import { GraphValidationError, parseGraph } from '../graph/load.js';
import { trackerSchema } from '../import/mapping.js';
import { logPath } from '../runner/subprocess.js';
import { setTracker, trackerOf } from '../state/store.js';
import { policyReport } from '../tracker/policy.js';

export function digestOf(orch: Orchestrator): Record<string, unknown> {
  const tracker = { outboxPending: orch.store.countOutbox('pending'), trackerErrors: orch.trackerErrors() };
  if (!orch.hasGraph()) return { graphLoaded: false, openQuestions: [], awaitingReview: [], finished: false, stalled: false, running: [], blocked: [], stuck: [], pausedReason: orch.pausedReason(), ...tracker };
  const s = orch.status();
  const g = orch.graph();
  return {
    graphLoaded: true,
    ...tracker,
    stuck: s.stuck,
    pausedReason: s.pausedReason,
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
  server.addRoute('POST', /^\/v1\/tasks\/([^/]+)\/reopen$/, async (_req, _body, [id]) => result(orch.reopen(id as string)));
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
    let rev: string;
    try {
      rev = parseGraph(content).rev;
    } catch (err) {
      if (err instanceof GraphValidationError) return { status: 400, body: { error: err.message, code: err.code, details: err.details } };
      throw err;
    }
    if (body['tracker'] !== undefined) {
      const parsed = trackerSchema.safeParse(body['tracker']);
      if (!parsed.success) return { status: 400, body: { error: 'invalid tracker', issues: parsed.error.issues } };
      const rec = { ...parsed.data, recordedAt: orch.now() };
      orch.store.transaction(() => {
        setTracker(orch.store, rec);
        orch.store.appendEvent({ kind: 'tracker.recorded', payload: { ...rec } }, orch.now());
      });
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
