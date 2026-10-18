import type { Id } from '../graph/model.js';
import type { Launch } from '../state/store.js';
import type { BriefInput, FallbackReport, SealOptions, SealResult, Workspace } from './workspace.js';

/** In-memory workspace for logic tests. Scriptable seal results and fallback files. */
export class FakeWorkspace implements Workspace {
  head = 'head0';
  readonly worktrees = new Set<string>();
  readonly briefs = new Map<string, BriefInput>();
  readonly tags: Array<{ id: Id; version: number; sha: string }> = [];
  readonly sealScript = new Map<Id, SealResult>();
  readonly fallbacks = new Map<string, FallbackReport>();
  /** Scripted fingerprints by launch id; default: the head with a clean tree. */
  readonly fingerprints = new Map<string, string>();
  /** Launches with uncommitted changes, which `preserve` turns into a synthetic WIP commit. */
  readonly dirty = new Set<string>();
  /** Commits made by `seal` with `autoCommit`. */
  readonly autoCommits: Array<{ launchId: string; sha: string; message: string }> = [];
  private counter = 0;

  async integrationHead(): Promise<string> {
    return this.head;
  }

  async prepare(launch: Launch, brief: BriefInput): Promise<void> {
    this.worktrees.add(launch.launchId);
    this.briefs.set(launch.launchId, brief);
  }

  async seal(launch: Launch, opts: SealOptions = {}): Promise<SealResult> {
    if (opts.autoCommit && this.dirty.has(launch.launchId)) {
      // The daemon commit policy: the uncommitted changes become a synthetic orchestrator commit.
      this.dirty.delete(launch.launchId);
      const sealedSha = `auto-${launch.launchId.slice(0, 8)}`;
      this.autoCommits.push({ launchId: launch.launchId, sha: sealedSha, message: opts.autoCommit.message });
      this.fingerprints.set(launch.launchId, `${sealedSha}:clean`);
      return { ok: true, sealedSha, committed: true };
    }
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

  async fingerprint(launch: Launch): Promise<string> {
    return this.fingerprints.get(launch.launchId) ?? `${this.head}:clean`;
  }

  async exists(launch: Launch): Promise<boolean> {
    return this.worktrees.has(launch.launchId);
  }

  async preserve(launch: Launch): Promise<{ headSha: string; wipCommit?: string }> {
    const head = (this.fingerprints.get(launch.launchId) ?? `${this.head}:clean`).split(':')[0] ?? this.head;
    if (!this.dirty.has(launch.launchId)) return { headSha: head };
    this.dirty.delete(launch.launchId);
    const wipCommit = `wip-${launch.launchId.slice(0, 8)}`;
    this.fingerprints.set(launch.launchId, `${wipCommit}:clean`);
    return { headSha: wipCommit, wipCommit };
  }

  /** Test helper: the worker touched the tree (a commit at `head`, plus uncommitted changes when `uncommitted`). */
  markProgress(launchId: string, head = 'wip-head', uncommitted = false): void {
    this.fingerprints.set(launchId, `${head}:${uncommitted ? 'dirty' : 'clean'}`);
    if (uncommitted) this.dirty.add(launchId);
  }

  /** Test helper: a submission that is empty (sealedSha == baseSha). */
  scriptEmpty(taskId: Id, baseSha: string): void {
    this.sealScript.set(taskId, { ok: true, sealedSha: baseSha });
  }
}
