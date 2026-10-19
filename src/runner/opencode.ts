/**
 * OpenCode runner: `opencode run --format json` in the launch worktree with the
 * brief on stdin as the whole message. The orchestrator shim, the permission
 * ruleset, and snapshots off are passed per launch through OPENCODE_CONFIG_CONTENT,
 * which outranks a repository's own opencode.json. The MCP child inherits the
 * agent environment, so the launch token is neither on argv nor in a config. See
 * specs/worker-runners "OpenCode runner command composition" and "OpenCode usage parsing".
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Launch } from '../state/store.js';
import type { OpenCodeDataDir, OpenCodePermission } from './selection.js';
import { DEFAULT_OPENCODE_COMMAND } from './command.js';
import { fixedSlots, logPath, SubprocessRunner, substitute, type SubprocessRunnerOptions } from './subprocess.js';
import type { RunnerFailure, SpawnResult, TokenUsage, Usage } from './runner.js';
import { shimCommand, shimEnv } from './shim-command.js';

export { DEFAULT_OPENCODE_COMMAND };

/** The MCP server id the shim is registered under; the agent sees its tools as `orchestrator_<tool>`. */
export const OPENCODE_MCP_ID = 'orchestrator';

/** The `runner.opencode` keys this runner reads at every spawn. */
export interface OpenCodeSettings {
  permission: OpenCodePermission;
  dataDir: OpenCodeDataDir;
  ignoreUserConfig: boolean;
  pure: boolean;
  snapshots: boolean;
  /** The MCP call timeout; unset is a minute above maxWaitMs. */
  toolTimeoutMs?: number;
}

export interface OpenCodeRunnerOptions extends SubprocessRunnerOptions {
  /** Read at every spawn, so a change to `runner.opencode` reaches the next launch. */
  settings: () => OpenCodeSettings;
  /** The daemon's long-poll ceiling for `block`; the MCP call timeout is sized above it. */
  maxWaitMs: number;
  retryWindowMs: number;
  shim?: { command: string; args: string[] };
}

/** The value OPENCODE_CONFIG_CONTENT carries; the same JSON is written to `.orchestrator/opencode.json`. */
export interface OpenCodeConfig {
  $schema: string;
  mcp: Record<string, { type: 'local'; command: string[]; enabled: true; timeout: number }>;
  snapshots?: false;
  share: 'disabled';
  permission: Record<string, unknown>;
}

/**
 * The MCP call timeout in ms: the configured one, else a minute above the long-poll ceiling. OpenCode
 * cuts a call at 60 000 ms by default and drops `mcp.timeout.execution`; the per-server `timeout` is
 * honoured (test/fixtures/opencode/events/T1-T4.jsonl).
 */
export function openCodeToolTimeoutMs(settings: Pick<OpenCodeSettings, 'toolTimeoutMs'>, maxWaitMs: number): number {
  return settings.toolTimeoutMs ?? maxWaitMs + 60_000;
}

/**
 * OpenCode bash patterns for the derived allow rules: `Bash(x:*)` is `x *`, `Bash(x)` is `x`; any
 * other rule (the Claude MCP tool names) has no bash pattern.
 */
export function bashPatterns(allowedTools: readonly string[]): string[] {
  const out: string[] = [];
  for (const rule of allowedTools) {
    const m = /^Bash\((.+)\)$/.exec(rule);
    if (!m) continue;
    const body = (m[1] as string).trim();
    out.push(body.endsWith(':*') ? `${body.slice(0, -2)} *` : body);
  }
  return out;
}

/**
 * The permission ruleset. `derived`: every tool asks (a headless ask is auto-rejected and surfaces to
 * the agent as a tool error), the file tools are allowed, bash allows `git *` and the derived patterns,
 * and the orchestrator tools are allowed. `allow`: every tool is allowed. The catch-all comes first:
 * OpenCode takes the last matching rule.
 */
export function openCodePermission(permission: OpenCodePermission, allowedTools: readonly string[]): Record<string, unknown> {
  if (permission === 'allow') return { '*': 'allow' };
  const bash: Record<string, string> = { '*': 'ask', 'git *': 'allow' };
  for (const p of bashPatterns(allowedTools)) bash[p] = 'allow';
  return {
    '*': 'ask',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    edit: 'allow',
    bash,
    [`${OPENCODE_MCP_ID}_*`]: 'allow',
  };
}

/**
 * The per-launch OpenCode config: the shim as a local MCP server with no `environment` block (it
 * inherits ORCH_* from the agent environment), the call timeout, snapshots off unless configured,
 * sharing disabled, and the permission ruleset. Never `mcp.timeout`, which 1.18.30 drops.
 */
export function openCodeConfig(settings: OpenCodeSettings, allowedTools: readonly string[], maxWaitMs: number, shim: { command: string; args: string[] } = shimCommand()): OpenCodeConfig {
  return {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      [OPENCODE_MCP_ID]: { type: 'local', command: [shim.command, ...shim.args], enabled: true, timeout: openCodeToolTimeoutMs(settings, maxWaitMs) },
    },
    ...(settings.snapshots ? {} : { snapshots: false as const }),
    share: 'disabled',
    permission: openCodePermission(settings.permission, allowedTools),
  };
}

export function openCodeConfigPath(worktree: string): string {
  return path.join(worktree, '.orchestrator', 'opencode.json');
}

/**
 * The variables a launch adds to the agent environment: OPENCODE_CONFIG_CONTENT, XDG_DATA_HOME under
 * `dataDir: launch` (a private database, log, and auth.json), and XDG_CONFIG_HOME pointing at an empty
 * dir under `ignoreUserConfig`. Creates those dirs and writes `.orchestrator/opencode.json` 0600 for
 * debugging; the file is never passed to opencode.
 */
export async function prepareOpenCodeLaunch(launch: Pick<Launch, 'worktree'>, settings: OpenCodeSettings, config: OpenCodeConfig): Promise<Record<string, string>> {
  const orchDir = path.join(launch.worktree, '.orchestrator');
  await mkdir(orchDir, { recursive: true });
  const json = JSON.stringify(config);
  const file = openCodeConfigPath(launch.worktree);
  await writeFile(file, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600);
  const env: Record<string, string> = { OPENCODE_CONFIG_CONTENT: json };
  if (settings.dataDir === 'launch') {
    const dir = path.join(orchDir, 'opencode-data');
    await mkdir(dir, { recursive: true });
    env['XDG_DATA_HOME'] = dir;
  }
  if (settings.ignoreUserConfig) {
    const dir = path.join(orchDir, 'opencode-config');
    await mkdir(dir, { recursive: true });
    env['XDG_CONFIG_HOME'] = dir;
  }
  return env;
}

/** The slots the OpenCode template carries beyond the subprocess runner's fixed set. */
export function openCodeSlots(launch: Pick<Launch, 'effort'>, settings: Pick<OpenCodeSettings, 'pure'>): Record<string, string> {
  return {
    pure: settings.pure ? '--pure' : '',
    variant: launch.effort ? `--variant ${launch.effort}` : '',
  };
}

/** What `composeOpenCodeCommand` needs beyond the launch. */
export interface OpenCodeCommandPolicy {
  /** The command template; unset is DEFAULT_OPENCODE_COMMAND. */
  template?: string;
  settings: Pick<OpenCodeSettings, 'pure'>;
  /** The file fed to stdin through {brief}; unset is `.orchestrator/brief.md`. A worker loop passes its preamble plus the brief. */
  brief?: string;
}

/**
 * The `opencode run` shell command for a launch: the template with the fixed slots, the model and
 * effort fixed on the launch, {pure}, and {variant}. No token and no config path. The runner and a
 * work loop both compose through this. See specs/worker-runners "OpenCode runner command composition".
 */
export function composeOpenCodeCommand(launch: Pick<Launch, 'worktree' | 'launchId' | 'taskId' | 'model' | 'effort'>, policy: OpenCodeCommandPolicy): string {
  return substitute(policy.template ?? DEFAULT_OPENCODE_COMMAND, {
    ...fixedSlots(launch),
    ...(policy.brief ? { brief: policy.brief } : {}),
    allowedTools: '',
    ...openCodeSlots(launch, policy.settings),
  });
}

export class OpenCodeRunner extends SubprocessRunner {
  constructor(private readonly ocOpts: OpenCodeRunnerOptions) {
    super({
      ...ocOpts,
      compose: (launch) => {
        const template = typeof ocOpts.command === 'function' ? ocOpts.command() : ocOpts.command;
        return composeOpenCodeCommand(launch, { template, settings: ocOpts.settings() });
      },
    });
  }

  async spawn(launch: Launch, env: Record<string, string>): Promise<SpawnResult> {
    const settings = this.ocOpts.settings();
    const config = openCodeConfig(settings, this.ocOpts.allowedTools?.() ?? [], this.ocOpts.maxWaitMs, this.ocOpts.shim);
    const extra = await prepareOpenCodeLaunch(launch, settings, config);
    // The shim reads its identity from the environment the MCP child inherits.
    return super.spawn(launch, { ...env, ...shimEnv(launch, env, this.ocOpts.retryWindowMs), ...extra });
  }

  /** `opencode run --format json` writes JSONL; see `parseOpenCodeUsage`. */
  async readUsage(launch: Launch): Promise<Usage | undefined> {
    const text = await readFile(logPath(this.ocOpts.logDir, launch.launchId), 'utf8').catch(() => '');
    return parseOpenCodeUsage(text);
  }

  /** Why the launch ended without a report, from the same log; see `classifyOpenCodeFailure`. */
  async readFailure(launch: Launch): Promise<RunnerFailure | undefined> {
    const text = await readFile(logPath(this.ocOpts.logDir, launch.launchId), 'utf8').catch(() => undefined);
    return text === undefined ? undefined : classifyOpenCodeFailure(text);
  }
}

/** The reasons `classifyOpenCodeFailure` names. Runner detail on `exitedWithoutReport`, not failure kinds. */
export type OpenCodeFailureReason = 'mcpStartupFailed' | 'unknownModel' | 'authFailed' | 'startupContended' | 'permissionDenied' | 'turnFailed' | 'exitBeforeTurn';

// Probe results of opencode 1.18.30 (test/fixtures/opencode/events); `--log-level WARN` is what puts them on stderr.
const MCP_UNAVAILABLE = new RegExp(`server unavailable"?\\s+key=${OPENCODE_MCP_ID}\\b`);
const ERROR_LINE = /\blevel=ERROR\b|^Error\b/;
const UNKNOWN_MODEL = /ProviderModelNotFoundError|Model not found/i;
// Carried over from the Codex classifier: no failed login was observed. The bare word "authentication" is not a failure.
const AUTH_FAILED = /\b401\b|unauthori[sz]ed|invalid api key|api key\b.*\b(missing|not set)|token (has )?expired|authentication (failed|error|required)/i;
const DB_LOCKED = /database is locked/i;
const REJECTED = /rejected permission/i;
const AUTO_REJECTING = /auto-rejecting/i;
const SKILL_NOISE = /duplicate skill name/;
const ANSI = /\x1b\[[0-9;]*m/g;

function record(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** The `error="..."` value of a log line, else the line. */
function logError(line: string): string {
  return /\berror="((?:[^"\\]|\\.)*)"/.exec(line)?.[1] ?? line;
}

/**
 * Why an OpenCode launch ended without a report, from its log (stdout JSONL and stderr in one file,
 * the tail only). Stderr lines lose their ANSI colours and the `duplicate skill name` warnings. In order:
 * - a WARN `server unavailable key=orchestrator` (`mcpStartupFailed`), even after a completed turn: the agent worked without the shim;
 * - an ERROR line or `error` event naming an unknown model (`unknownModel`), or a missing or rejected login (`authFailed`);
 * - no event at all and a `database is locked` line: another opencode held the shared database at startup (`startupContended`);
 * - a `tool_use` part rejected for permission or an `auto-rejecting` line (`permissionDenied`), with the command;
 * - any other `error` event (`turnFailed`), detailed by the ERROR line carrying its `ref`, else its message;
 * - undefined once a `step_finish` with `reason: "stop"` was seen;
 * - `exitBeforeTurn` when no event was parsed, with the last stderr line that says error, fatal, or failed.
 * See specs/task-lifecycle "Health failure reasons".
 */
export function classifyOpenCodeFailure(text: string): { reason: OpenCodeFailureReason; detail?: string } | undefined {
  const tail = text.length > 256 * 1024 ? text.slice(text.length - 256 * 1024) : text;
  const stderr: string[] = [];
  const errors: Array<{ message?: string; ref?: string }> = [];
  const rejected: string[] = [];
  let events = 0;
  let completed = false;
  for (const line of tail.split('\n')) {
    const trimmed = line.replace(ANSI, '').trim();
    if (!trimmed) continue;
    let o: Record<string, unknown> | undefined;
    if (trimmed.startsWith('{')) {
      try {
        o = record(JSON.parse(trimmed));
      } catch {
        /* a stderr line that starts with a brace */
      }
    }
    if (!o || typeof o['type'] !== 'string') {
      if (!SKILL_NOISE.test(trimmed)) stderr.push(trimmed);
      continue;
    }
    events++;
    const part = record(o['part']);
    if (o['type'] === 'error') {
      const err = record(o['error']);
      const data = record(err?.['data']);
      const message = nonEmpty(data?.['message']) ?? nonEmpty(err?.['message']) ?? nonEmpty(o['error']) ?? nonEmpty(err?.['name']);
      const ref = nonEmpty(data?.['ref']);
      errors.push({ ...(message ? { message } : {}), ...(ref ? { ref } : {}) });
    } else if (o['type'] === 'tool_use' && part) {
      const state = record(part['state']);
      const error = nonEmpty(state?.['error']);
      if (state?.['status'] === 'error' && error && REJECTED.test(error)) {
        const command = nonEmpty(record(state['input'])?.['command']);
        rejected.push(`${String(part['tool'] ?? 'tool')}${command ? ` (${command})` : ''}: ${error}`);
      }
    } else if (o['type'] === 'step_finish' && part?.['reason'] === 'stop') {
      completed = true;
    }
  }
  const mcp = stderr.find((l) => MCP_UNAVAILABLE.test(l));
  if (mcp) return { reason: 'mcpStartupFailed', detail: mcp };
  const errorLines = stderr.filter((l) => ERROR_LINE.test(l));
  const messages = errors.map((e) => e.message).filter((m): m is string => m !== undefined);
  for (const [reason, re] of [['unknownModel', UNKNOWN_MODEL], ['authFailed', AUTH_FAILED]] as const) {
    const line = errorLines.find((l) => re.test(l));
    if (line) return { reason, detail: logError(line) };
    const message = messages.find((m) => re.test(m));
    if (message) return { reason, detail: message };
  }
  if (events === 0) {
    const locked = stderr.find((l) => DB_LOCKED.test(l));
    if (locked) return { reason: 'startupContended', detail: locked };
  }
  if (rejected.length) {
    return { reason: 'permissionDenied', detail: rejected.length > 1 ? `${rejected[0]} (and ${rejected.length - 1} more)` : (rejected[0] as string) };
  }
  const autoRejected = stderr.find((l) => AUTO_REJECTING.test(l));
  if (autoRejected) return { reason: 'permissionDenied', detail: autoRejected };
  const last = errors[errors.length - 1];
  if (last) {
    const refLine = last.ref ? errorLines.find((l) => l.includes(last.ref as string)) : undefined;
    const detail = refLine ? logError(refLine) : last.message;
    return { reason: 'turnFailed', ...(detail ? { detail } : {}) };
  }
  if (completed) return undefined;
  if (events === 0) {
    const fatal = [...stderr].reverse().find((l) => /error|fatal|failed/i.test(l));
    return { reason: 'exitBeforeTurn', ...(fatal ? { detail: fatal } : {}) };
  }
  return undefined;
}

/**
 * The usage of an OpenCode log: every `step_finish` line summed, stderr and unparseable lines skipped.
 * OpenCode's `tokens.input` excludes cache reads (total = input + output + reasoning + cache.read), so
 * cache reads are added to `input` as for Claude. `cost` is summed into `costUsd`; `turns` counts the
 * steps that ended with `reason: "stop"`. No duration. Undefined when no `step_finish` carries input
 * and output counts. See specs/worker-runners "OpenCode usage parsing".
 */
export function parseOpenCodeUsage(text: string): Usage | undefined {
  const tail = text.length > 256 * 1024 ? text.slice(text.length - 256 * 1024) : text;
  let tokens: TokenUsage | undefined;
  let costUsd: number | undefined;
  let turns = 0;
  for (const line of tail.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('step_finish')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const o = parsed as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || o['type'] !== 'step_finish' || !o['part'] || typeof o['part'] !== 'object') continue;
    const part = o['part'] as Record<string, unknown>;
    const t = part['tokens'];
    if (!t || typeof t !== 'object') continue;
    const num = (src: unknown, k: string) => {
      const v = src && typeof src === 'object' ? (src as Record<string, unknown>)[k] : undefined;
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
    };
    const input = num(t, 'input');
    const output = num(t, 'output');
    if (input === undefined || output === undefined) continue;
    const cache = (t as Record<string, unknown>)['cache'];
    const cacheRead = num(cache, 'read') ?? 0;
    const acc: TokenUsage = tokens ?? { input: 0, cachedInput: 0, cacheWriteInput: 0, output: 0, reasoningOutput: 0 };
    acc.input += input + cacheRead;
    acc.cachedInput = (acc.cachedInput ?? 0) + cacheRead;
    acc.cacheWriteInput = (acc.cacheWriteInput ?? 0) + (num(cache, 'write') ?? 0);
    acc.output += output;
    acc.reasoningOutput = (acc.reasoningOutput ?? 0) + (num(t, 'reasoning') ?? 0);
    tokens = acc;
    const cost = num(part, 'cost');
    if (cost !== undefined) costUsd = (costUsd ?? 0) + cost;
    if (part['reason'] === 'stop') turns++;
  }
  return tokens ? { tokens, ...(costUsd !== undefined ? { costUsd } : {}), turns, source: 'opencode' } : undefined;
}
