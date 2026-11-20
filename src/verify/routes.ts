/**
 * The verify-job routes a verifier outside the daemon calls. The claim reads no credential in M5; heartbeat, result
 * and release read only the job token, from `Authorization: Bearer`. Neither a pause nor the hold after a gap stops
 * them, and none appends an operator event: an idle poll must not grow the event log. See specs/verifier-pool.
 */
import type http from 'node:http';
import type { ApiServer } from '../agent/server.js';
import type { Orchestrator } from '../loop/orchestrator.js';
import { claimVerifyJob, postVerifyResult, releaseVerifyJob, verifyHeartbeat } from './claims.js';

/** The bearer value of a request, read as the `renew` route reads it; a missing header reads as the empty token. */
function jobToken(req: http.IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

export function registerVerifyRoutes(server: ApiServer, orch: Orchestrator): void {
  server.addRoute('POST', /^\/v1\/verify\/claims$/, async (_req, body) => claimVerifyJob(orch, body));
  server.addRoute('POST', /^\/v1\/verify\/([^/]+)\/heartbeat$/, async (req, _body, [id]) => verifyHeartbeat(orch, id as string, jobToken(req)));
  server.addRoute('POST', /^\/v1\/verify\/([^/]+)\/result$/, async (req, body, [id]) => postVerifyResult(orch, id as string, jobToken(req), body));
  server.addRoute('POST', /^\/v1\/verify\/([^/]+)\/release$/, async (req, body, [id]) => releaseVerifyJob(orch, id as string, jobToken(req), body));
}
