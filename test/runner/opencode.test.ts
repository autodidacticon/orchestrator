import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_OPENCODE_COMMAND } from '../../src/runner/command.js';
import { bashPatterns, composeOpenCodeCommand, openCodeConfig, OpenCodeRunner, type OpenCodeSettings } from '../../src/runner/opencode.js';
import type { Launch } from '../../src/state/store.js';

const TOKEN = 'tok-opencode-secret';
const SHIM = { command: 'node', args: ['/opt/orch/dist/agent/mcp-shim.js'] };
const MAX_WAIT_MS = 60 * 60_000;
const defaults: OpenCodeSettings = { permission: 'derived', dataDir: 'shared', ignoreUserConfig: false, pure: true, snapshots: false };
const RULES = ['Bash(git:*)', 'mcp__orchestrator__heartbeat', 'Bash(npm test:*)', 'Bash(git status)'];

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function launchIn(worktree: string, over: Partial<Launch> = {}): Launch {
  return { launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'launching', token: TOKEN, branch: 'task/T1/l1', worktree, baseSha: 'b', graphRev: 'r', createdAt: 1, runner: 'opencode', model: 'opencode/big-pickle', effort: 'high', ...over } as Launch;
}

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (!existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
  return readFileSync(file, 'utf8');
}

// See specs/worker-runners "OpenCode runner command composition".
describe('OpenCode runner command', () => {
  it('composes the template with the brief on stdin, the model, and the variant', () => {
    const cmd = composeOpenCodeCommand(launchIn('/wt'), { settings: defaults });
    expect(cmd).toBe('opencode run --format json --pure --print-logs --log-level WARN -m opencode/big-pickle --variant high < /wt/.orchestrator/brief.md');
    expect(cmd).not.toContain(TOKEN);
    expect(cmd).not.toContain('ORCH_TOKEN');
    expect(cmd).not.toContain('opencode.json');
    expect(cmd).not.toContain('OPENCODE_CONFIG');
    expect(cmd).not.toMatch(/\{\w+\}/);
  });

  it('drops --pure under pure: false and --variant when effort is unset', () => {
    const plain = composeOpenCodeCommand(launchIn('/wt'), { settings: { pure: false } });
    expect(plain).not.toContain('--pure');
    expect(plain).toContain('--variant high');
    const noEffort = composeOpenCodeCommand(launchIn('/wt', { effort: undefined }), { settings: defaults });
    expect(noEffort).not.toContain('--variant');
    expect(noEffort).toContain('--pure');
    expect(composeOpenCodeCommand(launchIn('/wt'), { settings: defaults, brief: '/tmp/pre.md' }).endsWith('< /tmp/pre.md')).toBe(true);
  });

  it('the shell hands -m one word and the brief to stdin', () => {
    const dir = tmp('orch-opencode-sh-');
    const brief = path.join(dir, '.orchestrator', 'brief.md');
    mkdirSync(path.dirname(brief), { recursive: true });
    writeFileSync(brief, 'the brief');
    const cmd = composeOpenCodeCommand(launchIn(dir), { settings: defaults });
    const out = execFileSync('/bin/sh', ['-c', `opencode() { printf '%s\\n' "$@"; printf 'stdin=%s\\n' "$(cat)"; }\n${cmd}`], { encoding: 'utf8' });
    const argv = out.trimEnd().split('\n');
    expect(argv).toEqual(['run', '--format', 'json', '--pure', '--print-logs', '--log-level', 'WARN', '-m', 'opencode/big-pickle', '--variant', 'high', 'stdin=the brief']);
    expect(argv[argv.indexOf('-m') + 1]).toBe('opencode/big-pickle');
  });
});

describe('OpenCode per-launch config', () => {
  it('maps derived rules to bash patterns', () => {
    expect(bashPatterns(RULES)).toEqual(['git *', 'npm test *', 'git status']);
  });

  it('carries the shim, the timeout, snapshots off, sharing off, and the derived ruleset', () => {
    const cfg = openCodeConfig(defaults, ['Bash(npm test:*)', 'Bash(git status)'], MAX_WAIT_MS, SHIM);
    expect(cfg.mcp['orchestrator']).toEqual({ type: 'local', command: ['node', '/opt/orch/dist/agent/mcp-shim.js'], enabled: true, timeout: 3_660_000 });
    expect(cfg.permission).toEqual({
      '*': 'ask',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      edit: 'allow',
      bash: { '*': 'ask', 'git *': 'allow', 'npm test *': 'allow', 'git status': 'allow' },
      'orchestrator_*': 'allow',
    });
    // The catch-alls come first: OpenCode takes the last matching rule.
    expect(Object.keys(cfg.permission)[0]).toBe('*');
    expect(Object.keys(cfg.permission['bash'] as object)[0]).toBe('*');
    expect(openCodeConfig({ ...defaults, permission: 'allow' }, RULES, MAX_WAIT_MS, SHIM).permission).toEqual({ '*': 'allow' });
    expect(openCodeConfig({ ...defaults, snapshots: true }, [], MAX_WAIT_MS, SHIM)).not.toHaveProperty('snapshots');
    expect(openCodeConfig({ ...defaults, toolTimeoutMs: 120_000 }, [], MAX_WAIT_MS, SHIM).mcp['orchestrator']?.timeout).toBe(120_000);
    expect(openCodeConfig(defaults, [], 90_500, SHIM).mcp['orchestrator']?.timeout).toBe(150_500);
  });
});

/** A fake `opencode` on PATH that records its environment and argv and echoes its stdin. */
function fakeOpencode(dir: string): string {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = [
    '#!/bin/sh',
    'out="$PWD/.orchestrator/fake"',
    'mkdir -p "$out"',
    `printf '%s' "$OPENCODE_CONFIG_CONTENT" > "$out/config.json"`,
    `printf '%s' "\${XDG_DATA_HOME-unset}" > "$out/xdg-data"`,
    `printf '%s' "\${XDG_CONFIG_HOME-unset}" > "$out/xdg-config"`,
    `printf '%s' "\${ORCH_TOKEN-}" > "$out/token"`,
    `printf '%s\\n' "$@" > "$out/argv"`,
    'cat > "$out/stdin"',
    'cat "$out/stdin"',
    'touch "$out/done"',
  ].join('\n');
  const file = path.join(bin, 'opencode');
  writeFileSync(file, `${script}\n`);
  chmodSync(file, 0o755);
  return bin;
}

async function spawnFake(settings: Partial<OpenCodeSettings>, rules = ['Bash(npm test:*)', 'Bash(git status)']): Promise<{ worktree: string; fake: (f: string) => string; logDir: string }> {
  const dir = tmp('orch-opencode-');
  const bin = fakeOpencode(dir);
  const worktree = path.join(dir, 'wt');
  mkdirSync(path.join(worktree, '.orchestrator'), { recursive: true });
  writeFileSync(path.join(worktree, '.orchestrator', 'brief.md'), 'do the task\n');
  const logDir = path.join(dir, 'logs');
  const runner = new OpenCodeRunner({
    command: () => DEFAULT_OPENCODE_COMMAND,
    settings: () => ({ ...defaults, ...settings }),
    allowedTools: () => rules,
    maxWaitMs: MAX_WAIT_MS,
    retryWindowMs: 5000,
    logDir,
    shim: SHIM,
    extraEnv: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, XDG_DATA_HOME: '', XDG_CONFIG_HOME: '' },
  });
  await runner.spawn(launchIn(worktree), { ORCH_API: 'http://127.0.0.1:9' });
  const out = path.join(worktree, '.orchestrator', 'fake');
  await waitForFile(path.join(out, 'done'));
  return { worktree, fake: (f) => readFileSync(path.join(out, f), 'utf8'), logDir };
}

// See specs/worker-runners "OpenCode runner command composition" and specs/agent-protocol "Agent environment".
describe('OpenCode runner spawn', () => {
  it('passes the per-launch config in OPENCODE_CONFIG_CONTENT, the brief on stdin, and the token only in the environment', async () => {
    const { worktree, fake, logDir } = await spawnFake({});
    const cfg = JSON.parse(fake('config.json')) as Record<string, any>;
    expect(cfg['mcp']['orchestrator']['command']).toEqual([SHIM.command, ...SHIM.args]);
    expect(cfg['mcp']['orchestrator']['timeout']).toBe(3_660_000);
    expect(cfg['mcp']['orchestrator']).not.toHaveProperty('environment');
    expect(cfg['mcp']).not.toHaveProperty('timeout');
    expect(cfg['snapshots']).toBe(false);
    expect(cfg['share']).toBe('disabled');
    expect(cfg['permission']['bash']).toEqual({ '*': 'ask', 'git *': 'allow', 'npm test *': 'allow', 'git status': 'allow' });
    expect(cfg['permission']['orchestrator_*']).toBe('allow');
    expect(JSON.stringify(cfg)).not.toContain(TOKEN);
    expect(fake('token')).toBe(TOKEN);
    expect(fake('stdin')).toBe('do the task\n');
    expect(fake('argv').trimEnd().split('\n')).toEqual(['run', '--format', 'json', '--pure', '--print-logs', '--log-level', 'WARN', '-m', 'opencode/big-pickle', '--variant', 'high']);
    expect(fake('xdg-data')).toBe('unset');
    expect(fake('xdg-config')).toBe('unset');
    const file = path.join(worktree, '.orchestrator', 'opencode.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(cfg);
    // The fake echoes its stdin into the launch log.
    expect(await waitForFile(path.join(logDir, 'L1.log'))).toContain('do the task');
  });

  it('follows toolTimeoutMs, dataDir: launch, and ignoreUserConfig', async () => {
    const { worktree, fake } = await spawnFake({ toolTimeoutMs: 120_000, dataDir: 'launch', ignoreUserConfig: true });
    expect((JSON.parse(fake('config.json')) as Record<string, any>)['mcp']['orchestrator']['timeout']).toBe(120_000);
    expect(fake('xdg-data')).toBe(path.join(worktree, '.orchestrator', 'opencode-data'));
    const configHome = fake('xdg-config');
    expect(configHome).toBe(path.join(worktree, '.orchestrator', 'opencode-config'));
    expect(statSync(configHome).isDirectory()).toBe(true);
    expect(readdirSync(configHome)).toEqual([]);
  });
});
