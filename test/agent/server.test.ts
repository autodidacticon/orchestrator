import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiServer, isLoopbackBind } from '../../src/agent/server.js';
import type { Orchestrator } from '../../src/loop/orchestrator.js';
import { SqliteStore } from '../../src/state/sqlite.js';

/** The HTTP boundary answers 400 naming the field when the store refuses a value. See specs/agent-protocol "Integer fields". */
const servers: ApiServer[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const s of stores.splice(0)) s.close();
});

function serve(store: SqliteStore): ApiServer {
  const orch = { store, apiBaseUrl: '', requestBegan: () => undefined, requestEnded: () => undefined, isLiveAttachment: () => true } as unknown as Orchestrator;
  const server = new ApiServer(orch);
  servers.push(server);
  return server;
}

describe('ApiServer and unstorable values', () => {
  it('a route whose write the store refuses answers 400 with the field, and nothing is written', async () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const server = serve(store);
    server.addRoute('POST', /^\/v1\/probe-write$/, async (_req, body) => {
      store.transaction(() => {
        store.appendEvent({ kind: 'before' }, 1);
        store.putDedup('L1', body['n'] as number, { ok: true });
      });
      return { status: 200, body: { ok: true } };
    });
    const url = await server.listen(0);
    const res = await fetch(`${url}/v1/probe-write`, { method: 'POST', body: JSON.stringify({ n: 1.5 }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'dedup.seq', error: expect.stringMatching(/dedup\.seq must be a safe integer/) });
    expect(store.latestEventSeq()).toBe(0);
    const ok = await fetch(`${url}/v1/probe-write`, { method: 'POST', body: JSON.stringify({ n: 2 }) });
    expect(ok.status).toBe(200);
  });

  it('any other error still answers 500', async () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const server = serve(store);
    server.addRoute('POST', /^\/v1\/boom$/, async () => {
      throw new Error('boom');
    });
    const url = await server.listen(0);
    const res = await fetch(`${url}/v1/boom`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(500);
  });
});

/** See specs/operator-control "Requests from another origin are refused". */
describe('ApiServer refuses requests from another origin', () => {
  interface Probe {
    server: ApiServer;
    calls: { handler: number; began: number };
  }

  async function probeServer(opts: { bind?: string; baseUrl?: string } = {}): Promise<Probe> {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const calls = { handler: 0, began: 0 };
    const orch = { store, apiBaseUrl: '', requestBegan: () => void calls.began++, requestEnded: () => undefined, isLiveAttachment: () => true } as unknown as Orchestrator;
    const server = new ApiServer(orch);
    servers.push(server);
    const handler = async () => {
      calls.handler++;
      return { status: 200, body: { ok: true } };
    };
    server.addRoute('POST', /^\/v1\/thing$/, handler);
    server.addRoute('GET', /^\/v1\/thing$/, handler);
    await server.listen(0, opts);
    return { server, calls };
  }

  /** Sends a request to 127.0.0.1 with exactly the given headers (no Host unless given). */
  function send(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, headers, setHost: false, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /** An HTTP/1.0 request with no Host header, over a raw socket. */
  function sendNoHost(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write('GET /v1/thing HTTP/1.0\r\n\r\n'));
      const chunks: Buffer[] = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('error', reject);
      sock.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0);
        const raw = text.slice(text.indexOf('\r\n\r\n') + 4);
        resolve({ status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      });
    });
  }

  it('a POST with an Origin header is answered 403 before the handler and before requestBegan', async () => {
    const { server, calls } = await probeServer();
    const res = await send(server.port, 'POST', '/v1/thing', { host: `127.0.0.1:${server.port}`, origin: 'https://example.com', 'content-type': 'application/json' }, '{"a":1}');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'originHeader', error: expect.stringMatching(/Origin/) });
    expect(calls).toEqual({ handler: 0, began: 0 });
  });

  it('Origin: null, a GET, an OPTIONS request and an unknown path are all answered 403 originHeader', async () => {
    const { server, calls } = await probeServer();
    const host = `127.0.0.1:${server.port}`;
    for (const [method, path, origin] of [
      ['POST', '/v1/thing', 'null'],
      ['GET', '/v1/thing', 'https://example.com'],
      ['OPTIONS', '/v1/thing', 'https://example.com'],
      ['GET', '/no/such/route', 'https://example.com'],
    ] as const) {
      const res = await send(server.port, method, path, { host, origin });
      expect(res.status, `${method} ${path} ${origin}`).toBe(403);
      expect(res.body.code).toBe('originHeader');
    }
    expect(calls).toEqual({ handler: 0, began: 0 });
  });

  it('on a 127.0.0.1 bind, the bound address and localhost with the port pass; other Hosts get 403 hostHeader', async () => {
    const { server, calls } = await probeServer({ bind: '127.0.0.1' });
    const port = server.port;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `localhost.:${port}`]) {
      const res = await send(port, 'GET', '/v1/thing', { host });
      expect(res.status, host).toBe(200);
    }
    expect(calls.handler).toBe(4);
    const otherPort = port === 65535 ? port - 1 : port + 1;
    for (const host of [`evil.example:${port}`, `localhost:${otherPort}`, 'localhost', `user@localhost:${port}`]) {
      const res = await send(port, 'GET', '/v1/thing', { host });
      expect(res.status, host).toBe(403);
      expect(res.body).toMatchObject({ code: 'hostHeader', error: expect.stringContaining(host) });
      expect(res.body.error).toMatch(/apiBaseUrl/);
    }
    const noHost = await sendNoHost(port);
    expect(noHost.status).toBe(403);
    expect(noHost.body.code).toBe('hostHeader');
    expect(calls).toEqual({ handler: 4, began: 4 });
  });

  it('on a loopback bind, the apiBaseUrl host passes beside the bound address', async () => {
    const http1 = await probeServer({ bind: '127.0.0.1', baseUrl: 'http://orch.test:8080' });
    expect((await send(http1.server.port, 'GET', '/v1/thing', { host: 'orch.test:8080' })).status).toBe(200);
    expect((await send(http1.server.port, 'GET', '/v1/thing', { host: 'orch.test:9999' })).status).toBe(403);
    expect((await send(http1.server.port, 'GET', '/v1/thing', { host: `127.0.0.1:${http1.server.port}` })).status).toBe(200);

    const https = await probeServer({ bind: '127.0.0.1', baseUrl: 'https://orch.test' });
    expect((await send(https.server.port, 'GET', '/v1/thing', { host: 'orch.test' })).status).toBe(200);
    expect((await send(https.server.port, 'GET', '/v1/thing', { host: 'orch.test:443' })).status).toBe(200);
    const port80 = await send(https.server.port, 'GET', '/v1/thing', { host: 'orch.test:80' });
    expect(port80.status).toBe(403);
    expect(port80.body.code).toBe('hostHeader');
  });

  it('on a 0.0.0.0 bind there is no Host check, but Origin is still refused', async () => {
    const { server, calls } = await probeServer({ bind: '0.0.0.0' });
    expect((await send(server.port, 'GET', '/v1/thing', { host: '10.1.2.3:8080' })).status).toBe(200);
    const withOrigin = await send(server.port, 'GET', '/v1/thing', { host: '10.1.2.3:8080', origin: 'https://example.com' });
    expect(withOrigin.status).toBe(403);
    expect(withOrigin.body.code).toBe('originHeader');
    expect(calls).toEqual({ handler: 1, began: 1 });
  });

  it('isLoopbackBind follows the stated rule', () => {
    for (const b of ['localhost', '::1', '127.0.0.1', '127.1.2.3', 'LOCALHOST']) expect(isLoopbackBind(b), b).toBe(true);
    for (const b of ['0.0.0.0', '::', '10.0.0.1', '128.0.0.1', 'foo.localhost', '127.0.0.256']) expect(isLoopbackBind(b), b).toBe(false);
  });
});
