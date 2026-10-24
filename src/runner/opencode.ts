/**
 * OpenCode runner: `opencode run --format json` in the launch worktree with the
 * brief on stdin as the whole message. The orchestrator shim, the permission
 * ruleset, and snapshots off are passed per launch through OPENCODE_CONFIG_CONTENT,
 * which outranks a repository's own opencode.json. The MCP child inherits the
 * agent environment, so the launch token is neither on argv nor in a config. See
 * specs/worker-runners "OpenCode runner command composition" and "OpenCode usage parsing".
 */
import { createReadStream } from 'node:fs';
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
 * The bash patterns that let a check command run: one per simple command, split outside quotes at
 * `&&`, `||`, `;`, `|`, `|&`, a lone `&`, newlines and grouping parentheses, with a brace group's `{`
 * and `}` dropped. A backslash escapes the next character outside quotes and inside double quotes. The
 * `&` of a redirection (`2>&1`, `&>`, `<&`) and the `|` of `>|` stay in the command. A `$(...)`,
 * backtick or `<(...)`/`>(...)` substitution stays whole in its command and its inner commands get
 * patterns of their own, as OpenCode matches them too (X-subst-*.jsonl, X-backtick-*.jsonl). A heredoc
 * body (the lines after `<<WORD` through the terminator) and an unquoted `#` comment are dropped; neither
 * is a command node. OpenCode 1.18.30 matches each command node, with its redirections, against the rules
 * on its own, and a pattern holding a whole chain never matches (test/fixtures/opencode/events/X-*.jsonl).
 * A pattern is the command verbatim: OpenCode has no escape for `*` and `?`, so a check command holding
 * them yields a wildcard pattern (X-glob-*.jsonl); `[` is literal. A pattern made only of `*`, `?` and
 * spaces is never returned.
 */
export function checkCommandPatterns(checkCommand: string | undefined): string[] {
  if (!checkCommand) return [];
  const out: string[] = [];
  for (const p of splitCommands(checkCommand)) if (!isGlobOnly(p) && !out.includes(p)) out.push(p);
  return out;
}

/** True for a pattern that is empty or holds only `*`, `?` and whitespace: it matches (nearly) every command. */
function isGlobOnly(pattern: string): boolean {
  return /^[\s*?]*$/.test(pattern);
}

/** The index just past the `)` closing a substitution whose body starts at `i`. */
function substitutionEnd(s: string, i: number): number {
  let depth = 1;
  let quote: string | undefined;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && quote !== "'") i++;
    else if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return s.length;
}

/** The index just past the backtick closing a substitution whose body starts at `i`. */
function backtickEnd(s: string, i: number): number {
  for (; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '`') return i + 1;
  }
  return s.length;
}

/** The index just past the heredoc bodies starting at `i`, each up to and including its terminator line. */
function heredocsEnd(s: string, i: number, docs: readonly { word: string; strip: boolean }[]): number {
  for (const doc of docs) {
    while (i < s.length) {
      const nl = s.indexOf('\n', i);
      const end = nl < 0 ? s.length : nl;
      const line = s.slice(i, end);
      i = end + 1;
      if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.word) break;
    }
  }
  return Math.min(i, s.length);
}

function splitCommands(s: string): string[] {
  const out: string[] = [];
  let inner: string[] = [];
  let cur = '';
  let quote: string | undefined;
  let heredocs: { word: string; strip: boolean }[] = [];
  const flush = () => {
    let seg = cur.trim();
    if (/^\{(\s|$)/.test(seg)) seg = seg.slice(1).trim();
    if (seg && !/^\}(\s|$)/.test(seg)) out.push(seg);
    out.push(...inner);
    inner = [];
    cur = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    const next = s[i + 1];
    if (c === '\\' && quote !== "'") {
      cur += c + (next ?? '');
      i++;
    } else if (quote === "'") {
      if (c === quote) quote = undefined;
      cur += c;
    } else if (c === '$' && next === '(' && s[i + 2] === '(') {
      const end = substitutionEnd(s, i + 2);
      cur += s.slice(i, end);
      i = end - 1;
    } else if ((c === '$' && next === '(') || (!quote && (c === '<' || c === '>') && next === '(')) {
      const end = substitutionEnd(s, i + 2);
      inner.push(...splitCommands(s.slice(i + 2, end - 1)));
      cur += s.slice(i, end);
      i = end - 1;
    } else if (c === '`') {
      const end = backtickEnd(s, i + 1);
      inner.push(...splitCommands(s.slice(i + 1, end - 1)));
      cur += s.slice(i, end);
      i = end - 1;
    } else if (quote) {
      if (c === quote) quote = undefined;
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '#' && (cur === '' || /\s$/.test(cur))) {
      while (i + 1 < s.length && s[i + 1] !== '\n') i++;
    } else if (c === '<' && next === '<' && s[i + 2] === '<') {
      cur += '<<<';
      i += 2;
    } else if (c === '<' && next === '<') {
      let j = i + 2;
      const strip = s[j] === '-';
      if (strip) j++;
      while (s[j] === ' ' || s[j] === '\t') j++;
      let word = '';
      while (j < s.length && !/[\s;&|<>()]/.test(s[j] as string)) {
        const w = s[j] as string;
        if (w === "'" || w === '"') {
          const close = s.indexOf(w, j + 1);
          const stop = close < 0 ? s.length : close;
          word += s.slice(j + 1, stop);
          j = stop + 1;
        } else if (w === '\\') {
          word += s[j + 1] ?? '';
          j += 2;
        } else {
          word += w;
          j++;
        }
      }
      if (word) heredocs.push({ word, strip });
      cur += s.slice(i, j);
      i = j - 1;
    } else if (c === '\n' && heredocs.length) {
      flush();
      i = heredocsEnd(s, i + 1, heredocs) - 1;
      heredocs = [];
    } else if (c === '&' && next === '&') {
      flush();
      i++;
    } else if (c === '&' && (next === '>' || /[<>]$/.test(cur))) {
      cur += c;
    } else if (c === '|' && cur.endsWith('>')) {
      cur += c;
    } else if (c === '|') {
      flush();
      if (next === '|' || next === '&') i++;
    } else if (c === '&' || c === ';' || c === '\n' || c === '(' || c === ')') {
      flush();
    } else {
      cur += c;
    }
  }
  flush();
  return out;
}

/**
 * The permission ruleset. `derived`: every tool is denied, the file tools (read, glob, grep, list, edit,
 * write) are allowed, bash allows `git *`, the derived patterns and the check command's own patterns,
 * and the orchestrator tools are allowed. No rule asks: a headless `ask` is auto-rejected and ends the
 * run after that step, while a `deny` returns an error to the model and the run goes on
 * (test/fixtures/opencode/events/P-ask.jsonl, P-deny.jsonl). `allow`: every tool is allowed. The
 * catch-all comes first: OpenCode takes the last matching rule. A derived or check-command pattern made
 * only of `*`, `?` and spaces is skipped, so nothing overwrites the `deny` catch-all.
 */
export function openCodePermission(permission: OpenCodePermission, allowedTools: readonly string[], checkCommand?: string): Record<string, unknown> {
  if (permission === 'allow') return { '*': 'allow' };
  const bash: Record<string, string> = { '*': 'deny', 'git *': 'allow' };
  for (const p of [...bashPatterns(allowedTools), ...checkCommandPatterns(checkCommand)]) if (!isGlobOnly(p)) bash[p] = 'allow';
  return {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    edit: 'allow',
    write: 'allow',
    bash,
    [`${OPENCODE_MCP_ID}_*`]: 'allow',
  };
}

/**
 * The per-launch OpenCode config: the shim as a local MCP server with no `environment` block (it
 * inherits ORCH_* from the agent environment), the call timeout, snapshots off unless configured,
 * sharing disabled, and the permission ruleset (with the check command's patterns under `derived`).
 * Never `mcp.timeout`, which 1.18.30 drops.
 */
export function openCodeConfig(settings: OpenCodeSettings, allowedTools: readonly string[], maxWaitMs: number, shim: { command: string; args: string[] } = shimCommand(), checkCommand?: string): OpenCodeConfig {
  return {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      [OPENCODE_MCP_ID]: { type: 'local', command: [shim.command, ...shim.args], enabled: true, timeout: openCodeToolTimeoutMs(settings, maxWaitMs) },
    },
    ...(settings.snapshots ? {} : { snapshots: false as const }),
    share: 'disabled',
    permission: openCodePermission(settings.permission, allowedTools, checkCommand),
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

/** The check command the launch's brief.json names, if any; the derived ruleset allows it. */
export async function briefCheckCommand(worktree: string): Promise<string | undefined> {
  try {
    const v = (JSON.parse(await readFile(path.join(worktree, '.orchestrator', 'brief.json'), 'utf8')) as { checkCommand?: unknown }).checkCommand;
    return typeof v === 'string' && v.trim() ? v : undefined;
  } catch {
    return undefined;
  }
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
    const config = openCodeConfig(settings, this.ocOpts.allowedTools?.() ?? [], this.ocOpts.maxWaitMs, this.ocOpts.shim, await briefCheckCommand(launch.worktree));
    const extra = await prepareOpenCodeLaunch(launch, settings, config);
    // The shim reads its identity from the environment the MCP child inherits.
    return super.spawn(launch, { ...env, ...shimEnv(launch, env, this.ocOpts.retryWindowMs), ...extra });
  }

  /** `opencode run --format json` writes JSONL; see `parseOpenCodeUsage`. The whole log, streamed. */
  async readUsage(launch: Launch): Promise<Usage | undefined> {
    return readOpenCodeUsage(logPath(this.ocOpts.logDir, launch.launchId)).catch(() => undefined);
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
 * - a `tool_use` part rejected for permission or an `auto-rejecting` line (`permissionDenied`), with the command: an
 *   auto-rejected `ask` ends the run after that step. A `deny` refusal ("The user has specified a rule which prevents
 *   you...") returns an error to the model and the run goes on, so it is not a failure;
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
 * Lines longer than this are skipped unparsed by the usage parser. A `step_finish` line is a few hundred
 * bytes (434 at most in the probe logs); the long lines are tool output (`tool_use` parts carrying file contents).
 */
export const OPENCODE_USAGE_LINE_CAP = 64 * 1024;

/** The running sum of `parseOpenCodeUsage`: `add` one log line at a time, `usage` at the end. */
class OpenCodeUsageSum {
  private tokens: TokenUsage | undefined;
  private costUsd: number | undefined;
  private turns = 0;

  add(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('step_finish')) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    const o = parsed as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || o['type'] !== 'step_finish' || !o['part'] || typeof o['part'] !== 'object') return;
    const part = o['part'] as Record<string, unknown>;
    const t = part['tokens'];
    if (!t || typeof t !== 'object') return;
    const num = (src: unknown, k: string) => {
      const v = src && typeof src === 'object' ? (src as Record<string, unknown>)[k] : undefined;
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
    };
    const input = num(t, 'input');
    const output = num(t, 'output');
    if (input === undefined || output === undefined) return;
    const cache = (t as Record<string, unknown>)['cache'];
    const cacheRead = num(cache, 'read') ?? 0;
    const acc: TokenUsage = this.tokens ?? { input: 0, cachedInput: 0, cacheWriteInput: 0, output: 0, reasoningOutput: 0 };
    acc.input += input + cacheRead;
    acc.cachedInput = (acc.cachedInput ?? 0) + cacheRead;
    acc.cacheWriteInput = (acc.cacheWriteInput ?? 0) + (num(cache, 'write') ?? 0);
    acc.output += output;
    acc.reasoningOutput = (acc.reasoningOutput ?? 0) + (num(t, 'reasoning') ?? 0);
    this.tokens = acc;
    const cost = num(part, 'cost');
    if (cost !== undefined) this.costUsd = (this.costUsd ?? 0) + cost;
    if (part['reason'] === 'stop') this.turns++;
  }

  usage(): Usage | undefined {
    const { tokens, costUsd, turns } = this;
    return tokens ? { tokens, ...(costUsd !== undefined ? { costUsd } : {}), turns, source: 'opencode' } : undefined;
  }
}

/**
 * The usage of an OpenCode log: every `step_finish` line of the whole log summed, stderr and
 * unparseable lines skipped, lines over `OPENCODE_USAGE_LINE_CAP` skipped unparsed. OpenCode reports
 * usage per step, not as a running total, so no step may be dropped. OpenCode's `tokens.input`
 * excludes cache reads (total = input + output + reasoning + cache.read), so cache reads are added to
 * `input` as for Claude. `cost` is summed into `costUsd`; `turns` counts the steps that ended with
 * `reason: "stop"`. No duration. Undefined when no `step_finish` carries input and output counts.
 * See specs/worker-runners "OpenCode usage parsing".
 */
export function parseOpenCodeUsage(text: string): Usage | undefined {
  const sum = new OpenCodeUsageSum();
  for (let start = 0; start <= text.length; ) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    // Measure before slicing, so a long tool-output line is never copied.
    if (end - start <= OPENCODE_USAGE_LINE_CAP) sum.add(text.slice(start, end));
    if (nl === -1) break;
    start = nl + 1;
  }
  return sum.usage();
}

/** `parseOpenCodeUsage` over a log file, streamed: memory stays bounded by the chunk size and the line cap. */
export async function readOpenCodeUsage(file: string): Promise<Usage | undefined> {
  const sum = new OpenCodeUsageSum();
  for await (const line of cappedLines(file, OPENCODE_USAGE_LINE_CAP)) sum.add(line);
  return sum.usage();
}

/** The lines of a file of at most `cap` bytes; a longer line is dropped while it streams past. */
async function* cappedLines(file: string, cap: number): AsyncGenerator<string> {
  let parts: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    for (let start = 0; ; ) {
      const nl = chunk.indexOf(10, start);
      const end = nl === -1 ? chunk.length : nl;
      if (!over && size + end - start > cap) {
        over = true;
        parts = [];
        size = 0;
      }
      if (!over && end > start) {
        parts.push(chunk.subarray(start, end));
        size += end - start;
      }
      if (nl === -1) break;
      if (!over) yield Buffer.concat(parts, size).toString('utf8');
      parts = [];
      size = 0;
      over = false;
      start = nl + 1;
    }
  }
  if (!over && size) yield Buffer.concat(parts, size).toString('utf8');
}
