/**
 * Codex runner: `codex exec --json` in the launch worktree with the brief on
 * stdin. The orchestrator shim is registered per launch through `-c` overrides:
 * a required server, approvals pre-granted, a tool timeout above maxWaitMs, and
 * the launch token in a 0600 env file rather than on argv. See specs/worker-runners
 * "Codex runner command composition" and "Codex usage parsing".
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TOOL_NAMES } from '../agent/mcp-shim.js';
import type { Launch } from '../state/store.js';
import type { CodexSandbox } from './selection.js';
import { logPath, SubprocessRunner, type SubprocessRunnerOptions } from './subprocess.js';
import type { SpawnResult, TokenUsage, Usage } from './runner.js';
import { formatEnvFile, shimCommand, shimEnv } from './shim-command.js';

export { DEFAULT_CODEX_COMMAND } from './command.js';

/** The MCP server id the shim is registered under; the agent sees its tools as `orchestrator.<tool>`. */
export const CODEX_MCP_ID = 'orchestrator';
export const DEFAULT_CODEX_STARTUP_TIMEOUT_SEC = 30;

/** The `runner.codex` keys this runner reads at every spawn. */
export interface CodexSettings {
  sandbox: CodexSandbox;
  ephemeral: boolean;
  ignoreUserConfig: boolean;
  networkAccess?: boolean;
  mcpApproval?: string;
  toolTimeoutSec?: number;
  startupTimeoutSec?: number;
}

export interface CodexRunnerOptions extends Omit<SubprocessRunnerOptions, 'extraVars' | 'allowedTools'> {
  /** Read at every spawn, so a runtime override of `codex.sandbox` reaches the next launch. */
  settings: () => CodexSettings;
  /** The daemon's long-poll ceiling for `block`; the MCP tool timeout is sized above it. */
  maxWaitMs: number;
  retryWindowMs: number;
  shim?: { command: string; args: string[] };
}

/** A single-quoted shell word. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A TOML basic string; JSON's escapes are a subset TOML accepts for these values. */
function toml(s: string): string {
  return JSON.stringify(s);
}

/** One `-c key=value` override with the TOML value shell-quoted. */
function override(key: string, tomlValue: string): string {
  return `-c ${key}=${sq(tomlValue)}`;
}

/**
 * The approval overrides probed on codex-cli 0.163.0: under `approval_policy="never"` an MCP call is
 * refused unless the server's default and each tool's approval mode is `approve`. Which key suffices
 * alone is not established, so both are set. `runner.codex.mcpApproval` replaces this string.
 */
export function defaultCodexApproval(id = CODEX_MCP_ID): string {
  return [
    override('approval_policy', toml('never')),
    override(`mcp_servers.${id}.default_tools_approval_mode`, toml('approve')),
    ...TOOL_NAMES.map((t) => override(`mcp_servers.${id}.tools.${t}.approval_mode`, toml('approve'))),
  ].join(' ');
}

export function shimEnvPath(worktree: string): string {
  return path.join(worktree, '.orchestrator', 'shim.env');
}

/** The tool timeout in seconds: the configured one, else a minute above the long-poll ceiling. */
export function codexToolTimeoutSec(settings: Pick<CodexSettings, 'toolTimeoutSec'>, maxWaitMs: number): number {
  return settings.toolTimeoutSec ?? Math.ceil(maxWaitMs / 1000) + 60;
}

/** The {codexOverrides} slot: the shim registration, its timeouts, the approvals, and the network flag. No token. */
export function codexOverrides(launch: Pick<Launch, 'worktree'>, settings: CodexSettings, maxWaitMs: number, shim: { command: string; args: string[] } = shimCommand()): string {
  const id = CODEX_MCP_ID;
  const args = [...shim.args, '--orch-env-file', shimEnvPath(launch.worktree)];
  return [
    override(`mcp_servers.${id}.command`, toml(shim.command)),
    override(`mcp_servers.${id}.args`, `[${args.map(toml).join(',')}]`),
    `-c mcp_servers.${id}.required=true`,
    `-c mcp_servers.${id}.startup_timeout_sec=${settings.startupTimeoutSec ?? DEFAULT_CODEX_STARTUP_TIMEOUT_SEC}`,
    `-c mcp_servers.${id}.tool_timeout_sec=${codexToolTimeoutSec(settings, maxWaitMs)}`,
    settings.mcpApproval ?? defaultCodexApproval(id),
    ...(settings.networkAccess ? ['-c sandbox_workspace_write.network_access=true'] : []),
  ].join(' ');
}

/** The slots the Codex template carries beyond the subprocess runner's fixed set. */
export function codexSlots(launch: Pick<Launch, 'worktree'>, settings: CodexSettings, maxWaitMs: number, shim?: { command: string; args: string[] }): Record<string, string> {
  return {
    sandbox: settings.sandbox,
    ephemeral: settings.ephemeral ? '--ephemeral' : '',
    ignoreUserConfig: settings.ignoreUserConfig ? '--ignore-user-config' : '',
    codexOverrides: codexOverrides(launch, settings, maxWaitMs, shim),
  };
}

export class CodexRunner extends SubprocessRunner {
  constructor(private readonly cxOpts: CodexRunnerOptions) {
    super({ ...cxOpts, extraVars: (launch) => codexSlots(launch, cxOpts.settings(), cxOpts.maxWaitMs, cxOpts.shim) });
  }

  async spawn(launch: Launch, env: Record<string, string>): Promise<SpawnResult> {
    await mkdir(path.join(launch.worktree, '.orchestrator'), { recursive: true });
    // The MCP server codex starts is not sandboxed and receives no ORCH_* from the agent's environment; the env file carries them. See specs/agent-protocol "Launch token scoping".
    const file = shimEnvPath(launch.worktree);
    await writeFile(file, formatEnvFile(shimEnv(launch, env, this.cxOpts.retryWindowMs)), { encoding: 'utf8', mode: 0o600 });
    await chmod(file, 0o600);
    return super.spawn(launch, env);
  }

  /** `codex exec --json` writes JSONL; see `parseCodexUsage`. */
  async readUsage(launch: Launch): Promise<Usage | undefined> {
    const text = await readFile(logPath(this.cxOpts.logDir, launch.launchId), 'utf8').catch(() => '');
    return parseCodexUsage(text);
  }
}

const TOKEN_FIELDS = [
  ['input_tokens', 'input'],
  ['cached_input_tokens', 'cachedInput'],
  ['cache_write_input_tokens', 'cacheWriteInput'],
  ['output_tokens', 'output'],
  ['reasoning_output_tokens', 'reasoningOutput'],
] as const;

/**
 * The token usage of a Codex log: `usage` summed over every `turn.completed` line, stderr and
 * unparseable lines skipped. Codex's `input_tokens` already counts cached input, so it is kept as is.
 * No cost, duration, or turns: one exec is one Codex turn, not comparable with Claude's `num_turns`.
 * Undefined when the log holds no `turn.completed` with input and output counts.
 */
export function parseCodexUsage(text: string): Usage | undefined {
  const tail = text.length > 256 * 1024 ? text.slice(text.length - 256 * 1024) : text;
  let tokens: TokenUsage | undefined;
  for (const line of tail.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('turn.completed')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const o = parsed as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || o['type'] !== 'turn.completed' || !o['usage'] || typeof o['usage'] !== 'object') continue;
    const u = o['usage'] as Record<string, unknown>;
    const num = (k: string) => (typeof u[k] === 'number' && Number.isFinite(u[k]) && (u[k] as number) >= 0 ? (u[k] as number) : undefined);
    if (num('input_tokens') === undefined || num('output_tokens') === undefined) continue;
    const t: TokenUsage = tokens ?? { input: 0, output: 0 };
    for (const [from, to] of TOKEN_FIELDS) {
      const v = num(from);
      if (v !== undefined) t[to] = (t[to] ?? 0) + v;
    }
    tokens = t;
  }
  return tokens ? { tokens, source: 'codex' } : undefined;
}
