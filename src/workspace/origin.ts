/**
 * The integration branch's remote: the source of truth when `git.pushIntegration` is on.
 * See specs/integration-pipeline "Origin as source of truth".
 *
 * One instance is shared by the workspace and the verifier backend, so every fetch and push of the
 * daemon runs one at a time and none races another for the remote-tracking ref's lock.
 */
import { git, revParse } from './git.js';

export interface OriginOptions {
  /** The daemon's clone. */
  repo: string;
  integrationBranch: string;
  /** The remote's name in the clone. */
  remote?: string;
  /** When set, the remote is added or re-pointed to this URL before first use. */
  url?: string;
  /** `integrationHead` fetches at most this often; 0 fetches on every call. The verifier always fetches. */
  fetchIntervalMs?: number;
  now?: () => number;
}

/** Thrown when origin already holds a tag under the same name at another sha. The tag is never moved. */
export class TagConflictError extends Error {
  constructor(
    public readonly tag: string,
    public readonly remoteSha: string,
    public readonly sha: string,
  ) {
    super(`tag ${tag} exists on origin at ${remoteSha}, not ${sha}; it is never moved`);
    this.name = 'TagConflictError';
  }
}

/** The remote is not configured: a setting is missing, not a transient failure. */
export class OriginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OriginConfigError';
  }
}

/** How the clone's integration branch relates to origin's. */
export type Relation = 'equal' | 'behind' | 'ahead' | 'diverged' | 'noRemoteBranch';

export class Origin {
  readonly remote: string;
  private ensured: Promise<void> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private lastFetchAt = Number.NEGATIVE_INFINITY;
  /** The squash the verifier swapped into the clone and is pushing; not published until the push lands. */
  inFlight: string | undefined;

  constructor(private readonly opts: OriginOptions) {
    this.remote = opts.remote ?? 'origin';
  }

  get repo(): string {
    return this.opts.repo;
  }

  get localRef(): string {
    return `refs/heads/${this.opts.integrationBranch}`;
  }

  /** The remote-tracking ref the daemon reads origin's head from. */
  get trackingRef(): string {
    return `refs/remotes/${this.remote}/${this.opts.integrationBranch}`;
  }

  /** Run remote operations one at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private ensure(): Promise<void> {
    this.ensured ??= (async () => {
      const current = await git(this.repo, ['remote', 'get-url', this.remote], { allowFail: true });
      if (this.opts.url) {
        if (current.code !== 0) await git(this.repo, ['remote', 'add', this.remote, this.opts.url]);
        else if (current.stdout.trim() !== this.opts.url) await git(this.repo, ['remote', 'set-url', this.remote, this.opts.url]);
      } else if (current.code !== 0) {
        throw new OriginConfigError(`git.pushIntegration is on but the clone has no remote "${this.remote}" and git.originUrl is not set`);
      }
    })().catch((err) => {
      this.ensured = undefined;
      throw err;
    });
    return this.ensured;
  }

  /** Fetch origin's integration branch into the tracking ref. Throws when origin cannot be reached. */
  fetch(): Promise<void> {
    return this.serial(() => this.fetchNow());
  }

  private async fetchNow(): Promise<void> {
    await this.ensure();
    const b = this.opts.integrationBranch;
    const r = await git(this.repo, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', this.remote, `+refs/heads/${b}:${this.trackingRef}`], { allowFail: true });
    if (r.code !== 0) {
      if (/couldn't find remote ref/i.test(r.stderr)) {
        // An empty origin: no branch yet. The first publication creates it.
        await git(this.repo, ['update-ref', '-d', this.trackingRef], { allowFail: true });
      } else {
        throw new Error(`git fetch ${this.remote} failed: ${r.stderr.trim() || r.stdout.trim()}`);
      }
    }
    this.lastFetchAt = this.now();
  }

  /** Fetch unless one ran within `fetchIntervalMs`; a failed fetch keeps the last observed head. */
  async maybeFetch(): Promise<void> {
    if (this.now() - this.lastFetchAt < (this.opts.fetchIntervalMs ?? 0)) return;
    try {
      await this.fetch();
    } catch {
      // The tracking ref keeps the last head origin was seen at; an unreachable origin is tried again after the interval.
      this.lastFetchAt = this.now();
    }
  }

  /** Origin's head as last fetched, or undefined when origin has no integration branch. */
  async head(): Promise<string | undefined> {
    const r = await git(this.repo, ['rev-parse', '--verify', '--quiet', `${this.trackingRef}^{commit}`], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  async localHead(): Promise<string> {
    return revParse(this.repo, this.localRef);
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    return (await git(this.repo, ['merge-base', '--is-ancestor', a, b], { allowFail: true })).code === 0;
  }

  async relation(local: string, remote: string | undefined): Promise<Relation> {
    if (remote === undefined) return 'noRemoteBranch';
    if (local === remote) return 'equal';
    if (await this.isAncestor(local, remote)) return 'behind';
    if (await this.isAncestor(remote, local)) return 'ahead';
    return 'diverged';
  }

  /**
   * Push `sha` to origin's integration branch with a lease on `expected` (undefined: the branch must not exist).
   * True when origin now holds `sha`; false when the lease failed or origin refused or could not be reached.
   * On success the tracking ref is moved to `sha`, so base selection sees the publication at once.
   */
  pushBranch(sha: string, expected: string | undefined): Promise<boolean> {
    return this.serial(async () => {
      await this.ensure();
      const ref = `refs/heads/${this.opts.integrationBranch}`;
      const r = await git(this.repo, ['push', '--quiet', '--no-verify', `--force-with-lease=${ref}:${expected ?? ''}`, this.remote, `${sha}:${ref}`], { allowFail: true });
      if (r.code !== 0) return false;
      await git(this.repo, ['update-ref', this.trackingRef, sha]);
      return true;
    });
  }

  /** Push a tag without force. Pushing a tag origin already holds at the same sha is a no-op. */
  pushTag(name: string, sha: string): Promise<void> {
    return this.serial(async () => {
      await this.ensure();
      const ref = `refs/tags/${name}`;
      const r = await git(this.repo, ['push', '--quiet', '--no-verify', this.remote, `${ref}:${ref}`], { allowFail: true });
      if (r.code === 0) return;
      const remote = await git(this.repo, ['ls-remote', this.remote, ref], { allowFail: true });
      const remoteSha = remote.code === 0 ? remote.stdout.trim().split(/\s+/)[0] : undefined;
      if (remoteSha && remoteSha === sha) return;
      if (remoteSha) throw new TagConflictError(name, remoteSha, sha);
      throw new Error(`git push ${this.remote} ${ref} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    });
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
}
