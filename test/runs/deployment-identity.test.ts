/**
 * Deployment identity on store.kind postgres (ORC-87), as real daemon processes against the test database:
 * two daemons on the same repository path with different git.originUrl values get different run ids and keep
 * their rows apart; store.runId and ORCH_RUN_ID set the id; an invalid id fails startup naming it; the path hash
 * is used with one warning; a check command and a spawned agent never see the store URL.
 * Skipped without Postgres (see test/state/pg-db.ts), with the reason printed.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { daemonCommand, health } from '../../src/runs/lifecycle.js';
import { readDaemonJson, runIdFor, runIdForOrigin, runPaths } from '../../src/runs/runDir.js';
import { adminClient, dropRun, pgAvailable, pgSkipReason, stopTestPostgres, TEST_SCHEMA, testDatabase } from '../state/pg-db.js';
import { freePort, gitIn, makeRepo, scriptedAgent, tsxLoader } from '../slice/harness.js';

const PASSWORD = 'pw-Orc87-s3cret';

// Skipped when Postgres is not available; the run's global setup prints the reason once (test/setup/postgres.ts).

let dirs: string[] = [];
let children: ChildProcess[] = [];
let runIds: string[] = [];

function fresh(): string {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-depid-')));
  dirs.push(d);
  return d;
}

async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs = 30_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitFor timed out: ${what}`);
}

async function databaseUrl(): Promise<string> {
  const conn = await testDatabase();
  if (typeof conn === 'string') {
    const u = new URL(conn);
    if (!u.password) u.password = PASSWORD;
    return u.toString();
  }
  return `postgresql://${conn.user}:${PASSWORD}@${encodeURIComponent(String(conn.host))}:${conn.port}/${conn.database}`;
}

interface Daemon {
  child: ChildProcess;
  stderr: () => string;
  exited: Promise<number | null>;
}

function launch(args: string[], env: NodeJS.ProcessEnv, cwd: string): Daemon {
  const { command, args: base } = daemonCommand();
  const child = spawn(command, [...base, ...args], { cwd, env: { ...process.env, ORCH_LOG_FORMAT: 'json', ORCH_URL: '', DATABASE_URL: '', ORCH_RUN_ID: '', ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  let err = '';
  child.stderr?.on('data', (b: Buffer) => (err += b.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  return { child, stderr: () => err, exited };
}

async function urlOf(d: Daemon, dataDir: string): Promise<string> {
  let url = '';
  await waitFor(async () => {
    const info = readDaemonJson(dataDir);
    if (!info || info.pid !== d.child.pid) return false;
    url = info.url;
    return (await health(url)) !== undefined;
  }, 30_000, `daemon in ${dataDir} healthy; stderr: ${d.stderr().slice(-2000)}`);
  return url;
}

function logLines(d: Daemon): Array<Record<string, unknown>> {
  return d
    .stderr()
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

function openedRunId(d: Daemon): string | undefined {
  const line = logLines(d).find((l) => l['msg'] === 'store opened');
  return line?.['runId'] as string | undefined;
}

async function api(url: string, method: string, route: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}${route}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function stop(d: Daemon): Promise<void> {
  if (d.child.exitCode === null && d.child.signalCode === null) d.child.kill('SIGTERM');
  await d.exited;
}

const node = (id: string, behavior = 'commitAndSubmit') => ({ id, deps: [], behavior, description: `task ${id}`, acceptanceCriteria: ['a'] });

afterEach(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  children = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  dirs = [];
  if (pgAvailable) for (const r of runIds.splice(0)) await dropRun(r).catch(() => undefined);
});

afterAll(async () => {
  await stopTestPostgres();
});

describe.skipIf(!pgAvailable)('deployment identity on store.kind postgres', () => {
  it('two daemons on the same repository path with different git.originUrl values get different run ids, both run, and neither loads the other\'s rows', async () => {
    const root = fresh();
    const repo = realpathSync(makeRepo(root));
    const url = await databaseUrl();
    const configFor = async (name: string, origin: string) => {
      const dataDir = path.join(root, `run-${name}`);
      const file = path.join(root, `${name}.yaml`);
      writeFileSync(
        file,
        [
          `repoPath: ${repo}`,
          `dataDir: ${dataDir}`,
          `graphPath: ${path.join(dataDir, 'graph.yaml')}`,
          'integrationBranch: main',
          `apiPort: ${await freePort()}`,
          'runner:',
          '  mode: pull',
          'daemon:',
          '  idleExitMs: 0',
          'tickIntervalMs: 100',
          'leaseTtlMs: 600000',
          'checkCommand: "true"',
          'store:',
          '  kind: postgres',
          'git:',
          `  originUrl: ${origin}`,
        ].join('\n'),
      );
      return { file, dataDir, origin };
    };
    const a = await configFor('a', 'https://git.example/team-a.git');
    const b = await configFor('b', 'https://git.example/team-b.git');
    const idA = runIdForOrigin(a.origin);
    const idB = runIdForOrigin(b.origin);
    runIds.push(idA, idB, runIdFor(repo));
    expect(idA).not.toBe(idB);

    const env = { DATABASE_URL: url };
    const da = launch(['--config', a.file], env, repo);
    const db = launch(['--config', b.file], env, repo);
    const [ua, ub] = await Promise.all([urlOf(da, a.dataDir), urlOf(db, b.dataDir)]);
    expect(openedRunId(da)).toBe(idA);
    expect(openedRunId(db)).toBe(idB);

    expect((await api(ua, 'PUT', '/v1/graph', { nodes: [node('A1')] })).body).toMatchObject({ accepted: true });
    expect((await api(ub, 'PUT', '/v1/graph', { nodes: [node('B1')] })).body).toMatchObject({ accepted: true });
    await api(ua, 'POST', '/v1/tick');
    await api(ub, 'POST', '/v1/tick');
    const claimable = async (u: string) => ((await api(u, 'GET', '/v1/status')).body['claimable'] as string[]) ?? [];
    await waitFor(async () => (await claimable(ua)).length === 1 && (await claimable(ub)).length === 1, 30_000, 'one claimable launch each');
    expect(await claimable(ua)).toEqual(['A1']);
    expect(await claimable(ub)).toEqual(['B1']);

    // The rows are apart in the database: each run id holds its own task only.
    await stop(da);
    await stop(db);
    const c = await adminClient();
    try {
      const tasksOf = async (id: string) => (await c.query(`select task_id from ${TEST_SCHEMA}.launches where run_id = $1 order by 1`, [id])).rows.map((r) => r.task_id as string);
      expect(await tasksOf(idA)).toEqual(['A1']);
      expect(await tasksOf(idB)).toEqual(['B1']);
      expect(await tasksOf(runIdFor(repo))).toEqual([]);
    } finally {
      await c.end();
    }

    // Restarted on an empty data directory, A loads A's run and not B's.
    rmSync(a.dataDir, { recursive: true, force: true });
    const da2 = launch(['--config', a.file], env, repo);
    const ua2 = await urlOf(da2, a.dataDir);
    expect(openedRunId(da2)).toBe(idA);
    await waitFor(async () => (await claimable(ua2)).length > 0, 30_000, 'A claimable after restart');
    expect(await claimable(ua2)).toEqual(['A1']);
    await stop(da2);
  }, 90_000);

  it('store.runId wins over ORCH_RUN_ID; ORCH_RUN_ID sets the id when the file does not; the run directory follows the id', async () => {
    const url = await databaseUrl();
    for (const [lines, envId, expected] of [
      [['  runId: file-id-87'], 'env-id-87', 'file-id-87'],
      [[], 'env-id-87', 'env-id-87'],
    ] as const) {
      const repo = realpathSync(makeRepo(fresh()));
      writeFileSync(path.join(repo, 'orchestrator.yaml'), ['runner:', '  mode: pull', 'daemon:', '  idleExitMs: 0', `apiPort: ${await freePort()}`, 'store:', '  kind: postgres', ...lines, ''].join('\n'));
      appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/orchestrator.yaml\n');
      runIds.push(expected);
      const home = fresh();
      const env = { ORCH_HOME: home, DATABASE_URL: url, ORCH_RUN_ID: envId };
      const d = launch(['--repo', repo], env, repo);
      const dataDir = runPaths(repo, env).runDir;
      expect(path.basename(dataDir)).toBe(expected);
      await urlOf(d, dataDir);
      expect(openedRunId(d)).toBe(expected);
      expect(logLines(d).filter((l) => String(l['msg']).includes('path hash'))).toHaveLength(0);
      await stop(d);
    }
  }, 60_000);

  it('an invalid ORCH_RUN_ID or store.runId fails startup with a message naming it', async () => {
    const url = await databaseUrl();
    for (const [lines, envId, named] of [
      [[], 'bad id!', 'invalid run id "bad id!" from ORCH_RUN_ID'],
      [['  runId: "x/../y"'], '', 'invalid run id "x/../y" from store.runId'],
    ] as const) {
      const repo = realpathSync(makeRepo(fresh()));
      writeFileSync(path.join(repo, 'orchestrator.yaml'), ['store:', '  kind: postgres', ...lines, ''].join('\n'));
      const d = launch(['--repo', repo], { ORCH_HOME: fresh(), DATABASE_URL: url, ORCH_RUN_ID: envId }, repo);
      expect(await d.exited).not.toBe(0);
      expect(d.stderr().replace(/\\"/g, '"')).toContain(named);
    }
  }, 60_000);

  it('with neither an explicit id nor git.originUrl (and no origin remote) the daemon starts on the path hash and logs one warning', async () => {
    const url = await databaseUrl();
    const repo = realpathSync(makeRepo(fresh()));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), ['runner:', '  mode: pull', 'daemon:', '  idleExitMs: 0', `apiPort: ${await freePort()}`, 'store:', '  kind: postgres', ''].join('\n'));
    appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/orchestrator.yaml\n');
    runIds.push(runIdFor(repo));
    const env = { ORCH_HOME: fresh(), DATABASE_URL: url };
    const d = launch(['--repo', repo], env, repo);
    const dataDir = runPaths(repo, env).runDir;
    expect(path.basename(dataDir)).toBe(runIdFor(repo));
    const u = await urlOf(d, dataDir);
    expect(openedRunId(d)).toBe(runIdFor(repo));
    expect((await api(u, 'PUT', '/v1/graph', { nodes: [node('P1')] })).body).toMatchObject({ accepted: true });
    const warnings = logLines(d).filter((l) => l['level'] === 'warn' && String(l['msg']).includes('path hash'));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]!['msg'])).toContain('set store.runId, ORCH_RUN_ID or git.originUrl');
    await stop(d);
  }, 60_000);

  it('as the base manifest runs it (pushIntegration on, no git.originUrl), the run id is the hash of the clone\'s origin, with no warning', async () => {
    const url = await databaseUrl();
    const root = fresh();
    const seed = realpathSync(makeRepo(root));
    const bare = path.join(root, 'origin.git');
    gitIn(root, 'clone', '-q', '--bare', seed, bare);
    const repo = path.join(root, 'clone');
    gitIn(root, 'clone', '-q', bare, repo);
    writeFileSync(path.join(repo, 'orchestrator.yaml'), ['runner:', '  mode: pull', 'daemon:', '  idleExitMs: 0', `apiPort: ${await freePort()}`, 'store:', '  kind: postgres', 'git:', '  pushIntegration: true', ''].join('\n'));
    appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/orchestrator.yaml\n');
    const expected = runIdForOrigin(bare);
    runIds.push(expected);
    const env = { ORCH_HOME: fresh(), DATABASE_URL: url };
    const d = launch(['--repo', repo], env, repo);
    const dataDir = runPaths(realpathSync(repo), env).runDir;
    expect(path.basename(dataDir)).toBe(expected);
    await urlOf(d, dataDir);
    expect(openedRunId(d)).toBe(expected);
    expect(expected).not.toBe(runIdFor(realpathSync(repo)));
    expect(logLines(d).filter((l) => String(l['msg']).includes('path hash'))).toHaveLength(0);
    await stop(d);
  }, 60_000);

  describe('child environments', () => {
    async function spawnRun(opts: { urlInFile: boolean }) {
      const url = await databaseUrl();
      const root = fresh();
      const repo = realpathSync(makeRepo(root));
      const checkOut = path.join(root, 'check.env');
      const agentOut = path.join(root, 'agent.env');
      const yaml = [
        'runner:',
        '  mode: spawn',
        'daemon:',
        '  idleExitMs: 0',
        `apiPort: ${await freePort()}`,
        'tickIntervalMs: 100',
        'leaseTtlMs: 600000',
        `checkCommand: "env > ${checkOut}"`,
        `runnerCommand: "env > ${agentOut} && node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`,
        'store:',
        '  kind: postgres',
        '  runId: orc87-childenv-' + (opts.urlInFile ? 'file' : 'env'),
        ...(opts.urlInFile ? [`  url: "${url}"`] : []),
        '',
      ];
      writeFileSync(path.join(repo, 'orchestrator.yaml'), yaml.join('\n'));
      appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/orchestrator.yaml\n');
      runIds.push(`orc87-childenv-${opts.urlInFile ? 'file' : 'env'}`);
      // The URL under a name of the project's own, besides DATABASE_URL.
      const env = { ORCH_HOME: fresh(), APP_DATABASE: url, ...(opts.urlInFile ? {} : { DATABASE_URL: url }), KEEP_ME: 'yes' };
      return { url, repo, checkOut, agentOut, env };
    }

    for (const urlInFile of [false, true]) {
      it(`a check command and a spawned agent that print their environment see neither DATABASE_URL nor the store URL (URL from ${urlInFile ? 'an untracked config file' : 'DATABASE_URL'})`, async () => {
        const r = await spawnRun({ urlInFile });
        const d = launch(['--repo', r.repo], r.env, r.repo);
        const dataDir = runPaths(r.repo, r.env).runDir;
        const u = await urlOf(d, dataDir);
        expect((await api(u, 'PUT', '/v1/graph', { nodes: [node('E1')] })).body).toMatchObject({ accepted: true });
        await api(u, 'POST', '/v1/tick');
        await waitFor(() => existsSync(r.agentOut) && existsSync(r.checkOut), 60_000, `agent and check ran; stderr: ${d.stderr().slice(-2000)}`);
        await waitFor(async () => ((await api(u, 'GET', '/v1/status')).body['byStatus'] as Record<string, string[]>)['done']?.length === 1, 30_000, 'E1 done');
        for (const file of [r.agentOut, r.checkOut]) {
          const text = readFileSync(file, 'utf8');
          expect(text).not.toMatch(/^DATABASE_URL=/m);
          expect(text).not.toMatch(/^ORCH_RUN_ID=/m);
          expect(text).not.toMatch(/^APP_DATABASE=/m);
          expect(text).not.toContain(PASSWORD);
          expect(text).toMatch(/^KEEP_ME=yes$/m);
        }
        // The worktree had no config file holding the URL.
        const wt = gitIn(r.repo, 'ls-tree', '-r', '--name-only', 'main');
        expect(wt).not.toContain('orchestrator.yaml');
        await stop(d);
      }, 90_000);
    }

    it('a tracked config file holding store.url is refused at startup', async () => {
      const r = await spawnRun({ urlInFile: true });
      gitIn(r.repo, 'add', '-f', 'orchestrator.yaml');
      gitIn(r.repo, 'commit', '-q', '-m', 'config with url');
      const d = launch(['--repo', r.repo], r.env, r.repo);
      expect(await d.exited).not.toBe(0);
      expect(d.stderr()).toContain('sets store.url and is tracked by git');
      expect(d.stderr()).not.toContain(PASSWORD);
    }, 60_000);
  });
});

describe.skipIf(pgAvailable)('deployment identity on store.kind postgres (skipped)', () => {
  it.skip(`skipped: no Postgres for tests (${pgSkipReason ?? 'none'})`, () => undefined);
});
