/**
 * Claude Code runner: headless `claude -p` in the launch worktree with the brief
 * on stdin and a per-launch MCP config pointing at the shim, which carries the
 * launch token in its environment.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Launch } from '../state/store.js';
import { logPath, SubprocessRunner, type SubprocessRunnerOptions } from './subprocess.js';
import type { SpawnResult, TokenUsage, Usage } from './runner.js';
import { shimCommand, shimEnv } from './shim-command.js';

export { DEFAULT_CLAUDE_COMMAND } from './command.js';
export { shimCommand } from './shim-command.js';

export interface ClaudeCodeRunnerOptions extends SubprocessRunnerOptions {
  retryWindowMs: number;
  shim?: { command: string; args: string[] };
}

export class ClaudeCodeRunner extends SubprocessRunner {
  constructor(private readonly ccOpts: ClaudeCodeRunnerOptions) {
    super(ccOpts);
  }

  async spawn(launch: Launch, env: Record<string, string>): Promise<SpawnResult> {
    const orchDir = path.join(launch.worktree, '.orchestrator');
    await mkdir(orchDir, { recursive: true });
    const shim = this.ccOpts.shim ?? shimCommand();
    const mcp = {
      mcpServers: {
        orchestrator: {
          command: shim.command,
          args: shim.args,
          env: shimEnv(launch, env, this.ccOpts.retryWindowMs),
        },
      },
    };
    // The file carries the launch token; mode applies only on create, so chmod covers a rewrite. See specs/agent-protocol "Launch token scoping".
    const mcpPath = path.join(orchDir, 'mcp.json');
    await writeFile(mcpPath, JSON.stringify(mcp, null, 2), { encoding: 'utf8', mode: 0o600 });
    await chmod(mcpPath, 0o600);
    // Do not inherit a parent Claude Code session's marker; the agent is its own session.
    return super.spawn(launch, { ...env, CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' });
  }

  /** `claude -p --output-format json` prints one JSON object at the end of its output. See specs/health-monitoring "Usage accounting". */
  async readUsage(launch: Launch): Promise<Usage | undefined> {
    const text = await readFile(logPath(this.ccOpts.logDir, launch.launchId), 'utf8').catch(() => '');
    return parseUsage(text);
  }
}

/**
 * The last JSON object in a log that carries cost or turn counts; undefined when there is none.
 * Candidates are tried in two passes, each from the end and each at most PARSE_TRIES times: first every `{`
 * that starts a line (so a one-line result object is found at once, whatever it holds), then every `{`.
 * See specs/health-monitoring "Usage accounting".
 */
export function parseUsage(text: string): Usage | undefined {
  const tail = text.length > 256 * 1024 ? text.slice(text.length - 256 * 1024) : text;
  const lineStart = (i: number) => i === 0 || tail[i - 1] === '\n';
  for (const pass of [lineStart, () => true]) {
    let attempts = 0;
    for (let i = tail.lastIndexOf('{'); i >= 0 && attempts < PARSE_TRIES; i = i > 0 ? tail.lastIndexOf('{', i - 1) : -1) {
      if (!pass(i)) continue;
      attempts++;
      const usage = usageAt(tail, i);
      if (usage) return usage;
    }
  }
  return undefined;
}

const PARSE_TRIES = 200;

function usageAt(tail: string, i: number): Usage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tail.slice(i).trim());
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const o = parsed as Record<string, unknown>;
  const num = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : undefined);
  const costUsd = num('total_cost_usd');
  const durationMs = num('duration_ms');
  const turns = num('num_turns');
  if (costUsd === undefined && durationMs === undefined && turns === undefined) return undefined;
  return { costUsd, turns, durationMs, tokens: parseTokens(o['usage']), source: 'claude-code' };
}

/**
 * Claude's `usage` object as runner-neutral tokens. Claude's `input_tokens` excludes cache reads and
 * cache writes, so cache reads are added to `input` (the pricing formula treats `cachedInput` as part
 * of `input`) and cache writes stay apart. See specs/health-monitoring "Run cost budget".
 */
function parseTokens(v: unknown): TokenUsage | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const u = v as Record<string, unknown>;
  const num = (k: string) => (typeof u[k] === 'number' && Number.isFinite(u[k]) && (u[k] as number) >= 0 ? (u[k] as number) : undefined);
  const input = num('input_tokens');
  const output = num('output_tokens');
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = num('cache_read_input_tokens');
  const cacheWrite = num('cache_creation_input_tokens');
  const tokens: TokenUsage = { input: input + (cacheRead ?? 0), output };
  if (cacheRead !== undefined) tokens.cachedInput = cacheRead;
  if (cacheWrite !== undefined) tokens.cacheWriteInput = cacheWrite;
  return tokens;
}
