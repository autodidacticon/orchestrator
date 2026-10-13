/**
 * In-process fake runner for pure logic tests. Not a gate; the crash suite uses
 * real subprocesses. Tests drive agent behaviour through the orchestrator's
 * agent-call API directly.
 */
import type { Launch } from '../state/store.js';
import type { AgentRunner, Liveness, SpawnResult, Usage } from './runner.js';

export class InprocRunner implements AgentRunner {
  readonly spawned: Launch[] = [];
  private readonly aliveSet = new Set<string>();
  private nextPid = 1000;
  /** Test script: report `unknown` liveness for these launch ids (or all, when `unknownForAll`). */
  readonly unknownLiveness = new Set<string>();
  unknownForAll = false;
  /** Test script: usage returned for a launch id or a task id. */
  readonly usageScript = new Map<string, Usage>();

  async spawn(launch: Launch): Promise<SpawnResult> {
    this.spawned.push(launch);
    this.aliveSet.add(launch.launchId);
    return { pid: this.nextPid++ };
  }

  async alive(launch: Launch): Promise<boolean> {
    return this.aliveSet.has(launch.launchId);
  }

  async liveness(launch: Launch): Promise<Liveness> {
    if (this.unknownForAll || this.unknownLiveness.has(launch.launchId)) return 'unknown';
    return this.aliveSet.has(launch.launchId) ? 'alive' : 'dead';
  }

  async readUsage(launch: Launch): Promise<Usage | undefined> {
    return this.usageScript.get(launch.launchId) ?? this.usageScript.get(launch.taskId);
  }

  async reap(launch: Launch): Promise<void> {
    this.aliveSet.delete(launch.launchId);
  }

  async killByLaunchId(launchId: string): Promise<void> {
    this.aliveSet.delete(launchId);
  }

  /** Test helper: simulate the agent process dying. */
  die(launchId: string): void {
    this.aliveSet.delete(launchId);
  }

  isAlive(launchId: string): boolean {
    return this.aliveSet.has(launchId);
  }

  liveLaunchIds(): string[] {
    return [...this.aliveSet];
  }
}
