/**
 * Loopback HTTP server for agents and operators.
 *   POST /v1/launches/:id/{heartbeat,report,block,log}
 *   GET  /v1/launches/:id/inbox
 * Operator routes are registered by operator/routes.ts.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentOp, ApiResponse, Orchestrator } from '../loop/orchestrator.js';

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

  constructor(private readonly orch: Orchestrator) {
    this.server = http.createServer((req, res) => void this.dispatch(req, res));
    this.server.keepAliveTimeout = 5_000;
    this.addRoute('POST', /^\/v1\/launches\/([^/]+)\/(heartbeat|report|block|log)$/, async (req, body, [launchId, op]) => {
      const token = bearer(req);
      return this.orch.agentCall(launchId as string, token, op as AgentOp, body);
    });
    this.addRoute('GET', /^\/v1\/launches\/([^/]+)\/inbox$/, async (req, _body, [launchId]) => {
      return this.orch.agentCall(launchId as string, bearer(req), 'inbox', {});
    });
  }

  addRoute(method: Route['method'], pattern: RegExp, handler: RouteHandler): void {
    this.routes.push({ method, pattern, handler });
  }

  async listen(port = 0): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    this.port = (this.server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${this.port}`;
    this.orch.apiBaseUrl = url;
    return url;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      try {
        const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : Object.fromEntries(url.searchParams.entries());
        const out = await r.handler(req, body, m.slice(1));
        send(res, out.status, out.body);
      } catch (err) {
        send(res, 500, { error: String(err) });
      }
      return;
    }
    send(res, 404, { error: 'not found' });
  }
}

function bearer(req: http.IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? {});
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}
