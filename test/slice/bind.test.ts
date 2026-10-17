import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../src/state/sqlite.js';
import { freePort, makeRepo, tsxLoader } from './harness.js';

const mainTs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/main.ts');

let daemon: ChildProcess | undefined;
let dir: string | undefined;
afterEach(() => {
  if (daemon?.exitCode === null) daemon.kill('SIGKILL');
  if (dir) rmSync(dir, { recursive: true, force: true });
  daemon = undefined;
  dir = undefined;
});

/** A non-loopback IPv4 address of this host, falling back to loopback when there is none. */
function hostAddress(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

async function until<T>(f: () => T | undefined, log: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = f();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`condition not reached; daemon log:\n${readFileSync(log, 'utf8').slice(-4000)}`);
}

describe('bind host and public API base URL (specs/cluster-runtime)', () => {
  it('binds apiBind and advertises apiBaseUrl in kv, daemon.json, status, claims, and briefs', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-bind-'));
    const repo = makeRepo(dir);
    const dataDir = path.join(dir, 'run');
    mkdirSync(dataDir);
    const graphPath = path.join(dir, 'graph.yaml');
    writeFileSync(graphPath, 'nodes:\n  - { id: T1, title: One, description: d, acceptanceCriteria: [a], deps: [] }\n');
    const port = await freePort();
    const configPath = path.join(dir, 'orchestrator.yaml');
    writeFileSync(
      configPath,
      [
        `repoPath: ${repo}`,
        `graphPath: ${graphPath}`,
        `dataDir: ${dataDir}`,
        'integrationBranch: main',
        `apiPort: ${port}`,
        'apiBind: 0.0.0.0',
        'apiBaseUrl: http://orchestrator:8080',
        'tickIntervalMs: 100',
        'checkCommand: "true"',
        'runner:',
        '  mode: pull',
        '  claimWindowMs: 60000',
      ].join('\n'),
    );
    const log = path.join(dir, 'daemon.log');
    const fd = openSync(log, 'a');
    daemon = spawn('node', ['--import', tsxLoader, mainTs, '--config', configPath], { env: { ...process.env }, stdio: ['ignore', fd, fd] });

    const info = await until(() => {
      const f = path.join(dataDir, 'daemon.json');
      return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { url: string; port: number }) : undefined;
    }, log);
    expect(info).toMatchObject({ url: 'http://orchestrator:8080', port });
    const store = new SqliteStore(path.join(dataDir, 'store.sqlite'));
    try {
      expect(store.getKv('apiBaseUrl')).toBe('http://orchestrator:8080');
    } finally {
      store.close();
    }

    // The server answers on a non-loopback address of this host, not only on 127.0.0.1.
    const host = hostAddress();
    const direct = `http://${host}:${port}`;
    const status = (await (await fetch(`${direct}/v1/status`)).json()) as Record<string, unknown>;
    expect(status['daemonUrl']).toBe('http://orchestrator:8080');
    // The probes answer on the bound address too. See specs/cluster-runtime "Probes".
    expect(await (await fetch(`${direct}/healthz`)).json()).toEqual({ ok: true });
    const ready = await fetch(`${direct}/readyz`);
    expect([ready.status, await ready.json()]).toEqual([200, { ok: true }]);

    let body: Record<string, unknown> | undefined;
    const deadline = Date.now() + 30_000;
    while (!body && Date.now() < deadline) {
      const res = await fetch(`${direct}/v1/claims`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workerId: 'w1' }) });
      const b = (await res.json()) as Record<string, unknown>;
      if (res.status === 200 && b['launchId']) body = b;
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(body, readFileSync(log, 'utf8').slice(-4000)).toBeDefined();
    expect(body!['apiUrl']).toBe('http://orchestrator:8080');
    const briefDir = path.dirname(String(body!['briefPath']));
    const md = readFileSync(path.join(briefDir, 'brief.md'), 'utf8');
    expect(md).toContain('http://orchestrator:8080/v1/launches/');
    expect(md).not.toContain('127.0.0.1');
    expect((JSON.parse(readFileSync(path.join(briefDir, 'brief.json'), 'utf8')) as { apiBaseUrl: string }).apiBaseUrl).toBe('http://orchestrator:8080');
  }, 60_000);
});
