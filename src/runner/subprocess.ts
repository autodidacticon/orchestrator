/**
 * Command-template runner: spawns the agent detached with stdio redirected to
 * per-launch log files so it survives the daemon. Used by the scripted test
 * agent and by the Claude Code and Codex runners.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { withoutStore } from '../runs/childEnv.js';
import type { Launch } from '../state/store.js';
import type { AgentRunner, Liveness, SpawnResult } from './runner.js';
import { fixedSlots, quoteRules, substitute } from './command.js';

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

/** The template substitution and the per-launch slots live in command.ts with the templates; re-exported for existing callers. */
export { fixedSlots, substitute } from './command.js';

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
        // Never the store's connection, for every runner kind. See specs/state-backend "No store URL in child environments".
        env: withoutStore(merged) as NodeJS.ProcessEnv,
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

  /** One wait for every launch's group. See specs/health-monitoring "Usage accounting: launches reaped together". */
  async reapAll(launches: readonly Launch[]): Promise<void> {
    const pids = launches.flatMap((l) => (l.pid ? [l.pid] : []));
    if (pids.length === 0) return;
    await killTrees(pids, this.opts.graceMs ?? 2000);
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

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * SIGTERM the process group (or process), wait for grace, then SIGKILL. For a group leader (a launch's
 * `/bin/sh`) the wait is for the whole group, so an agent that writes its usage while it is terminated has
 * written it when this returns. A pid that leads no group keeps the wait for that pid alone.
 * See specs/health-monitoring "Usage accounting".
 */
export async function killTree(pid: number, graceMs: number): Promise<void> {
  await killTrees([pid], graceMs);
}

/**
 * `killTree` for several pids at once: every target gets SIGTERM before any wait, all of them are waited for against
 * one deadline of `graceMs`, every target still present gets SIGKILL, and the wait after it is at most 1000 ms in
 * all. Each pid keeps `killTree`'s rules: a dead pid is skipped, a group leader is signalled and waited for as a
 * group, any other pid alone (SIGKILL also goes to its own group). A pid listed twice counts once. Never rejects.
 * See specs/health-monitoring "Usage accounting: launches reaped together".
 */
export async function killTrees(pids: readonly number[], graceMs: number): Promise<void> {
  try {
    const live = [...new Set(pids)].filter((pid) => pidAlive(pid));
    if (live.length === 0) return;
    const pgids = await Promise.all(live.map((pid) => pgidOf(pid)));
    const targets = live.map((pid, i) => {
      const pgid = pgids[i];
      const leader = pgid !== undefined && pgid === pid;
      return {
        pid,
        pgid,
        target: leader ? -pid : pid,
        gone: leader ? () => !groupAlive(pid) : () => !pidAlive(pid),
      };
    });
    for (const t of targets) signal(t.target, 'SIGTERM');
    const deadline = Date.now() + graceMs;
    let left = targets.filter((t) => !t.gone());
    while (left.length > 0 && Date.now() < deadline) {
      await sleep(50);
      left = left.filter((t) => !t.gone());
    }
    if (left.length === 0) return;
    for (const t of left) {
      signal(t.target, 'SIGKILL');
      if (t.pgid && t.pgid !== t.pid) signal(-t.pgid, 'SIGKILL');
    }
    for (let i = 0; i < 20 && left.some((t) => !t.gone()); i++) await sleep(50);
  } catch {
    /* killTrees never rejects; a target it could not signal is left as it is */
  }
}
