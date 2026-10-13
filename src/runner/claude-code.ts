/**
 * Claude Code runner: headless `claude -p` in the launch worktree with the brief
 * on stdin and a per-launch MCP config pointing at the shim, which carries the
 * launch token in its environment.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Launch } from '../state/store.js';
import { logPath, SubprocessRunner, type SubprocessRunnerOptions } from './subprocess.js';
import type { SpawnResult, Usage } from './runner.js';

export const DEFAULT_CLAUDE_COMMAND =
  'claude -p --output-format json --mcp-config {mcpConfig} --strict-mcp-config --permission-mode acceptEdits --allowedTools "Bash(git:*)" "mcp__orchestrator__heartbeat" "mcp__orchestrator__report" "mcp__orchestrator__block" "mcp__orchestrator__inbox" "mcp__orchestrator__log" --no-session-persistence < {brief}';

/** The shim entrypoint: the built .js next to this file if present, else the .ts via tsx. */
export function shimCommand(): { command: string; args: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.resolve(here, '../agent/mcp-shim.js');
  if (existsSync(js)) return { command: 'node', args: [js] };
  const ts = path.resolve(here, '../agent/mcp-shim.ts');
  const loader = path.resolve(here, '../../node_modules/tsx/dist/loader.mjs');
  return { command: 'node', args: ['--import', loader, ts] };
}

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
          env: {
            ORCH_API: env['ORCH_API'] ?? '',
            ORCH_LAUNCH_ID: launch.launchId,
            ORCH_TOKEN: launch.token,
            ORCH_RETRY_WINDOW_MS: String(this.ccOpts.retryWindowMs),
          },
        },
      },
    };
    await writeFile(path.join(orchDir, 'mcp.json'), JSON.stringify(mcp, null, 2), 'utf8');
    // Do not inherit a parent Claude Code session's marker; the agent is its own session.
    return super.spawn(launch, { ...env, CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' });
  }

  /** `claude -p --output-format json` prints one JSON object at the end of its output. See specs/health-monitoring "Usage accounting". */
  async readUsage(launch: Launch): Promise<Usage | undefined> {
    const text = await readFile(logPath(this.ccOpts.logDir, launch.launchId), 'utf8').catch(() => '');
    return parseUsage(text);
  }
}

/** The last JSON object in a log that carries cost or turn counts; undefined when there is none. */
export function parseUsage(text: string): Usage | undefined {
  const tail = text.length > 256 * 1024 ? text.slice(text.length - 256 * 1024) : text;
  let attempts = 0;
  for (let i = tail.lastIndexOf('{'); i >= 0 && attempts < 200; i = tail.lastIndexOf('{', i - 1)) {
    attempts++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(tail.slice(i).trim());
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const o = parsed as Record<string, unknown>;
    const num = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : undefined);
    const costUsd = num('total_cost_usd');
    const durationMs = num('duration_ms');
    const turns = num('num_turns');
    if (costUsd === undefined && durationMs === undefined && turns === undefined) continue;
    return { costUsd, turns, durationMs };
  }
  return undefined;
}
