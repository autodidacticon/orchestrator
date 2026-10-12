/**
 * In-process fake runner for pure logic tests. Not a gate; the crash suite uses
 * real subprocesses. Tests drive agent behaviour through the orchestrator's
 * agent-call API directly.
 */
import type { Launch } from '../state/store.js';
import type { AgentRunner, SpawnResult } from './runner.js';

export class InprocRunner implements AgentRunner {
  readonly spawned: Launch[] = [];
  private readonly aliveSet = new Set<string>();
  private nextPid = 1000;

  async spawn(launch: Launch): Promise<SpawnResult> {
    this.spawned.push(launch);
    this.aliveSet.add(launch.launchId);
    return { pid: this.nextPid++ };
  }

  async alive(launch: Launch): Promise<boolean> {
    return this.aliveSet.has(launch.launchId);
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
