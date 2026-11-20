/**
 * Loopback HTTP server for agents and operators.
 *   POST /v1/launches/:id/{heartbeat,report,block,log}
 *   GET  /v1/launches/:id/inbox
 * Health probes (/healthz, /readyz) and operator routes are registered by operator/routes.ts.
 * Operator routes are registered by operator/routes.ts.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentOp, ApiResponse, Orchestrator } from '../loop/orchestrator.js';
import { StoreFatalError, waitDurable } from '../state/gate.js';
import { isUnstorable } from '../state/storable.js';

export type RouteHandler = (req: http.IncomingMessage, body: Record<string, unknown>, params: string[]) => Promise<ApiResponse>;

export interface Route {
  method: 'GET' | 'POST' | 'PUT';
  pattern: RegExp;
  handler: RouteHandler;
}

export class ApiServer {
  private readonly server: http.Server;
  private readonly routes: Route[] = [];
  port = 0;
  /** Accepted `Host` values on a loopback bind; undefined when the bind is not loopback (no `Host` check). */
  private acceptedHosts: HostEntry[] | undefined;

  constructor(private readonly orch: Orchestrator) {
    this.server = http.createServer((req, res) => void this.dispatch(req, res));
    this.server.keepAliveTimeout = 5_000;
    this.addRoute('POST', /^\/v1\/launches\/([^/]+)\/(heartbeat|report|block|log)$/, async (req, body, [launchId, op]) => {
      const token = bearer(req);
      return this.orch.agentCall(launchId as string, token, op as AgentOp, body);
    });
    this.addRoute('GET', /^\/v1\/launches\/([^/]+)\/inbox$/, async (req, _body, [launchId]) => {
      // The inbox removes the notices it hands out only while the caller is still there to read them. See specs/agent-protocol "Inbox notices handed out once".
      return this.orch.agentCall(launchId as string, bearer(req), 'inbox', {}, { connected: () => !req.socket.destroyed });
    });
  }

  addRoute(method: Route['method'], pattern: RegExp, handler: RouteHandler): void {
    this.routes.push({ method, pattern, handler });
  }

  /** Binds to `bind` and returns the advertised URL: `baseUrl` when set, else `http://<bind>:<port>`. */
  async listen(port = 0, opts: { bind?: string; baseUrl?: string } = {}): Promise<string> {
    const bind = opts.bind ?? '127.0.0.1';
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(port, bind, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    this.port = (this.server.address() as AddressInfo).port;
    // Rebuilt on every listen: a fallback port calls listen again on this object. See specs/operator-control "Requests from another origin are refused".
    this.acceptedHosts = acceptedHosts(bind, this.port, opts.baseUrl);
    const url = opts.baseUrl ? opts.baseUrl.replace(/\/+$/, '') : `http://${bind.includes(':') ? `[${bind}]` : bind}:${this.port}`;
    this.orch.apiBaseUrl = url;
    return url;
  }

  async close(): Promise<void> {
    // Close open connections (a long-polling block or inbox) before waiting, or the close callback waits for them.
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Refused before routing, before activity is counted and before the body is read. See specs/operator-control "Requests from another origin are refused".
    const refused = refusal(req, this.acceptedHosts);
    if (refused) {
      send(res, 403, refused, { connection: 'close' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      // A probe is a liveness check that must not count as activity. See specs/operator-control "Idle exit" and specs/cluster-runtime "Probes".
      const probe = req.method === 'GET' && ((url.pathname === '/v1/status' && url.searchParams.get('probe') === '1') || url.pathname === '/healthz' || url.pathname === '/readyz');
      const attachment = req.headers['x-orch-attachment'];
      const attachmentId = typeof attachment === 'string' && attachment ? attachment : undefined;
      this.orch.requestBegan();
      // A write's response waits until its record is durable; a read answers from the image. See specs/state-backend "Reads".
      const writes = req.method === 'POST' || req.method === 'PUT';
      try {
        const body = writes ? await readJson(req) : Object.fromEntries(url.searchParams.entries());
        const out = await r.handler(req, body, m.slice(1));
        // A fatal journal answers at once with the fatal error instead of waiting for a durability that never comes.
        if (writes) await waitDurable(this.orch.store);
        // The operation stands; the caller learns its attachment is unknown and registers again. See specs/operator-control "Session attachments".
        const headers = attachmentId && !this.orch.isLiveAttachment(attachmentId) ? { 'x-orch-attachment': 'unknown' } : undefined;
        send(res, out.status, out.body, headers);
      } catch (err) {
        if (err instanceof StoreFatalError) send(res, 503, { error: err.message, code: 'storeFatal' });
        else if (err instanceof BodyTooLargeError) send(res, 413, { error: err.message });
        else {
          try {
            if (writes) await waitDurable(this.orch.store);
            // A value the store cannot hold: the write did not happen. See specs/agent-protocol "Integer fields".
            if (isUnstorable(err)) send(res, 400, { error: err.message, field: err.field });
            else send(res, 500, { error: String(err) });
          } catch (fatal) {
            send(res, fatal instanceof StoreFatalError ? 503 : 500, { error: fatal instanceof Error ? fatal.message : String(fatal), ...(fatal instanceof StoreFatalError ? { code: 'storeFatal' } : {}) });
          }
        }
      } finally {
        this.orch.requestEnded(probe);
      }
      return;
    }
    send(res, 404, { error: 'not found' });
  }
}

interface HostEntry {
  host: string;
  port: number;
  /** The default port of the entry's scheme, which a `Host` without a port stands for. */
  defaultPort: number;
}

/** A bind is loopback when it is `localhost`, `::1`, or an IPv4 address in 127.0.0.0/8. */
export function isLoopbackBind(bind: string): boolean {
  const b = bind.toLowerCase();
  if (b === 'localhost' || b === '::1' || b === '[::1]') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(b);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

function normalHost(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith('[')) return n;
  if (n.includes(':')) return `[${n}]`;
  return n.endsWith('.') ? n.slice(0, -1) : n;
}

function acceptedHosts(bind: string, port: number, baseUrl: string | undefined): HostEntry[] | undefined {
  if (!isLoopbackBind(bind)) return undefined;
  const entry = (host: string, p: number, defaultPort = 80): HostEntry => ({ host: normalHost(host), port: p, defaultPort });
  const out: HostEntry[] = [entry(bind, port), entry('localhost', port)];
  if (bind.toLowerCase() === 'localhost') out.push(entry('127.0.0.1', port), entry('[::1]', port));
  if (baseUrl) {
    const u = new URL(baseUrl);
    const defaultPort = u.protocol === 'https:' ? 443 : 80;
    out.push(entry(u.hostname, u.port ? Number(u.port) : defaultPort, defaultPort));
  }
  return out;
}

const HOST_PATTERN = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?$/;

/** Why a request is refused before routing, or undefined. The `Origin` rule comes before the `Host` rule. */
function refusal(req: http.IncomingMessage, accepted: HostEntry[] | undefined): { error: string; code: string } | undefined {
  if (req.headers.origin !== undefined) {
    return { error: 'request refused: the API does not accept requests that carry an Origin header', code: 'originHeader' };
  }
  if (!accepted) return undefined;
  const raw = req.headers.host;
  const m = raw === undefined ? null : HOST_PATTERN.exec(raw);
  if (m) {
    const host = normalHost(m[1] as string);
    const port = m[2] === undefined ? undefined : Number(m[2]);
    if (accepted.some((e) => e.host === host && e.port === (port ?? e.defaultPort))) return undefined;
  }
  return {
    error: `request refused: Host header ${raw === undefined ? '(missing)' : JSON.stringify(raw)} is not an address this server listens on; set apiBaseUrl to add a host`,
    code: 'hostHeader',
  };
}

function bearer(req: http.IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body ?? {});
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The largest request body the server reads: 1 MiB. A larger one is answered 413. See specs/agent-protocol "Request body limit". */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Thrown by `readJson` for a body over `MAX_BODY_BYTES`: nothing is handled, and the answer is 413. */
export class BodyTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  // The rest of an oversized body is drained, not kept, so the client reads the 413 instead of a reset connection.
  for await (const c of req) {
    if (tooLarge) continue;
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(c as Buffer);
  }
  if (tooLarge) throw new BodyTooLargeError();
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}
