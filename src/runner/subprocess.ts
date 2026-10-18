/**
 * Command-template runner: spawns the agent detached with stdio redirected to
 * per-launch log files so it survives the daemon. Used by the scripted test
 * agent and by the Claude Code and Codex runners.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Launch } from '../state/store.js';
import type { AgentRunner, Liveness, SpawnResult } from './runner.js';
import { quoteRules } from './command.js';

const execFileP = promisify(execFile);

export interface SubprocessRunnerOptions {
  /** Shell command, or a getter read at every spawn; {brief}, {briefJson}, {worktree}, {launchId}, {taskId}, {mcpConfig}, {allowedTools}, {model}, and {effort} are substituted. A runner with its own slots composes the whole command through `compose`. */
  command: string | (() => string);
  /** The allow list filled into {allowedTools}, read at every spawn. See specs/toolchain-discovery "Runner command composition". */
  allowedTools?: () => string[];
  logDir: string;
  /** Grace period between SIGTERM and SIGKILL. */
  graceMs?: number;
  extraEnv?: Record<string, string>;
  /** Composes the whole command for a launch in place of the template substitution (the Codex runner's `composeCodexCommand`). */
  compose?: (launch: Launch) => string;
}

export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? (vars[k] as string) : m));
}

/** The slots every template gets from the launch alone: paths under `.orchestrator/`, ids, model, and effort. */
export function fixedSlots(launch: Pick<Launch, 'worktree' | 'launchId' | 'taskId' | 'model' | 'effort'>): Record<string, string> {
  const orchDir = path.join(launch.worktree, '.orchestrator');
  return {
    brief: path.join(orchDir, 'brief.md'),
    briefJson: path.join(orchDir, 'brief.json'),
    worktree: launch.worktree,
    launchId: launch.launchId,
    taskId: launch.taskId,
    mcpConfig: path.join(orchDir, 'mcp.json'),
    // Fixed on the launch at preparation; validated as safe tokens before they got there. See specs/model-selection.
    model: launch.model ?? '',
    effort: launch.effort ?? '',
  };
}

export function logPath(logDir: string, launchId: string): string {
  return path.join(logDir, `${launchId}.log`);
}

export class SubprocessRunner implements AgentRunner {
  constructor(private readonly opts: SubprocessRunnerOptions) {}

  async spawn(launch: Launch, env: Record<string, string>): Promise<SpawnResult> {
    await mkdir(this.opts.logDir, { recursive: true });
    const template = typeof this.opts.command === 'function' ? this.opts.command() : this.opts.command;
    const cmd =
      this.opts.compose?.(launch) ??
      substitute(template, {
        ...fixedSlots(launch),
        allowedTools: quoteRules(this.opts.allowedTools?.() ?? []),
      });
    const log = await open(logPath(this.opts.logDir, launch.launchId), 'a');
    try {
      // An empty value in env/extraEnv removes the variable (e.g. a parent session's CLAUDECODE marker).
      const merged: Record<string, string | undefined> = { ...process.env, ...this.opts.extraEnv, ...env, ORCH_LOG: logPath(this.opts.logDir, launch.launchId) };
      for (const k of Object.keys(merged)) if (merged[k] === '') delete merged[k];
      const child = spawn('/bin/sh', ['-c', `${cmd}\n# orch-launch:${launch.launchId}`], {
        cwd: launch.worktree,
        env: merged as NodeJS.ProcessEnv,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
      });
      child.unref();
      if (child.pid === undefined) throw new Error('spawn returned no pid');
      return { pid: child.pid };
    } finally {
      await log.close();
    }
  }

  async alive(launch: Launch): Promise<boolean> {
    if (!launch.pid) return false;
    return pidAlive(launch.pid);
  }

  async liveness(launch: Launch): Promise<Liveness> {
    return (await this.alive(launch)) ? 'alive' : 'dead';
  }

  async reap(launch: Launch): Promise<void> {
    if (!launch.pid) return;
    await killTree(launch.pid, this.opts.graceMs ?? 2000);
  }

  async killByLaunchId(launchId: string): Promise<void> {
    const pids = await pgrep(launchId);
    await Promise.all(pids.map((p) => killTree(p, this.opts.graceMs ?? 2000)));
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function pgrep(pattern: string): Promise<number[]> {
  try {
    const { stdout } = await execFileP('pgrep', ['-f', pattern]);
    return stdout
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}

async function pgidOf(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileP('ps', ['-o', 'pgid=', '-p', String(pid)]);
    const n = Number(stdout.trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}

/** SIGTERM the process group (or process), wait for grace, then SIGKILL. */
export async function killTree(pid: number, graceMs: number): Promise<void> {
  if (!pidAlive(pid)) return;
  const pgid = await pgidOf(pid);
  const target = pgid && pgid === pid ? -pgid : pid;
  signal(target, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  signal(target, 'SIGKILL');
  if (pgid && pgid !== pid) signal(-pgid, 'SIGKILL');
  for (let i = 0; i < 20 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
}
