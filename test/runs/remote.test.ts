/** Client-side revival never spawns a local daemon for a remote ORCH_URL. See specs/operator-control "Container mode". */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isLoopbackUrl, listRuns, remoteDaemonUrl, reviveDaemon, startDaemon, stopDaemon } from '../../src/runs/lifecycle.js';
import { runPaths } from '../../src/runs/runDir.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import { makeRepo, scriptedAgent, tsxLoader } from '../slice/harness.js';

let dirs: string[] = [];
let env: NodeJS.ProcessEnv | undefined;

function fresh(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'orch-remote-'));
  dirs.push(d);
  return d;
}

/** A run whose daemon crashed: a store and no exit record, so revival would start a daemon. */
function crashedRun(): { repo: string; runDir: string } {
  const repo = realpathSync(makeRepo(fresh()));
  writeFileSync(path.join(repo, 'orchestrator.yaml'), [`runnerCommand: "node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`, 'checkCommand: "true"', 'tickIntervalMs: 150'].join('\n') + '\n');
  const runDir = runPaths(repo, env).runDir;
  mkdirSync(runDir, { recursive: true });
  new SqliteStore(path.join(runDir, 'store.sqlite')).close();
  return { repo, runDir };
}

afterEach(async () => {
  if (env) for (const r of await listRuns(env)) if (r.alive && r.repo) await stopDaemon({ repo: r.repo, env: { ...env, ORCH_URL: undefined }, reap: true });
  env = undefined;
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  dirs = [];
});

describe('remote ORCH_URL', () => {
  it('tells loopback hosts from remote ones', () => {
    for (const u of ['http://127.0.0.1:8080', 'http://127.1.2.3', 'http://localhost:1', 'http://LOCALHOST', 'http://api.localhost', 'http://[::1]:8080']) expect(isLoopbackUrl(u), u).toBe(true);
    for (const u of ['http://orchestrator.orch.svc:8080', 'http://10.0.0.5:8080', 'https://orch.example.com', 'http://0.0.0.0:8080', 'not a url']) expect(isLoopbackUrl(u), u).toBe(false);
    expect(remoteDaemonUrl({})).toBeUndefined();
    expect(remoteDaemonUrl({ ORCH_URL: 'http://127.0.0.1:9' })).toBeUndefined();
    expect(remoteDaemonUrl({ ORCH_URL: 'http://orchestrator.orch.svc:8080/' })).toBe('http://orchestrator.orch.svc:8080');
  });

  it('reports a remote URL as unreachable and spawns nothing', async () => {
    env = { ...process.env, ORCH_HOME: fresh(), ORCH_URL: 'http://orchestrator.orch.invalid:8080' };
    const { repo, runDir } = crashedRun();
    await expect(reviveDaemon({ repo, env, timeoutMs: 5000 })).rejects.toThrow(/orchestrator\.orch\.invalid:8080 \(ORCH_URL\) is unreachable/);
    await expect(startDaemon({ repo, env, timeoutMs: 5000 })).rejects.toThrow(/unreachable/);
    expect(existsSync(path.join(runDir, 'daemon.pid'))).toBe(false);
    expect(existsSync(path.join(runDir, 'daemon.json'))).toBe(false);
    expect((await listRuns(env)).filter((r) => r.alive)).toEqual([]);
  });

  it('revives a local daemon when ORCH_URL is loopback', async () => {
    env = { ...process.env, ORCH_HOME: fresh(), ORCH_URL: 'http://127.0.0.1:9' };
    const { repo, runDir } = crashedRun();
    const revived = await reviveDaemon({ repo, env });
    expect(revived?.started).toBe(true);
    expect(existsSync(path.join(runDir, 'daemon.pid'))).toBe(true);
    expect((await stopDaemon({ repo, env })).stopped).toBe(true);
  }, 40_000);
});
