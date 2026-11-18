/**
 * The workspace of a remote launch: the worker clones and works elsewhere, so the daemon holds no worktree for it.
 * Preparing, removing, fingerprinting and the existence check are no-ops that never touch the filesystem; the calls
 * that need a tree refuse. See specs/remote-workspace.
 */
import type { Id } from '../graph/model.js';
import { accessOf, type Launch } from '../state/store.js';
import { type Origin, OriginConfigError, OriginFetchError } from './origin.js';
import type { BriefInput, FallbackReport, PreserveOptions, RemoveOptions, SealOptions, SealResult, TagPushResult, Workspace } from './workspace.js';

/** The error a tree-bound call raises for a remote launch. */
export function noWorktreeError(launch: Launch): Error {
  return new Error(`remote launch has no worktree: ${launch.launchId} (${launch.taskId})`);
}

export class RemoteWorkspace implements Workspace {
  /** `origin`: the daemon's remote, through which a remote submit is sealed. Without it a seal refuses. */
  constructor(private readonly origin?: Origin) {}

  /** The integration branch belongs to the daemon's own workspace, never to a remote launch. */
  async integrationHead(): Promise<string> {
    throw new Error('the remote workspace holds no integration branch; ask the daemon workspace');
  }

  /** The brief lives on the launch row (`briefMarkdown`, `briefJson`), composed by prepareLaunch. */
  async prepare(_launch: Launch, _brief: BriefInput): Promise<void> {}

  /**
   * Seal a remote submit: fetch the launch branch from origin into the daemon's clone and compare its tip with the
   * `sealedSha` the worker reported. There is no tree to inspect or commit, so `autoCommit` does not apply. Without a
   * `sealedSha` or an origin there is nothing to seal against, and the call rejects as a tree-bound call does.
   * See specs/remote-workspace "Seal".
   */
  async seal(launch: Launch, opts: SealOptions = {}): Promise<SealResult> {
    const expected = opts.sealedSha;
    if (expected === undefined || !this.origin) throw noWorktreeError(launch);
    const branch = launch.branch;
    let actual: string | undefined;
    try {
      actual = await this.origin.fetchBranch(branch);
    } catch (err) {
      // A remote that is not configured cannot be fetched either; like an unreachable one, nothing is recorded.
      if (err instanceof OriginConfigError) return { ok: false, reason: 'originUnreachable', branch, message: err.message };
      if (!(err instanceof OriginFetchError)) throw err;
      return { ok: false, reason: err.kind === 'refused' ? 'originRefused' : 'originUnreachable', branch, message: err.message };
    }
    if (actual === undefined) return { ok: false, reason: 'branchNotPushed', branch };
    if (actual !== expected) return { ok: false, reason: 'shaMismatch', branch, expected, actual };
    return { ok: true, sealedSha: actual };
  }

  async readFallback(launch: Launch): Promise<FallbackReport | undefined> {
    throw noWorktreeError(launch);
  }

  async remove(_launch: Launch, _opts?: RemoveOptions): Promise<boolean> {
    return true;
  }

  async listWorktrees(): Promise<string[]> {
    return [];
  }

  async tagMilestone(_id: Id, _version: number, _sha: string): Promise<TagPushResult | void> {
    throw new Error('the remote workspace holds no integration branch; ask the daemon workspace');
  }

  async diffStat(): Promise<string> {
    return '';
  }

  /** Constant for the life of the launch: the daemon cannot see a remote tree, so only the worker's calls show progress. */
  async fingerprint(launch: Launch): Promise<string> {
    return `${launch.baseSha}:remote`;
  }

  /** Always true: nothing on this host can be lost, so recovery leaves a parked remote launch as it is. */
  async exists(_launch: Launch): Promise<boolean> {
    return true;
  }

  async preserve(launch: Launch, _opts?: PreserveOptions): Promise<{ headSha: string; wipCommit?: string }> {
    throw noWorktreeError(launch);
  }
}

/** The workspace calls that act on one launch, routed by its access. */
export const LAUNCH_METHODS = ['prepare', 'seal', 'readFallback', 'remove', 'fingerprint', 'exists', 'preserve'] as const satisfies ReadonlyArray<keyof Workspace>;

/**
 * The daemon's workspace as the loop sees it: integration-side calls go to `local` (the git workspace of the clone),
 * launch-side calls to the workspace chosen by the launch's `access`. A proxy over `local`, so its own type and fields
 * (a GitWorkspace's `repo`, a test's fake) stay visible. See specs/remote-workspace "Workspace by access".
 */
export function workspaceByAccess<W extends Workspace>(local: W, remote: Workspace = new RemoteWorkspace()): W {
  const routed = new Map<PropertyKey, (launch: Launch, ...rest: unknown[]) => unknown>(
    LAUNCH_METHODS.map((m) => [
      m,
      (launch: Launch, ...rest: unknown[]) => {
        const ws = accessOf(launch) === 'remote' ? remote : local;
        return (ws[m] as (...a: unknown[]) => unknown).call(ws, launch, ...rest);
      },
    ]),
  );
  // A routed method assigned through the proxy (a test wrapping `remove`) sits above the routing, so the original it
  // bound before still routes rather than calling the wrapper again.
  const assigned = new Map<PropertyKey, unknown>();
  return new Proxy(local, {
    get(target, prop, receiver) {
      if (assigned.has(prop)) return assigned.get(prop);
      return routed.get(prop) ?? Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      if (!routed.has(prop)) return Reflect.set(target, prop, value, receiver);
      assigned.set(prop, value);
      return true;
    },
  });
}
