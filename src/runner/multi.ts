/**
 * MultiRunner: one AgentRunner per runner kind behind the daemon's single runner slot.
 * Every call routes by the kind fixed on the launch row at preparation, so a launch observed
 * after a restart still reaches the runner (and the usage parser) it was spawned with.
 * See specs/worker-runners "Runner dispatch by launch kind".
 */
import { type Launch, runnerOf } from '../state/store.js';
import type { AgentRunner, Liveness, SpawnResult, Usage } from './runner.js';
import type { RunnerKind } from './selection.js';

export class MultiRunner implements AgentRunner {
  constructor(readonly runners: Partial<Record<RunnerKind, AgentRunner>>) {}

  private runnerFor(launch: Launch): AgentRunner | undefined {
    return this.runners[runnerOf(launch)];
  }

  private require(launch: Launch): AgentRunner {
    const r = this.runnerFor(launch);
    if (!r) throw new Error(`no runner is registered for kind ${runnerOf(launch)} (launch ${launch.launchId} of ${launch.taskId})`);
    return r;
  }

  async spawn(launch: Launch, env: Record<string, string>): Promise<SpawnResult> {
    return this.require(launch).spawn(launch, env);
  }

  async alive(launch: Launch): Promise<boolean> {
    return (await this.runnerFor(launch)?.alive(launch)) ?? false;
  }

  /** A kind with no runner cannot be observed: unknown, so health leaves the lease to decide. */
  async liveness(launch: Launch): Promise<Liveness> {
    return (await this.runnerFor(launch)?.liveness(launch)) ?? 'unknown';
  }

  async reap(launch: Launch): Promise<void> {
    await this.runnerFor(launch)?.reap(launch);
  }

  /** Only the id is known here, so every registered runner is asked; each kill is idempotent. */
  async killByLaunchId(launchId: string): Promise<void> {
    await Promise.all(Object.values(this.runners).map((r) => r?.killByLaunchId(launchId)));
  }

  async readUsage(launch: Launch): Promise<Usage | undefined> {
    return this.runnerFor(launch)?.readUsage?.(launch);
  }
}
