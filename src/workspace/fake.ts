import type { Id } from '../graph/model.js';
import type { Launch } from '../state/store.js';
import type { BriefInput, FallbackReport, SealResult, Workspace } from './workspace.js';

/** In-memory workspace for logic tests. Scriptable seal results and fallback files. */
export class FakeWorkspace implements Workspace {
  head = 'head0';
  readonly worktrees = new Set<string>();
  readonly briefs = new Map<string, BriefInput>();
  readonly tags: Array<{ id: Id; version: number; sha: string }> = [];
  readonly sealScript = new Map<Id, SealResult>();
  readonly fallbacks = new Map<string, FallbackReport>();
  private counter = 0;

  async integrationHead(): Promise<string> {
    return this.head;
  }

  async prepare(launch: Launch, brief: BriefInput): Promise<void> {
    this.worktrees.add(launch.launchId);
    this.briefs.set(launch.launchId, brief);
  }

  async seal(launch: Launch): Promise<SealResult> {
    const scripted = this.sealScript.get(launch.taskId);
    if (scripted) return scripted;
    return { ok: true, sealedSha: `sha-${launch.taskId}-${++this.counter}` };
  }

  async readFallback(launch: Launch): Promise<FallbackReport | undefined> {
    const f = this.fallbacks.get(launch.launchId);
    this.fallbacks.delete(launch.launchId);
    return f;
  }

  async remove(launch: Launch): Promise<void> {
    this.worktrees.delete(launch.launchId);
  }

  async listWorktrees(): Promise<string[]> {
    return [...this.worktrees];
  }

  async tagMilestone(id: Id, version: number, sha: string): Promise<void> {
    if (!this.tags.some((t) => t.id === id && t.version === version)) this.tags.push({ id, version, sha });
  }

  async diffStat(from: string, to: string): Promise<string> {
    return `fake diff ${from}..${to}`;
  }

  /** Test helper: a submission that is empty (sealedSha == baseSha). */
  scriptEmpty(taskId: Id, baseSha: string): void {
    this.sealScript.set(taskId, { ok: true, sealedSha: baseSha });
  }
}
