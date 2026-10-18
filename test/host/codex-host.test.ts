/**
 * The Codex host: hosts/codex's launcher, pinned package.json, MCP registration template, and
 * skill edition. See specs/host-integration "Codex host".
 */
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { WAIT_CAP_MS } from '../../src/operator/mcp-server.js';

const execFileP = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const host = path.join(root, 'hosts/codex');
const launcher = path.join(host, 'bin/orchestrator.mjs');
const pkgJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string; version: string };
const hostPkg = JSON.parse(readFileSync(path.join(host, 'package.json'), 'utf8')) as { name: string; private?: boolean; dependencies: Record<string, string> };
const claudePkg = JSON.parse(readFileSync(path.join(root, 'hosts/claude-code/package.json'), 'utf8')) as { dependencies: Record<string, string> };

type TomlValue = string | number | boolean | string[];

/** The flat subset of TOML the template uses: [table] headers and key = string | number | boolean | string array. */
function parseTomlSubset(text: string): Record<string, Record<string, TomlValue>> {
  const tables: Record<string, Record<string, TomlValue>> = {};
  let current: Record<string, TomlValue> | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header) {
      current = tables[header[1]!] = {};
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv || !current) throw new Error(`unparsed line: ${line}`);
    current[kv[1]!] = JSON.parse(kv[2]!) as TomlValue;
  }
  return tables;
}

const dryRun = async (dir: string, entry: string) => {
  const { stdout } = await execFileP('node', [path.join(dir, 'bin/orchestrator.mjs'), entry], { env: { ...process.env, ORCH_LAUNCHER_DRY_RUN: '1' } });
  return JSON.parse(stdout) as { source: string; command: string; args: string[] };
};

describe('codex host', () => {
  const template = readFileSync(path.join(host, 'config.toml'), 'utf8');
  const server = parseTomlSubset(template)['mcp_servers.orchestrator_operator'];

  it('the config template registers the operator server through the launcher with a tool timeout above the wait cap', () => {
    expect(server).toBeDefined();
    expect(server!['command']).toBe('node');
    expect(server!['args']).toEqual(['<hosts/codex>/bin/orchestrator.mjs', 'mcp']);
    expect(server!['startup_timeout_sec']).toBe(30);
    expect(server!['tool_timeout_sec']).toBeGreaterThanOrEqual(Math.ceil(WAIT_CAP_MS / 1000) + 30);
  });

  // A real TOML parser confirms the template: Codex reads it from a scratch CODEX_HOME.
  it('codex mcp get reads the template as written', async () => {
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
