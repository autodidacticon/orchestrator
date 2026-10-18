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
import { DEFAULT_CODEX_COMMAND } from './command.js';
import { fixedSlots, logPath, SubprocessRunner, substitute, type SubprocessRunnerOptions } from './subprocess.js';
import type { RunnerFailure, SpawnResult, TokenUsage, Usage } from './runner.js';
import { formatEnvFile, shimCommand, shimEnv } from './shim-command.js';

export { DEFAULT_CODEX_COMMAND };

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

/** What `composeCodexCommand` needs beyond the launch: the template, the `runner.codex` keys, and the long-poll ceiling. */
export interface CodexCommandPolicy {
  /** The command template; unset is DEFAULT_CODEX_COMMAND. */
  template?: string;
  settings: CodexSettings;
  maxWaitMs: number;
  shim?: { command: string; args: string[] };
  /** The file fed to stdin through {brief}; unset is `.orchestrator/brief.md`. A worker loop passes its preamble plus the brief. */
  brief?: string;
}

/**
 * The `codex exec` shell command for a launch: the template with the fixed slots, the model and
 * effort fixed on the launch, and the Codex slots (sandbox, flags, the shim's `-c` overrides). The
 * Codex runner and the Codex work loop (hosts/codex/bin/work.mjs) both compose through this, so a
 * claimed launch runs the same command as a spawned one. See specs/worker-runners "Codex runner
 * command composition" and specs/host-integration "Codex work loop".
 */
export function composeCodexCommand(launch: Pick<Launch, 'worktree' | 'launchId' | 'taskId' | 'model' | 'effort'>, policy: CodexCommandPolicy): string {
  return substitute(policy.template ?? DEFAULT_CODEX_COMMAND, {
    ...fixedSlots(launch),
    ...(policy.brief ? { brief: policy.brief } : {}),
    allowedTools: '',
    ...codexSlots(launch, policy.settings, policy.maxWaitMs, policy.shim),
  });
}

/**
 * Write the shim's 0600 env file for a launch: the MCP server codex starts is not sandboxed and
 * receives no ORCH_* from the agent's environment, so the file carries them. See specs/agent-protocol
 * "Launch token scoping".
 */
export async function writeCodexShimEnv(launch: Pick<Launch, 'worktree' | 'launchId' | 'token'>, env: Record<string, string>, retryWindowMs: number): Promise<string> {
  await mkdir(path.join(launch.worktree, '.orchestrator'), { recursive: true });
  const file = shimEnvPath(launch.worktree);
  await writeFile(file, formatEnvFile(shimEnv(launch as Launch, env, retryWindowMs)), { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

export class CodexRunner extends SubprocessRunner {
  constructor(private readonly cxOpts: CodexRunnerOptions) {
    super({
      ...cxOpts,
      compose: (launch) => {
        const template = typeof cxOpts.command === 'function' ? cxOpts.command() : cxOpts.command;
        return composeCodexCommand(launch, { template, settings: cxOpts.settings(), maxWaitMs: cxOpts.maxWaitMs, shim: cxOpts.shim });
      },
    });
  }

  async spawn(launch: Launch, env: Record<string, string>): Promise<SpawnResult> {
    await writeCodexShimEnv(launch, env, this.cxOpts.retryWindowMs);
    return super.spawn(launch, env);
  }

  /** `codex exec --json` writes JSONL; see `parseCodexUsage`. */
  async readUsage(launch: Launch): Promise<Usage | undefined> {
    const text = await readFile(logPath(this.cxOpts.logDir, launch.launchId), 'utf8').catch(() => '');
    return parseCodexUsage(text);
  }

  /** Why the launch ended without a report, from the same log; see `classifyCodexFailure`. */
  async readFailure(launch: Launch): Promise<RunnerFailure | undefined> {
    const text = await readFile(logPath(this.cxOpts.logDir, launch.launchId), 'utf8').catch(() => undefined);
    return text === undefined ? undefined : classifyCodexFailure(text);
  }
}

/** The reasons `classifyCodexFailure` names. Runner detail on `exitedWithoutReport`, not failure kinds. */
export type CodexFailureReason = 'unknownModel' | 'authFailed' | 'mcpStartupFailed' | 'mcpApprovalRefused' | 'sandboxDenied' | 'turnFailed' | 'exitBeforeTurn';

const UNKNOWN_MODEL = /model metadata for .* not found|model\b.*\b(does not exist|not found|is not supported|unknown)|unknown model|model_not_found/i;
const AUTH_FAILED = /\b401\b|unauthori[sz]ed|not logged in|codex login|authentication|invalid api key|api key\b.*\b(missing|invalid|not set)|token (has )?expired/i;
const MCP_STARTUP = /mcp server\b.*\b(failed to start|failed to initiali[sz]e)|mcp servers? failed to initiali[sz]e/i;
const APPROVAL = /approv|reject|denied|declin|cancel/i;
const NOT_PERMITTED = /operation not permitted/i;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function errorText(v: unknown): string | undefined {
  if (typeof v === 'string') return str(v);
  if (v && typeof v === 'object') return str((v as Record<string, unknown>)['message']);
  return undefined;
}

/** The first line of `text` that matches, else the first line. */
function lineOf(text: string, re?: RegExp): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return (re && lines.find((l) => re.test(l))) ?? lines[0] ?? text.trim();
}

/**
 * Why a Codex launch ended without a report, from its log (stdout JSONL and stderr in one file):
 * - an `error` event, an `error` item, or `turn.failed` naming an unknown model (`unknownModel`),
 *   a missing or rejected login (`authFailed`), or a required MCP server that did not start (`mcpStartupFailed`);
 * - a failed `mcp_tool_call` refused for approval (`mcpApprovalRefused`);
 * - the last `command_execution` failing with `Operation not permitted` (`sandboxDenied`);
 * - any other `turn.failed` or `error` (`turnFailed`);
 * - otherwise undefined once a turn completed, else stderr is matched the same way, else `exitBeforeTurn`
 *   when no turn ever started.
 * `detail` is the message or log line that shows it. See specs/task-lifecycle "Health failure reasons".
 */
export function classifyCodexFailure(text: string): { reason: CodexFailureReason; detail?: string } | undefined {
  const tail = text.length > 256 * 1024 ? text.slice(text.length - 256 * 1024) : text;
  const errors: string[] = [];
  const stderr: string[] = [];
  let refused: string | undefined;
  let lastCommand: { command: string; failed: boolean; output: string } | undefined;
  let started = false;
  let completed = false;
  for (const line of tail.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: Record<string, unknown> | undefined;
    if (trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') o = parsed as Record<string, unknown>;
      } catch {
        /* a stderr line that starts with a brace */
      }
    }
    if (!o) {
      stderr.push(trimmed);
      continue;
    }
    const type = o['type'];
    if (type === 'turn.started') started = true;
    else if (type === 'turn.completed') completed = true;
    else if (type === 'error') {
      const m = errorText(o['message']) ?? errorText(o['error']);
      if (m) errors.push(m);
    } else if (type === 'turn.failed') {
      started = true;
      const m = errorText(o['error']) ?? errorText(o['message']);
      if (m) errors.push(m);
    } else if (type === 'item.completed' && o['item'] && typeof o['item'] === 'object') {
      const item = o['item'] as Record<string, unknown>;
      if (item['type'] === 'error') {
        const m = errorText(item['message']) ?? errorText(item['error']);
        if (m) errors.push(m);
      } else if (item['type'] === 'mcp_tool_call' && item['status'] === 'failed') {
        const m = errorText(item['error']) ?? str(item['result']) ?? '';
        if (APPROVAL.test(m)) refused = `${String(item['server'] ?? '')}.${String(item['tool'] ?? '')}: ${m}`;
      } else if (item['type'] === 'command_execution') {
        const code = item['exit_code'];
        lastCommand = {
          command: String(item['command'] ?? ''),
          failed: item['status'] === 'failed' || (typeof code === 'number' && code !== 0),
          output: String(item['aggregated_output'] ?? ''),
        };
      }
    }
  }
  const named = (texts: string[]): { reason: CodexFailureReason; detail: string } | undefined => {
    for (const [reason, re] of [['mcpStartupFailed', MCP_STARTUP], ['authFailed', AUTH_FAILED], ['unknownModel', UNKNOWN_MODEL]] as const) {
      const hit = texts.find((t) => re.test(t));
      if (hit) return { reason, detail: lineOf(hit, re) };
    }
    return undefined;
  };
  const fromErrors = named(errors);
  if (fromErrors) return fromErrors;
  if (refused) return { reason: 'mcpApprovalRefused', detail: refused };
  if (lastCommand?.failed && NOT_PERMITTED.test(lastCommand.output)) {
    return { reason: 'sandboxDenied', detail: `${lastCommand.command}: ${lineOf(lastCommand.output, NOT_PERMITTED)}` };
  }
  if (errors.length) return { reason: 'turnFailed', detail: errors[errors.length - 1] };
  if (completed) return undefined;
  const fromStderr = named(stderr);
  if (fromStderr) return fromStderr;
  const denied = stderr.find((l) => NOT_PERMITTED.test(l));
  if (denied) return { reason: 'sandboxDenied', detail: denied };
  if (!started) {
    const last = [...stderr].reverse().find((l) => /error|fatal|failed/i.test(l)) ?? stderr[stderr.length - 1];
    return { reason: 'exitBeforeTurn', ...(last ? { detail: last } : {}) };
  }
  return undefined;
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
