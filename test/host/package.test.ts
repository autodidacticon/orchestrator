import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import * as core from '../../src/index.js';
import { tsxLoader } from '../slice/harness.js';

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
});
