/**
 * The Codex host: hosts/codex's launcher, pinned package.json, MCP registration template, and
 * skill edition. See specs/host-integration "Codex host".
 */
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES, WAIT_CAP_MS } from '../../src/operator/mcp-server.js';
import { listRuns, stopDaemon } from '../../src/runs/lifecycle.js';
import { makeRepo, makeSlice } from '../slice/harness.js';

const execFileP = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const host = path.join(root, 'hosts/codex');
const launcher = path.join(host, 'bin/orchestrator.mjs');
const pkgJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string; version: string };
const hostPkg = JSON.parse(readFileSync(path.join(host, 'package.json'), 'utf8')) as { name: string; private?: boolean; dependencies: Record<string, string> };
const claudePkg = JSON.parse(readFileSync(path.join(root, 'hosts/claude-code/package.json'), 'utf8')) as { dependencies: Record<string, string> };

type TomlValue = string | number | boolean | string[];
type TomlTable = Record<string, TomlValue>;

/**
 * The flat subset of TOML the template uses: [table] and [[array.of.tables]] headers and
 * key = string | number | boolean | string array. An array of tables is listed under its full
 * dotted name, not nested under its parent.
 */
function parseTomlSubset(text: string): { tables: Record<string, TomlTable>; arrays: Record<string, TomlTable[]> } {
  const tables: Record<string, TomlTable> = {};
  const arrays: Record<string, TomlTable[]> = {};
  let current: TomlTable | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const element = /^\[\[([A-Za-z0-9_.-]+)\]\]$/.exec(line);
    if (element) {
      current = {};
      (arrays[element[1]!] ??= []).push(current);
      continue;
    }
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header) {
      current = tables[header[1]!] = {};
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv || !current) throw new Error(`unparsed line: ${line}`);
    current[kv[1]!] = JSON.parse(kv[2]!) as TomlValue;
  }
  return { tables, arrays };
}

const dryRun = async (dir: string, entry: string) => {
  const { stdout } = await execFileP('node', [path.join(dir, 'bin/orchestrator.mjs'), entry], { env: { ...process.env, ORCH_LAUNCHER_DRY_RUN: '1' } });
  return JSON.parse(stdout) as { source: string; command: string; args: string[] };
};

/** Runs hosts/codex's session end script with the given hook input on stdin. */
const sessionEnd = (home: string, input: Record<string, unknown>) =>
  new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn('node', [path.join(host, 'hooks/session-end.mjs')], { env: { ...process.env, ORCH_HOME: home } });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('exit', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(input));
  });

/** A fabricated run directory whose daemon.json points at a live API; the test process stands in for the daemon pid. */
function liveRun(home: string, repo: string, url: string): void {
  const dir = path.join(home, 'runs', 'live');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'repo'), `${repo}\n`);
  writeFileSync(path.join(dir, 'daemon.pid'), `${process.pid}\n`);
  writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ pid: process.pid, url, port: 0, startedAt: 1, repo }));
}

// The two checks that run the installed codex CLI are opt-in, so the unit suite never depends on its version (README "Tests").
const CODEX_HOST = process.env['ORCH_E2E_CODEX_HOST'] === '1';

describe('codex host', () => {
  const template = readFileSync(path.join(host, 'config.toml'), 'utf8');
  const parsed = parseTomlSubset(template);
  const server = parsed.tables['mcp_servers.orchestrator_operator'];

  it('the config template registers the operator server through the launcher with a tool timeout above the wait cap', () => {
    expect(server).toBeDefined();
    expect(server!['command']).toBe('node');
    expect(server!['args']).toEqual(['<hosts/codex>/bin/orchestrator.mjs', 'mcp']);
    expect(server!['startup_timeout_sec']).toBe(30);
    expect(server!['tool_timeout_sec']).toBeGreaterThanOrEqual(Math.ceil(WAIT_CAP_MS / 1000) + 30);
  });

  // A real TOML parser confirms the template: Codex reads it from a scratch CODEX_HOME.
  it.skipIf(!CODEX_HOST)('codex mcp get reads the template as written (ORCH_E2E_CODEX_HOST=1)', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-codex-home-'));
    try {
      writeFileSync(path.join(home, 'config.toml'), template.replaceAll('<hosts/codex>', host));
      const { stdout } = await execFileP('codex', ['mcp', 'get', 'orchestrator_operator', '--json'], { env: { ...process.env, CODEX_HOME: home } });
      const got = JSON.parse(stdout) as { enabled: boolean; transport: { type: string; command: string; args: string[] }; tool_timeout_sec: number; startup_timeout_sec: number };
      expect(got).toMatchObject({ enabled: true, transport: { type: 'stdio', command: 'node', args: [launcher, 'mcp'] } });
      expect(got.tool_timeout_sec).toBe(server!['tool_timeout_sec']);
      expect(got.startup_timeout_sec).toBe(30);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      console.warn('codex CLI not installed; template check through codex skipped');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // See specs/host-integration "Codex plugin".
  it('the Codex plugin: manifest at the package version, .mcp.json run from the plugin root, hooks through PLUGIN_ROOT, and the root marketplace file', () => {
    const readJson = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8')) as Record<string, unknown>;
    const manifest = readJson('hosts/codex/.codex-plugin/plugin.json');
    expect(manifest).toMatchObject({ name: 'orchestrator-codex', skills: './skills/', mcpServers: './.mcp.json', hooks: './hooks/hooks.json' });
    // A release that bumps package.json without the plugin manifest fails here.
    expect(manifest['version']).toBe(pkgJson.version);

    const mcp = readJson('hosts/codex/.mcp.json') as { mcpServers: Record<string, Record<string, unknown>> };
    expect(Object.keys(mcp.mcpServers)).toEqual(['orchestrator_operator']);
    const op = mcp.mcpServers['orchestrator_operator']!;
    expect(op).toMatchObject({ command: 'node', args: ['./bin/orchestrator.mjs', 'mcp'], cwd: '.', startup_timeout_sec: 60 });
    // Codex expands no variable in args: they are relative to cwd ".", the installed plugin root.
    for (const arg of op['args'] as string[]) {
      expect(path.isAbsolute(arg), arg).toBe(false);
      expect(arg).not.toContain('${');
    }
    expect(existsSync(path.join(host, 'bin/orchestrator.mjs'))).toBe(true);
    expect(op['tool_timeout_sec']).toBeGreaterThan(WAIT_CAP_MS / 1000 + 30);
    expect(op['env_vars']).toEqual(['PATH', 'HOME', 'ORCH_HOME', 'ORCH_WAIT_CAP_MS', 'ORCH_REPO']);

    const hooks = readJson('hosts/codex/hooks/hooks.json') as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> };
    expect(Object.keys(hooks.hooks).sort()).toEqual(['SessionEnd', 'SessionStart']);
    expect(hooks.hooks['SessionStart']).toEqual([{ matcher: 'startup|resume|clear', hooks: [{ type: 'command', command: 'node "${PLUGIN_ROOT}/hooks/session-start.mjs"', timeout: 10 }] }]);
    expect(hooks.hooks['SessionEnd']).toEqual([{ hooks: [{ type: 'command', command: 'node "${PLUGIN_ROOT}/hooks/session-end.mjs"' }] }]);

    const market = readJson('.agents/plugins/marketplace.json') as { name: string; plugins: Array<Record<string, unknown>> };
    expect(market.name).toBe('orchestrator');
    expect(market.plugins).toEqual([{ name: 'orchestrator-codex', source: { source: 'local', path: './hosts/codex' }, policy: { installation: 'AVAILABLE' }, category: 'Developer Tools' }]);
    // Claude Code keeps reading its own marketplace file.
    expect((readJson('.claude-plugin/marketplace.json') as { plugins: Array<{ name: string; source: string }> }).plugins).toEqual([expect.objectContaining({ name: 'orchestrator', source: './hosts/claude-code' })]);

    const readme = readFileSync(path.join(host, 'README.md'), 'utf8');
    for (const word of ['codex plugin marketplace add autodidacticon/orchestrator', 'codex plugin add orchestrator-codex@orchestrator', 'codex plugin remove orchestrator@orchestrator', '[plugins."orchestrator-codex@orchestrator".mcp_servers.orchestrator_operator]', '`repo`', 'Manual install']) expect(readme, word).toContain(word);
    expect(readme.indexOf('codex plugin add orchestrator-codex@orchestrator')).toBeLessThan(readme.indexOf('[mcp_servers.orchestrator_operator]'));
    expect(readme).not.toContain('no established plugin manifest');
  });

  // See specs/host-integration "Codex host": a plugin-installed server cannot see the session's project.
  it('the skills tell the model to pass repo, the session\'s working directory, on every operator call', () => {
    for (const name of ['import', 'run', 'review']) {
      const text = readFileSync(path.join(host, 'skills', name, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
      expect(text, name).toContain("Pass `repo`, set to the absolute path of this session's working directory, on every operator tool call.");
    }
  });

  // The plugin from this checkout, installed by the installed codex into a scratch CODEX_HOME. The exec step uses a model.
  it.skipIf(!CODEX_HOST)('codex installs the plugin from the marketplace file and calls its start tool with repo (ORCH_E2E_CODEX_HOST=1)', async () => {
    const codexHome = mkdtempSync(path.join(tmpdir(), 'orch-codex-home-'));
    const home = mkdtempSync(path.join(tmpdir(), 'orch-codex-plugin-orch-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-codex-plugin-repo-'));
    const { ORCH_REPO: _unset, ...parentEnv } = process.env;
    const env = { ...parentEnv, CODEX_HOME: codexHome, ORCH_HOME: home };
    const codex = async (...args: string[]) => (await execFileP('codex', args, { env, timeout: 60_000 })).stdout;
    let repo: string | undefined;
    try {
      await codex('plugin', 'marketplace', 'add', root);
      // Only the Codex marketplace file is read: the Claude Code plugin is not offered.
      const listed = (await codex('plugin', 'list')).split('\n').filter((l) => l.includes('@orchestrator')).map((l) => l.trim().split(/\s+/)[0]);
      expect(listed).toEqual(['orchestrator-codex@orchestrator']);
      const added = await codex('plugin', 'add', 'orchestrator-codex@orchestrator');
      const pluginRoot = /Installed plugin root: (.+)/.exec(added)?.[1]?.trim();
      expect(pluginRoot, added).toBeDefined();
      expect(pluginRoot).toContain(path.join('plugins', 'cache', 'orchestrator', 'orchestrator-codex', pkgJson.version));
      const got = JSON.parse(await codex('mcp', 'get', 'orchestrator_operator', '--json')) as { enabled: boolean; transport: { command: string; args: string[]; cwd: string }; startup_timeout_sec: number; tool_timeout_sec: number };
      expect(got).toMatchObject({ enabled: true, transport: { command: 'node', args: ['./bin/orchestrator.mjs', 'mcp'] }, startup_timeout_sec: 60, tool_timeout_sec: 180 });
      expect(realpathSync(got.transport.cwd)).toBe(realpathSync(pluginRoot!));

      // The installed copy would run the published package through npx; point it at this checkout's build instead.
      expect(existsSync(path.join(root, 'dist/src/operator/mcp.js')), 'npm run build first').toBe(true);
      const link = path.join(pluginRoot!, 'node_modules', ...pkgJson.name.split('/'));
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(root, link);
      expect((await dryRun(pluginRoot!, 'mcp')).source).toBe('plugin');
      // codex exec cannot answer approval prompts; a plugin's server takes them under the plugin's key.
      const key = 'plugins."orchestrator-codex@orchestrator".mcp_servers.orchestrator_operator';
      appendFileSync(path.join(codexHome, 'config.toml'), ['', 'approval_policy = "never"', `[${key}]`, 'default_tools_approval_mode = "approve"', ...TOOL_NAMES.flatMap((t) => [`[${key}.tools.${t}]`, 'approval_mode = "approve"']), ''].join('\n'));
      const auth = path.join(process.env['CODEX_HOME'] ?? path.join(homedir(), '.codex'), 'auth.json');
      if (existsSync(auth)) cpSync(auth, path.join(codexHome, 'auth.json'));

      repo = realpathSync(makeRepo(base));
      writeFileSync(path.join(repo, 'orchestrator.yaml'), ['checkCommand: "true"', 'runner: { mode: pull }'].join('\n'));
      const prompt = `Call the orchestrator_operator start tool exactly once, with repo set to ${repo} and no other arguments. Then reply with only the value of the "repo" field of its result.`;
      // Started from outside the repository, so only the repo argument names it; stdin closed, or codex waits for more input.
      const log = await new Promise<string>((resolve, reject) => {
        const child = spawn('codex', ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-C', repo!, '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="low"', '-s', 'read-only', prompt], { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (out += d.toString()));
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`codex exec exited ${code}: ${out.slice(-4000)}`))));
      });
      type Item = { type: string; server?: string; tool?: string; arguments?: Record<string, unknown>; result?: { content?: Array<{ text?: string }> } };
      const items = log.split('\n').flatMap((l) => {
        try {
          const e = JSON.parse(l) as { type?: string; item?: Item };
          return e.type === 'item.completed' && e.item?.type === 'mcp_tool_call' ? [e.item] : [];
        } catch {
          return [];
        }
      });
      const start = items.find((i) => i.server === 'orchestrator_operator' && i.tool === 'start');
      expect(start, log.slice(-4000)).toBeDefined();
      expect(start!.arguments).toMatchObject({ repo });
      const result = JSON.parse(start!.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
      expect(result, log.slice(-4000)).toMatchObject({ status: 200, repo });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      console.warn('codex CLI not installed; Codex plugin check skipped');
    } finally {
      for (const r of await listRuns(env)) if (r.alive && r.repo) await stopDaemon({ repo: r.repo, env, reap: true });
      for (const d of [codexHome, home, base]) rmSync(d, { recursive: true, force: true });
    }
  }, 300_000);

  // See specs/host-integration "Session start hook" and "Session end hook".
  it('the config template declares the session hooks running the two scripts with node, gated by features.hooks', () => {
    expect(parsed.tables['features']).toEqual({ hooks: true });
    expect(template).toContain('features.hooks = true');
    expect(parsed.arrays['hooks.SessionStart']).toEqual([{ matcher: 'startup|resume|clear' }]);
    expect(parsed.arrays['hooks.SessionStart.hooks']).toEqual([{ type: 'command', command: 'node "<hosts/codex>/hooks/session-start.mjs"', timeout: 10 }]);
    expect(parsed.arrays['hooks.SessionEnd']).toEqual([{}]);
    expect(parsed.arrays['hooks.SessionEnd.hooks']).toEqual([{ type: 'command', command: 'node "<hosts/codex>/hooks/session-end.mjs"' }]);
    const readme = readFileSync(path.join(host, 'README.md'), 'utf8');
    for (const word of ['features.hooks', '--dangerously-bypass-hook-trust', '"other"', '.agents/skills', 'skills.config']) expect(readme, word).toContain(word);
  });

  it('the hook scripts are the Claude Code plugin\'s, byte for byte', () => {
    for (const name of ['session-start.mjs', 'session-end.mjs']) {
      expect(readFileSync(path.join(host, 'hooks', name)).equals(readFileSync(path.join(root, 'hosts/claude-code/hooks', name))), name).toBe(true);
    }
  });

  it('the session end script exits 0 within one second when no daemon is alive', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-hook-home-'));
    try {
      // A run whose daemon is dead: nothing to post to.
      const dir = path.join(home, 'runs', 'dead');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'daemon.pid'), '999999\n');
      writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ pid: 999_999, url: 'http://127.0.0.1:1', port: 1, startedAt: 1 }));
      const t0 = Date.now();
      const end = await sessionEnd(home, { reason: 'x' });
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(end).toEqual({ code: 0, stdout: '' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('the session end script, given Codex\'s hook input, ends the attachment whose chain holds its ancestor and releases its launch with keep', async () => {
    const h = await makeSlice({ graph: 'nodes:\n  - { id: T1, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }', config: { leaseTtlMs: 60_000, runner: { mode: 'pull', claimWindowMs: 60_000 } } });
    const home = mkdtempSync(path.join(tmpdir(), 'orch-hook-home-'));
    // Stands in for the operator server; the test process stands in for the codex process, the parent of both the server and the hook.
    const server = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      await h.orch.tick();
      liveRun(home, h.repo, h.orch.apiBaseUrl);
      const post = (route: string, body: Record<string, unknown>) => fetch(`${h.orch.apiBaseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Record<string, unknown>>);
      await post('/v1/attachments', { id: 'codex', pids: [server.pid!, process.pid] });
      const claim = await post('/v1/claims', { workerId: 'w1', taskId: 'T1', attachment: 'codex' });
      expect(claim['launchId']).toBeDefined();
      // Codex's session-end.command.input: its reason is always "other".
      const end = await sessionEnd(home, { session_id: 's1', transcript_path: null, cwd: h.repo, hook_event_name: 'SessionEnd', reason: 'other' });
      expect(end).toEqual({ code: 0, stdout: '' });
      expect(h.orch.isLiveAttachment('codex')).toBe(false);
      await h.orch.tick();
      expect(h.store.listEvents({ kind: 'attachment.ended' }).map((e) => e.payload)).toEqual([expect.objectContaining({ id: 'codex', reason: 'other' })]);
      expect(h.store.getLaunch(String(claim['launchId']))).toMatchObject({ status: 'ended', endReason: 'released' });
      expect(h.store.listEvents({ kind: 'launch.released' }).map((e) => e.payload)).toEqual([expect.objectContaining({ keep: true, reason: 'session ended (other)' })]);
      expect(h.orch.entry('T1')).toMatchObject({ attempts: 0 });
      expect(h.store.listLaunches({ taskId: 'T1', status: 'claimable' })).toHaveLength(1);
    } finally {
      server.kill();
      rmSync(home, { recursive: true, force: true });
      await h.cleanup();
    }
  });

  // Codex itself runs the template's SessionEnd hook: its stdin and its ancestry (codex is the hook's parent) reach the daemon.
  it.skipIf(!CODEX_HOST)('codex runs the template\'s SessionEnd hook, whose ancestry and reason end the attachment (ORCH_E2E_CODEX_HOST=1)', async () => {
    const h = await makeSlice({ graph: 'nodes:\n  - { id: T1, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }', config: { leaseTtlMs: 60_000, runner: { mode: 'pull', claimWindowMs: 60_000 } } });
    const home = mkdtempSync(path.join(tmpdir(), 'orch-hook-home-'));
    const codexHome = mkdtempSync(path.join(tmpdir(), 'orch-codex-home-'));
    const server = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      await h.orch.tick();
      liveRun(home, h.repo, h.orch.apiBaseUrl);
      // The hooks only: the operator server is not needed to watch the hook.
      writeFileSync(path.join(codexHome, 'config.toml'), template.slice(template.indexOf('\n[features]\n')).replaceAll('<hosts/codex>', host));
      await fetch(`${h.orch.apiBaseUrl}/v1/attachments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'codex', pids: [server.pid!, process.pid] }) });
      await execFileP('codex', ['--dangerously-bypass-hook-trust', 'debug', 'prompt-input', 'hi'], { cwd: h.repo, env: { ...process.env, CODEX_HOME: codexHome, ORCH_HOME: home }, timeout: 60_000 });
      expect(h.orch.isLiveAttachment('codex')).toBe(false);
      await h.orch.tick();
      expect(h.store.listEvents({ kind: 'attachment.ended' }).map((e) => e.payload)).toEqual([expect.objectContaining({ id: 'codex', reason: 'other' })]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      console.warn('codex CLI not installed; SessionEnd hook check through codex skipped');
    } finally {
      server.kill();
      rmSync(home, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
      await h.cleanup();
    }
  }, 90_000);

  it('package.json pins the published package at the Claude Code plugin\'s version, and the launcher reads it', async () => {
    expect(hostPkg.private).toBe(true);
    expect(hostPkg.name).not.toBe(pkgJson.name);
    expect(Object.keys(hostPkg.dependencies)).toEqual([pkgJson.name]);
    expect(hostPkg.dependencies[pkgJson.name]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(hostPkg.dependencies[pkgJson.name]).toBe(claudePkg.dependencies[pkgJson.name]);
    expect(hostPkg.dependencies[pkgJson.name]).toBe(pkgJson.version);
    expect(/PACKAGE_NAME = '([^']+)'/.exec(readFileSync(launcher, 'utf8'))?.[1]).toBe(pkgJson.name);
    expect(existsSync(path.join(host, '.claude-plugin'))).toBe(false);
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('hosts/codex/node_modules/');

    const fromCheckout = await dryRun(host, 'mcp');
    expect(fromCheckout.source).toBe('checkout');
    expect(fromCheckout.args.at(-1)).toMatch(/src\/operator\/mcp\.(js|ts)$/);
    const copy = mkdtempSync(path.join(tmpdir(), 'orch-codex-copy-'));
    try {
      cpSync(host, path.join(copy, 'codex'), { recursive: true });
      const npx = await dryRun(path.join(copy, 'codex'), 'mcp');
      expect(npx.source).toBe('npx');
      expect(npx.args).toEqual(['--yes', `--package=${pkgJson.name}@${hostPkg.dependencies[pkgJson.name]}`, 'orchestrator-mcp']);
      const local = path.join(copy, 'codex', 'node_modules', ...pkgJson.name.split('/'));
      mkdirSync(path.join(local, 'dist/src/operator'), { recursive: true });
      writeFileSync(path.join(local, 'package.json'), JSON.stringify({ name: pkgJson.name, engines: { node: '>=22.13.0' } }));
      writeFileSync(path.join(local, 'dist/src/operator/mcp.js'), '');
      const fromLocal = await dryRun(path.join(copy, 'codex'), 'mcp');
      expect(fromLocal.source).toBe('plugin');
      expect(fromLocal.args[0]).toBe(path.join(realpathSync(local), 'dist/src/operator/mcp.js'));
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it('the launcher is the Claude Code launcher but for its version source', () => {
    const strip = (text: string) => text.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    const codex = strip(readFileSync(launcher, 'utf8'));
    const claude = strip(readFileSync(path.join(root, 'hosts/claude-code/bin/orchestrator.mjs'), 'utf8'));
    const differing = (a: string, b: string) => a.split('\n').filter((l) => !b.split('\n').includes(l));
    expect(differing(codex, claude)).toEqual([expect.stringContaining("readJson(path.join(pluginDir, 'package.json'))?.dependencies?.[PACKAGE_NAME]")]);
    expect(differing(claude, codex).join('\n')).toContain('.claude-plugin');
  });

  // See specs/host-integration "Codex host" and "Skills report the toolchain".
  it('the skill edition is Codex-specific: no plugin root, no workflow or subagents, no Claude model names, AGENTS.md first', () => {
    const skills = readdirSync(path.join(host, 'skills')).sort();
    expect(skills).toEqual(['import', 'review', 'run']);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else files.push(path.join(dir, e.name));
      }
    };
    walk(host);
    // `grep -r CLAUDE.md hosts/codex` finds it only as the fallback beside AGENTS.md.
    for (const file of files) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.includes('CLAUDE.md')) expect(line, path.relative(root, file)).toContain('AGENTS.md');
      }
    }
    for (const name of skills) {
      const text = readFileSync(path.join(host, 'skills', name, 'SKILL.md'), 'utf8');
      expect(text, name).toMatch(new RegExp(`^---\\nname: orchestrator-${name}\\ndescription: .+\\n---\\n`));
      expect(text, name).not.toContain('${CLAUDE_PLUGIN_ROOT}');
      expect(text, name).not.toMatch(/Workflow|subagents? (work|run)|work\.js|claimModel|session subagents/);
      expect(text, name).not.toMatch(/^#+ .*(Workflow|subagent)/im);
      expect(text, name).not.toMatch(/claude-(opus|sonnet|haiku)-/);
      expect(text, name).not.toMatch(/\bwith Bash\b/);
      expect(text, name).toContain('mcp__orchestrator_operator__');
    }
    const run = readFileSync(path.join(host, 'skills/run/SKILL.md'), 'utf8');
    const codexLine = 'workers codex gpt-6-astra at medium (file); sandbox workspace-write, daemon commits';
    for (const word of ['mode: "spawn"', 'modeNote', 'needsConfig', 'configure', 'AGENTS.md', 'needsAccess', 'detected: npm test on main', 'start-only', codexLine, 'omit the allow-list part', 'runner.kind', 'runner.codex.*', 'budgets.prices', 'config.runnerKind', 'claimableByKind', 'tool_timeout_sec', 'codex exec', 'default_tools_approval_mode', 'interactive']) expect(run, word).toContain(word);
    const imp = readFileSync(path.join(host, 'skills/import/SKILL.md'), 'utf8');
    for (const word of ['mcp__linear__', 'mcp__atlassian__', 'gh auth status', 'needsConfig', 'configure', 'AGENTS.md', 'runner:<kind>', 'model:<name>', 'effort:<level>', 'ignoredLabels', 'mode: "spawn"', codexLine]) expect(imp, word).toContain(word);
    const review = readFileSync(path.join(host, 'skills/review/SKILL.md'), 'utf8');
    for (const word of ['accept', 'reject', 'integrationSha', 'reviewVersion']) expect(review, word).toContain(word);
    const readme = readFileSync(path.join(host, 'README.md'), 'utf8');
    for (const word of ['[mcp_servers.orchestrator_operator]', 'tool_timeout_sec', 'codex mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=', 'codex mcp get orchestrator_operator', '~/.codex/skills', 'approval_policy = "never"']) expect(readme, word).toContain(word);
  });
});
