import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
});
