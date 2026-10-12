/**
 * Operator HTTP routes. Every action is an event (recorded by the orchestrator).
 */
import type { ApiServer } from '../agent/server.js';
import type { ApiResponse, Orchestrator } from '../loop/orchestrator.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { logPath } from '../runner/subprocess.js';

function result(r: { ok: true } | { ok: false; reason: string; blockers?: string[] }): ApiResponse {
  return r.ok ? { status: 200, body: { ok: true } } : { status: 409, body: { ok: false, reason: r.reason, blockers: (r as { blockers?: string[] }).blockers } };
}

export function registerOperatorRoutes(server: ApiServer, orch: Orchestrator): void {
  server.addRoute('GET', /^\/v1\/status$/, async () => ({ status: 200, body: orch.hasGraph() ? (orch.status() as unknown as Record<string, unknown>) : { graphRev: undefined, error: 'graph not loaded' } }));
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
  server.addRoute('POST', /^\/v1\/resume$/, async () => {
    orch.resume();
    return { status: 200, body: { ok: true, paused: false } };
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
  server.addRoute('POST', /^\/v1\/tick$/, async () => {
    await orch.tick();
    return { status: 200, body: { ok: true } };
  });
}
