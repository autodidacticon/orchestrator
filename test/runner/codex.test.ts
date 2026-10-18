import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../../src/agent/mcp-shim.js';
import { ClaudeCodeRunner } from '../../src/runner/claude-code.js';
import { CodexRunner, codexSlots, type CodexSettings } from '../../src/runner/codex.js';
import { DEFAULT_CODEX_COMMAND } from '../../src/runner/command.js';
import { parseEnvFile } from '../../src/runner/shim-command.js';
import { substitute } from '../../src/runner/subprocess.js';
import type { Launch } from '../../src/state/store.js';

const TOKEN = 'tok-secret-7f3a';
const MAX_WAIT_MS = 60 * 60_000;
const SHIM = { command: 'node', args: ['/opt/orch/dist/agent/mcp-shim.js'] };
const defaults: CodexSettings = { sandbox: 'workspace-write', ephemeral: true, ignoreUserConfig: true };

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function launchIn(worktree: string, id = 'L1'): Launch {
  return { launchId: id, taskId: 'T1', attempt: 1, launchNo: 1, status: 'launching', token: TOKEN, branch: 'task/T1/l1', worktree, baseSha: 'b', graphRev: 'r', createdAt: 1, runner: 'codex', model: 'gpt-6-astra', effort: 'xhigh' } as Launch;
}

/** The command the runner would run, composed exactly as SubprocessRunner.spawn does. */
function compose(settings: Partial<CodexSettings> = {}, worktree = '/wt/L1'): string {
  const launch = launchIn(worktree);
  const orch = path.join(worktree, '.orchestrator');
  return substitute(DEFAULT_CODEX_COMMAND, {
    brief: path.join(orch, 'brief.md'),
    worktree,
    model: launch.model ?? '',
    effort: launch.effort ?? '',
    ...codexSlots(launch, { ...defaults, ...settings }, MAX_WAIT_MS, SHIM),
  });
}

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (!existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
  return readFileSync(file, 'utf8');
}

// See specs/worker-runners "Codex runner command composition".
describe('Codex runner command', () => {
  it('composes the verified flags, the shim registration, the approvals, and the timeouts, with no token', () => {
    const cmd = compose();
    expect(cmd.startsWith('codex exec --json ')).toBe(true);
    for (const part of [
      '--ephemeral',
      '--ignore-user-config',
      '-C /wt/L1',
      '-m gpt-6-astra',
      `-c model_reasoning_effort='"xhigh"'`,
      '-s workspace-write',
      `-c approval_policy='"never"'`,
      `-c mcp_servers.orchestrator.default_tools_approval_mode='"approve"'`,
      `-c mcp_servers.orchestrator.command='"node"'`,
      `-c mcp_servers.orchestrator.args='["/opt/orch/dist/agent/mcp-shim.js","--orch-env-file","/wt/L1/.orchestrator/shim.env"]'`,
      '-c mcp_servers.orchestrator.required=true',
      '-c mcp_servers.orchestrator.startup_timeout_sec=30',
      '-c mcp_servers.orchestrator.tool_timeout_sec=3660',
      '-o /wt/L1/.orchestrator/last-message.txt',
    ])
      expect(cmd).toContain(part);
    for (const tool of TOOL_NAMES) expect(cmd).toContain(`-c mcp_servers.orchestrator.tools.${tool}.approval_mode='"approve"'`);
    expect(TOOL_NAMES).toEqual(['heartbeat', 'report', 'block', 'inbox', 'log']);
    expect(cmd.endsWith(' - < /wt/L1/.orchestrator/brief.md')).toBe(true);
    expect(cmd).not.toContain(TOKEN);
    expect(cmd).not.toContain('ORCH_TOKEN');
    expect(cmd).not.toContain('--full-auto');
    expect(cmd).not.toContain('--dangerously-bypass');
    expect(cmd).not.toContain('network_access');
    expect(cmd).not.toMatch(/\{\w+\}/);
  });

  it('follows the runner.codex keys', () => {
    expect(compose({ toolTimeoutSec: 120 })).toContain('tool_timeout_sec=120');
    expect(compose({ startupTimeoutSec: 5 })).toContain('startup_timeout_sec=5');
    const plain = compose({ ephemeral: false, ignoreUserConfig: false });
    expect(plain).not.toContain('--ephemeral');
    expect(plain).not.toContain('--ignore-user-config');
    expect(compose({ networkAccess: true })).toContain('-c sandbox_workspace_write.network_access=true');
    expect(compose({ sandbox: 'danger-full-access' })).toContain('-s danger-full-access');
    const custom = compose({ mcpApproval: `-c approval_policy='"on-request"'` });
    expect(custom).toContain(`-c approval_policy='"on-request"'`);
    expect(custom).not.toContain('"never"');
    expect(custom).not.toContain('approval_mode');
  });

  it('sizes the tool timeout a minute above maxWaitMs', () => {
    const launch = launchIn('/wt');
    expect(codexSlots(launch, defaults, 90_500, SHIM).codexOverrides).toContain('tool_timeout_sec=151');
  });

  it('the shell hands codex each -c value as one TOML word', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-codex-sh-'));
    dirs.push(dir);
    const brief = path.join(dir, '.orchestrator', 'brief.md');
    mkdirSync(path.dirname(brief), { recursive: true });
    writeFileSync(brief, 'prompt');
    const cmd = compose({}, dir);
    const out = execFileSync('/bin/sh', ['-c', `codex() { printf '%s\\n' "$@"; }\n${cmd}`], { encoding: 'utf8' });
    const argv = out.trimEnd().split('\n');
    expect(argv.slice(0, 2)).toEqual(['exec', '--json']);
    expect(argv).toContain('approval_policy="never"');
    expect(argv).toContain('model_reasoning_effort="xhigh"');
    expect(argv).toContain(`mcp_servers.orchestrator.args=["/opt/orch/dist/agent/mcp-shim.js","--orch-env-file","${dir}/.orchestrator/shim.env"]`);
    expect(argv).toContain('mcp_servers.orchestrator.tools.block.approval_mode="approve"');
    expect(argv.at(-1)).toBe('-');
  });

  it('substitute() leaves a TOML inline table untouched', () => {
    expect(substitute(`-c mcp_servers.x.env='{ORCH_API="x"}'`, { ORCH_API: 'y' })).toBe(`-c mcp_servers.x.env='{ORCH_API="x"}'`);
  });
});

// See specs/agent-protocol "Launch token scoping".
describe('Codex runner spawn', () => {
  it('writes the shim env file 0600 with the four ORCH_ variables and runs the composed command', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-codex-'));
    dirs.push(dir);
    const worktree = path.join(dir, 'wt');
    mkdirSync(worktree, { recursive: true });
    const runner = new CodexRunner({
      command: () => 'echo {sandbox} {ephemeral} > {worktree}/.orchestrator/out.txt',
      settings: () => defaults,
      maxWaitMs: MAX_WAIT_MS,
      retryWindowMs: 5000,
      logDir: path.join(dir, 'logs'),
      shim: SHIM,
    });
    const launch = launchIn(worktree);
    await runner.spawn(launch, { ORCH_API: 'http://127.0.0.1:9', ORCH_COMMIT_POLICY: 'daemon' });
    const file = path.join(worktree, '.orchestrator', 'shim.env');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(parseEnvFile(readFileSync(file, 'utf8'))).toMatchObject({ ORCH_API: 'http://127.0.0.1:9', ORCH_LAUNCH_ID: 'L1', ORCH_TOKEN: TOKEN, ORCH_RETRY_WINDOW_MS: '5000', ORCH_COMMIT_POLICY: 'daemon' });
    expect((await waitForFile(path.join(worktree, '.orchestrator', 'out.txt'))).trim()).toBe('workspace-write --ephemeral');
  });

  it('the Claude runner writes mcp.json 0600 through the same helper', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-claude-'));
    dirs.push(dir);
    const worktree = path.join(dir, 'wt');
    mkdirSync(worktree, { recursive: true });
    const runner = new ClaudeCodeRunner({ command: 'true', logDir: path.join(dir, 'logs'), retryWindowMs: 5000, shim: SHIM });
    await runner.spawn(launchIn(worktree), { ORCH_API: 'http://127.0.0.1:9' });
    const file = path.join(worktree, '.orchestrator', 'mcp.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const mcp = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: { orchestrator: { env: Record<string, string> } } };
    expect(mcp.mcpServers.orchestrator.env).toEqual({ ORCH_API: 'http://127.0.0.1:9', ORCH_LAUNCH_ID: 'L1', ORCH_TOKEN: TOKEN, ORCH_RETRY_WINDOW_MS: '5000' });
  });

  it('both runners take shimEnv and shimCommand from shim-command.ts', () => {
    const src = (f: string) => readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/runner', f), 'utf8');
    for (const f of ['claude-code.ts', 'codex.ts']) {
      expect(src(f)).toMatch(/import \{[^}]*\bshimCommand\b[^}]*\bshimEnv\b[^}]*\} from '\.\/shim-command\.js'/);
      expect(src(f)).not.toMatch(/function shimCommand/);
    }
  });
});
