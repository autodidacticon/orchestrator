import { execFile, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import * as core from '../../src/index.js';
import { makeSlice, tsxLoader } from '../slice/harness.js';

const execFileP = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { bin: Record<string, string>; exports: Record<string, { types?: string; default?: string } | string> };

describe('package entrypoints', () => {
  it('declares four executables and the subpath exports', () => {
    expect(Object.keys(pkg.bin).sort()).toEqual(['orchestrator', 'orchestrator-ctl', 'orchestrator-mcp', 'orchestrator-mcp-shim']);
    expect(Object.keys(pkg.exports)).toEqual(expect.arrayContaining(['.', './daemon', './operator-mcp', './agent-shim']));
    for (const [k, v] of Object.entries(pkg.exports)) {
      if (typeof v === 'string') continue;
      expect(existsSync(path.join(root, v.types as string)), `${k} types ${v.types}`).toBe(true);
    }
  });

  it('core library exports the orchestrator and its parts', () => {
    expect(typeof core.Orchestrator).toBe('function');
    expect(typeof core.SqliteStore).toBe('function');
    expect(typeof core.parseGraph).toBe('function');
    expect(typeof core.GitVerifierBackend).toBe('function');
    expect(core.CRASH_POINTS.length).toBeGreaterThan(10);
  });

  it('ships a marketplace manifest whose plugin version matches the package, and the plugin validates with the work skill and workflow', async () => {
    const marketplace = JSON.parse(readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8')) as { name: string; plugins: Array<{ name: string; source: string }> };
    expect(marketplace.name).toBe('orchestrator');
    expect(marketplace.plugins).toMatchObject([{ name: 'orchestrator', source: './hosts/claude-code' }]);
    const plugin = JSON.parse(readFileSync(path.join(root, 'hosts/claude-code/.claude-plugin/plugin.json'), 'utf8')) as { version: string };
    const version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
    expect(plugin.version).toBe(version);
    expect(existsSync(path.join(root, 'hosts/claude-code/skills/work/SKILL.md'))).toBe(true);
    expect(existsSync(path.join(root, 'hosts/claude-code/workflows/work.js'))).toBe(true);
    try {
      const { stdout } = await execFileP('claude', ['plugin', 'validate', '--strict', path.join(root, 'hosts/claude-code')], { cwd: root });
      expect(stdout).toContain('Validation passed');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      console.warn('claude CLI not installed; plugin validation skipped');
    }
  });

  it.each([
    ['orchestrator', 'src/main.ts', 'the daemon'],
    ['orchestrator-ctl', 'src/operator/cli.ts', 'operate a running orchestrator'],
    ['orchestrator-mcp', 'src/operator/mcp.ts', 'operator MCP server'],
    ['orchestrator-mcp-shim', 'src/agent/mcp-shim.ts', 'MCP façade'],
  ])('%s --help prints usage', async (name, entry, phrase) => {
    const bin = pkg.bin[name] as string;
    expect(bin.replace('./dist/', '').replace(/\.js$/, '.ts')).toBe(entry);
    const { stdout } = await execFileP('node', ['--import', tsxLoader, path.join(root, entry), '--help'], { cwd: root });
    expect(stdout).toContain(name);
    expect(stdout).toContain(phrase);
  });

  // npm link and global installs put a symlink on PATH; the entrypoint guard must see through it.
  it.each([
    ['orchestrator', 'src/main.ts'],
    ['orchestrator-ctl', 'src/operator/cli.ts'],
    ['orchestrator-mcp', 'src/operator/mcp.ts'],
    ['orchestrator-mcp-shim', 'src/agent/mcp-shim.ts'],
  ])('%s runs when invoked through a symlink', async (name, entry) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-bin-'));
    try {
      const link = path.join(dir, name);
      symlinkSync(path.join(root, entry), link);
      const { stdout } = await execFileP('node', ['--import', tsxLoader, link, '--help'], { cwd: dir });
      expect(stdout).toContain(name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the production dependency tree has no native module', () => {
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { dev?: boolean; hasInstallScript?: boolean }> };
    const prod = Object.entries(lock.packages).filter(([p, e]) => p !== '' && !e.dev);
    expect(prod.length).toBeGreaterThan(0);
    expect(prod.filter(([, e]) => e.hasInstallScript).map(([p]) => p)).toEqual([]);
    expect(prod.filter(([p]) => existsSync(path.join(root, p, 'binding.gyp'))).map(([p]) => p)).toEqual([]);
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string>; engines: { node: string } };
    expect(manifest.dependencies['better-sqlite3']).toBeUndefined();
    expect(manifest.devDependencies['@types/better-sqlite3']).toBeUndefined();
    expect(manifest.engines.node).toBe('>=22.13.0');
  });

  it('orchestrator-ctl against an empty data dir is warning-free', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-empty-'));
    try {
      await execFileP('node', ['--import', tsxLoader, path.join(root, 'src/operator/cli.ts'), '--data-dir', dir, 'status'], { cwd: root });
      expect.unreachable('the command must fail without a daemon');
    } catch (err) {
      const e = err as { code?: number; stderr?: string };
      expect(e.code).toBe(2);
      const lines = (e.stderr ?? '').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('no daemon url recorded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Plugin packaging and hooks. See specs/host-integration "Plugin launcher", "Per-host wrappers", "Session start hook", "Session end hook".
  const plugin = path.join(root, 'hosts/claude-code');
  const launcher = path.join(plugin, 'bin/orchestrator.mjs');
  const pluginManifest = JSON.parse(readFileSync(path.join(plugin, '.claude-plugin/plugin.json'), 'utf8')) as { version: string };
  const pluginPkg = JSON.parse(readFileSync(path.join(plugin, 'package.json'), 'utf8')) as { name: string; private?: boolean; dependencies: Record<string, string> };
  const pkgJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string; version: string; private?: boolean; publishConfig?: { access?: string }; scripts: Record<string, string> };
  const dryRun = async (dir: string, entry: string, extra: Record<string, string> = {}) => {
    const { stdout } = await execFileP('node', [path.join(dir, 'bin/orchestrator.mjs'), entry], { env: { ...process.env, ORCH_LAUNCHER_DRY_RUN: '1', ...extra } });
    return JSON.parse(stdout) as { source: string; command: string; args: string[] };
  };

  it('the plugin declares its server through the launcher and pins the published package', () => {
    const mcp = JSON.parse(readFileSync(path.join(plugin, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args: string[]; timeout: number }> };
    expect(mcp.mcpServers['operator']).toMatchObject({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/orchestrator.mjs', 'mcp'] });
    expect(mcp.mcpServers['operator']!.timeout).toBeGreaterThan(90_000);
    const constant = /PACKAGE_NAME = '([^']+)'/.exec(readFileSync(launcher, 'utf8'))?.[1];
    expect(constant).toBe(pkgJson.name);
    expect(pkgJson.name).toBe('@autodidacticon/orchestrator');
    expect(pkgJson.private).toBeUndefined();
    expect(pkgJson.publishConfig).toEqual({ access: 'public' });
    expect(pkgJson.scripts['prepublishOnly']).toBe('npm run build');
    expect(pluginPkg.private).toBe(true);
    expect(Object.keys(pluginPkg.dependencies)).toEqual([pkgJson.name]);
    expect(pluginPkg.dependencies[pkgJson.name]).toBe(pluginManifest.version);
    expect(pluginManifest.version).toBe(pkgJson.version);
    expect(existsSync(path.join(plugin, 'node_modules'))).toBe(false); // git-ignored, never committed
    const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(ignore).toContain('hosts/claude-code/node_modules/');
  });

  // The lockfile is regenerated against the published version at each release (see the README's release order).
  it.skipIf(!existsSync(path.join(plugin, 'package-lock.json')))('the plugin lockfile resolves the pinned package', () => {
    const lock = JSON.parse(readFileSync(path.join(plugin, 'package-lock.json'), 'utf8')) as { lockfileVersion: number; packages: Record<string, { version?: string }> };
    expect([2, 3]).toContain(lock.lockfileVersion);
    expect(lock.packages[`node_modules/${pkgJson.name}`]?.version).toBe(pluginManifest.version);
  });

  it('the launcher resolves a checkout, a plugin-local copy, and npx, checks the Node floor, and runs the checkout', async () => {
    const fromCheckout = await dryRun(plugin, 'mcp');
    expect(fromCheckout.source).toBe('checkout');
    expect(fromCheckout.args[0]).toMatch(/src\/operator\/mcp\.(js|ts)$/);
    const { stdout } = await execFileP('node', [launcher, 'mcp', '--help'], { cwd: root });
    expect(stdout).toContain('operator MCP server');
    const copy = mkdtempSync(path.join(tmpdir(), 'orch-plugin-copy-'));
    try {
      cpSync(plugin, path.join(copy, 'plugin'), { recursive: true });
      const npx = await dryRun(path.join(copy, 'plugin'), 'mcp');
      expect(npx.source).toBe('npx');
      expect(npx.args).toEqual(['--yes', `--package=${pkgJson.name}@${pluginManifest.version}`, 'orchestrator-mcp']);
      const local = path.join(copy, 'plugin', 'node_modules', ...pkgJson.name.split('/'));
      mkdirSync(path.join(local, 'dist/src/operator'), { recursive: true });
      writeFileSync(path.join(local, 'package.json'), JSON.stringify({ name: pkgJson.name, engines: { node: '>=22.13.0' } }));
      writeFileSync(path.join(local, 'dist/src/operator/mcp.js'), '');
      const fromPlugin = await dryRun(path.join(copy, 'plugin'), 'mcp');
      expect(fromPlugin.source).toBe('plugin');
      expect(fromPlugin.args[0]).toBe(path.join(realpathSync(local), 'dist/src/operator/mcp.js'));
      rmSync(path.join(local, 'dist'), { recursive: true, force: true });
      expect((await dryRun(path.join(copy, 'plugin'), 'mcp')).source).toBe('npx'); // incomplete tree falls back
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
    try {
      await execFileP('node', [launcher, 'mcp'], { env: { ...process.env, ORCH_LAUNCHER_NODE_VERSION: '22.0.0', ORCH_LAUNCHER_DRY_RUN: '1' } });
      expect.unreachable('must refuse an old Node');
    } catch (err) {
      const e = err as { code?: number; stderr?: string; stdout?: string };
      expect(e.code).toBe(1);
      expect((e.stderr ?? '').trim().split('\n')).toHaveLength(1);
      expect(e.stderr).toContain('22.0.0');
      expect(e.stderr).toContain('22.13.0');
      expect(e.stdout ?? '').toBe('');
    }
  });

  it('declares the session hooks', () => {
    const hooks = JSON.parse(readFileSync(path.join(plugin, 'hooks/hooks.json'), 'utf8')) as { hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ command: string; timeout?: number }> }>; SessionEnd: Array<{ hooks: Array<{ command: string }> }> } };
    expect(hooks.hooks.SessionStart[0]).toMatchObject({ matcher: 'startup|resume|clear' });
    expect(hooks.hooks.SessionStart[0]!.hooks[0]!.command).toBe('node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"');
    expect(hooks.hooks.SessionStart[0]!.hooks[0]!.timeout).toBe(10);
    expect(hooks.hooks.SessionEnd[0]!.hooks[0]!.command).toBe('node "${CLAUDE_PLUGIN_ROOT}/hooks/session-end.mjs"');
  });

  it('the session start hook names runs that need attention and stays silent otherwise', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orch-hook-home-'));
    const run = (name: string, files: Record<string, string>) => {
      const dir = path.join(home, 'runs', name);
      mkdirSync(dir, { recursive: true });
      for (const [f, c] of Object.entries(files)) writeFileSync(path.join(dir, f), c);
    };
    const hook = () => execFileP('node', [path.join(plugin, 'hooks/session-start.mjs')], { env: { ...process.env, ORCH_HOME: home } });
    try {
      expect((await hook()).stdout).toBe('');
      const dead = 999_999;
      run('a', { repo: '/r/parked\n', 'daemon.pid': `${dead}\n`, 'daemon.json': JSON.stringify({ pid: dead, url: 'http://127.0.0.1:1', port: 1, startedAt: 1, repo: '/r/parked', exit: { at: Date.now() - 42 * 60_000, reason: 'idle', reap: false, digest: { claimable: 2, openQuestions: ['T3'], awaitingReview: [], stalled: false } } }) });
      run('b', { repo: '/r/crashed\n', 'daemon.pid': `${dead}\n`, 'daemon.json': JSON.stringify({ pid: dead, url: 'http://127.0.0.1:1', port: 1, startedAt: 1, repo: '/r/crashed' }) });
      run('c', { repo: '/r/finished\n', 'daemon.pid': `${dead}\n`, 'daemon.json': JSON.stringify({ pid: dead, url: 'http://127.0.0.1:1', port: 1, startedAt: 1, repo: '/r/finished', exit: { at: Date.now(), reason: 'idle', reap: false, digest: { finished: true, claimable: 0, openQuestions: [], awaitingReview: [] } } }) });
      const { stdout } = await hook();
      const lines = stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('/r/parked (daemon exited idle 42 min ago: 2 launches parked, 1 open question)');
      expect(lines[0]).toContain('/r/crashed (daemon not stopped cleanly');
      expect(lines[0]).not.toContain('/r/finished');
      expect(lines[0]).toContain('2 runs');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('the session start hook reports an alive daemon and the session end hook releases this session\'s launches by ancestry', async () => {
    const h = await makeSlice({ graph: 'nodes:\n  - { id: T1, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }\n  - { id: T2, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }', config: { leaseTtlMs: 60_000, runner: { mode: 'pull', claimWindowMs: 60_000 } } });
    const home = mkdtempSync(path.join(tmpdir(), 'orch-hook-home-'));
    const other = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      await h.orch.tick();
      // A fabricated run directory whose daemon.json points at the slice's live API; the test process stands in for the daemon pid.
      const dir = path.join(home, 'runs', 'live');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'repo'), `${h.repo}\n`);
      writeFileSync(path.join(dir, 'daemon.pid'), `${process.pid}\n`);
      writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ pid: process.pid, url: h.orch.apiBaseUrl, port: 0, startedAt: 1, repo: h.repo }));
      const post = (route: string, body: Record<string, unknown>) => fetch(`${h.orch.apiBaseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Record<string, unknown>>);
      // This session's attachment: a chain that contains an ancestor of the hook process (the test process).
      await post('/v1/attachments', { id: 'mine', pids: [999_999, 999_998, process.pid] });
      // Another session: an alive process that is no ancestor of the hook.
      await post('/v1/attachments', { id: 'theirs', pids: [other.pid!, 999_996] });
      const mine = await post('/v1/claims', { workerId: 'w1', taskId: 'T1', attachment: 'mine' });
      const theirs = await post('/v1/claims', { workerId: 'w2', taskId: 'T2', attachment: 'theirs' });
      expect(mine['launchId']).toBeDefined();
      expect(theirs['launchId']).toBeDefined();
      const start = await execFileP('node', [path.join(plugin, 'hooks/session-start.mjs')], { env: { ...process.env, ORCH_HOME: home } });
      expect(start.stdout).toContain(`${h.repo} (daemon alive`);
      expect(start.stdout).toContain('running T1, T2');
      expect(start.stdout).toContain('2 sessions attached');
      const t0 = Date.now();
      const end = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = spawn('node', [path.join(plugin, 'hooks/session-end.mjs')], { env: { ...process.env, ORCH_HOME: home } });
        let stdout = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.on('exit', (code) => resolve({ code, stdout }));
        child.stdin.end(JSON.stringify({ reason: 'prompt_input_exit' }));
      });
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(end).toEqual({ code: 0, stdout: '' });
      expect(h.orch.isLiveAttachment('mine')).toBe(false);
      expect(h.orch.isLiveAttachment('theirs')).toBe(true);
      await h.orch.tick();
      expect(h.store.getLaunch(String(mine['launchId']))).toMatchObject({ status: 'ended', endReason: 'released' });
      expect(h.store.getLaunch(String(theirs['launchId']))?.status).toBe('live');
      // Untouched, so no attempt was spent, and the same tick parked a fresh launch for T1.
      expect(h.orch.entry('T1')).toMatchObject({ attempts: 0 });
      expect(h.store.listLaunches({ taskId: 'T1', status: 'claimable' })).toHaveLength(1);
    } finally {
      other.kill();
      rmSync(home, { recursive: true, force: true });
      await h.cleanup();
    }
  });
});
