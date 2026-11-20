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
  /** Every command that talks to the remote is killed after this long; 0 or unset never kills. */
  remoteTimeoutMs?: number;
  /** How long a call on the tick's path (base selection, the tag push) waits for its own remote command before going on without it. */
  tickWaitMs?: number;
  now?: () => number;
}

/** The default bound on a tick's wait for a remote command it started; the command itself runs on. */
export const DEFAULT_TICK_WAIT_MS = 1000;

/** Wait for `p` at most `ms`: its outcome if it settles in time, else `undefined` (and its later rejection is swallowed). */
async function within<T>(p: Promise<T>, ms: number): Promise<{ value: T } | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)));
  const settled = p.then((value) => ({ value }));
  // A rejection after the wait ended is the command's own business: never an unhandled rejection.
  settled.catch(() => undefined);
  try {
    return await Promise.race([settled, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How a push of the integration branch ended. `lease`: origin moved since the expected head (retry at once on the new
 * head). `refused`: origin answered and declined (a hook, a protected branch, missing permission): counted, and the
 * task is blocked once the limit is reached. `unreachable`: origin did not answer or the command timed out; retried
 * with backoff and never counted. See specs/integration-pipeline "Push failures are classified".
 */
export type PushResult = { ok: true } | { ok: false; kind: 'lease' | 'refused' | 'unreachable'; message: string };

/** Classify a failed push from git's stderr (read under LC_ALL=C). */
export function classifyPushFailure(stderr: string, timedOut = false): 'lease' | 'refused' | 'unreachable' {
  if (timedOut) return 'unreachable';
  if (/\(stale info\)/.test(stderr)) return 'lease';
  if (/\[remote rejected\]|\[rejected\]|Authentication failed|Permission denied|access denied|denied to|returned error: 40[13]/i.test(stderr)) return 'refused';
  return 'unreachable';
}

/**
 * Classify a failed fetch from git's stderr (read under LC_ALL=C). `refused`: origin answered and declined the
 * credentials or the access (an expired or revoked credential, a missing permission): counted against
 * `git.pushRefusalLimit` like a refused push. Anything else, a timeout included, is `unreachable`.
 * See specs/integration-pipeline "Fetch failures are classified".
 */
export function classifyFetchFailure(stderr: string, timedOut = false): 'refused' | 'unreachable' {
  if (timedOut) return 'unreachable';
  if (/Authentication failed|Permission denied|access denied|denied to|returned error: 40[13]|could not read (Username|Password)|terminal prompts disabled|Invalid username or password/i.test(stderr)) return 'refused';
  return 'unreachable';
}

/** A fetch that failed, with how: origin refused the credentials or access, or could not be reached in time. */
/** The only refs `deleteRef` deletes: the verify refs of remote verification. See specs/verifier-pool "Verify ref: deletion". */
export const VERIFY_REF_PREFIX = 'refs/verify/';

export class OriginFetchError extends Error {
  constructor(
    message: string,
    public readonly kind: 'refused' | 'unreachable',
  ) {
    super(message);
    this.name = 'OriginFetchError';
  }
}

/** Environment for remote commands: messages in English, so failures can be classified. */
const REMOTE_ENV = { LC_ALL: 'C' };

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

interface TipRead {
  done: Promise<string | undefined>;
  /** The lease expiry the read was started for (`lease.expiresAt`); a read for another one is not used. */
  tag?: number;
  outcome?: { tip: string | undefined } | { error: unknown };
}

interface TagPush {
  sha: string;
  done: Promise<void>;
  outcome?: 'pushed' | 'failed';
}

/** How the clone's integration branch relates to origin's. */
export type Relation = 'equal' | 'behind' | 'ahead' | 'diverged' | 'noRemoteBranch';

export class Origin {
  readonly remote: string;
  private ensured: Promise<void> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  /** Remote operations queued or running on the chain. */
  private pending = 0;
  private lastFetchAt = Number.NEGATIVE_INFINITY;
  /** The squash the verifier swapped into the clone and is pushing; not published until the push lands. */
  inFlight: string | undefined;
  /** Tag pushes started from the tick, by tag name, with their outcome once settled. */
  private readonly tagPushes = new Map<string, TagPush>();
  /** Branch tip reads started from the tick, by branch, with their outcome once settled. */
  private readonly tipReads = new Map<string, TipRead>();

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
    this.pending++;
    const run = () => fn().finally(() => this.pending--);
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * True while a remote operation is queued or running. The tick never waits behind one: base selection keeps the
   * last fetched head and a tag push waits for a later tick. See specs/integration-pipeline "Remote commands are bounded".
   */
  get busy(): boolean {
    return this.pending > 0;
  }

  private remoteGit(args: string[]) {
    return git(this.repo, args, { allowFail: true, env: REMOTE_ENV, timeoutMs: this.opts.remoteTimeoutMs });
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

  /** Fetch origin's integration branch into the tracking ref. Throws `OriginFetchError` (refused or unreachable) when the fetch fails. */
  fetch(): Promise<void> {
    return this.serial(() => this.fetchNow());
  }

  private async fetchNow(): Promise<void> {
    await this.ensure();
    const b = this.opts.integrationBranch;
    const r = await this.remoteGit(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', this.remote, `+refs/heads/${b}:${this.trackingRef}`]);
    if (r.code !== 0) {
      if (!r.timedOut && /couldn't find remote ref/i.test(r.stderr)) {
        // An empty origin: no branch yet. The first publication creates it.
        await git(this.repo, ['update-ref', '-d', this.trackingRef], { allowFail: true });
      } else {
        throw new OriginFetchError(`git fetch ${this.remote} failed: ${r.stderr.trim() || r.stdout.trim()}`, classifyFetchFailure(r.stderr, r.timedOut));
      }
    }
    this.lastFetchAt = this.now();
  }

  /**
   * Fetch origin's `refs/heads/<branch>` into the clone's `refs/heads/<branch>` (forced) and answer its tip, or
   * undefined when origin has no such branch. Runs on the serial chain like every other remote command; the integration
   * branch's tracking ref and the fetch interval are left alone. Throws `OriginFetchError` (refused or unreachable) when
   * the fetch fails otherwise. See specs/remote-workspace "Seal".
   */
  fetchBranch(branch: string): Promise<string | undefined> {
    return this.serial(async () => {
      await this.ensure();
      const ref = `refs/heads/${branch}`;
      const r = await this.remoteGit(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', this.remote, `+${ref}:${ref}`]);
      if (r.code !== 0) {
        // The answer comes from origin, never from a ref an earlier fetch left in the clone.
        if (!r.timedOut && /couldn't find remote ref/i.test(r.stderr)) return undefined;
        throw new OriginFetchError(`git fetch ${this.remote} ${ref} failed: ${r.stderr.trim() || r.stdout.trim()}`, classifyFetchFailure(r.stderr, r.timedOut));
      }
      return revParse(this.repo, ref);
    });
  }

  /**
   * Fetch origin's `<ref>` into the clone's `<ref>` (forced) and answer its sha, or undefined when origin has no such
   * ref, even when the clone still holds one from an earlier fetch (that ref is then left as it is). Runs on the serial
   * chain like every other remote command; the integration branch's tracking ref and the fetch interval are left alone.
   * A name outside `refs/` or one `git check-ref-format` rejects is refused with an `Error` before origin is touched.
   * Throws `OriginFetchError` (refused or unreachable) when the fetch fails otherwise.
   */
  fetchRef(ref: string): Promise<string | undefined> {
    return this.serial(async () => {
      await this.checkRefName(ref, false);
      await this.ensure();
      const r = await this.remoteGit(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', this.remote, `+${ref}:${ref}`]);
      if (r.code !== 0) {
        // The answer comes from origin, never from a ref an earlier fetch left in the clone.
        if (!r.timedOut && /couldn't find remote ref/i.test(r.stderr)) return undefined;
        throw new OriginFetchError(`git fetch ${this.remote} ${ref} failed: ${r.stderr.trim() || r.stdout.trim()}`, classifyFetchFailure(r.stderr, r.timedOut));
      }
      return revParse(this.repo, ref);
    });
  }

  /**
   * Refuse a ref name a remote method must not use: one outside `refs/`, one `git check-ref-format` rejects, and for a
   * delete any name outside `refs/verify/` (the integration branch, its tracking ref and every other branch, whatever
   * their case). Runs no command that talks to origin and adds or re-points no remote.
   */
  private async checkRefName(ref: string, forDelete: boolean): Promise<void> {
    if (!ref.startsWith('refs/')) throw new Error(`refused ref name ${JSON.stringify(ref)}: it does not start with refs/`);
    const r = await git(this.repo, ['check-ref-format', ref], { allowFail: true });
    if (r.code !== 0) throw new Error(`refused ref name ${JSON.stringify(ref)}: git check-ref-format rejects it`);
    // A prefix check, not a name compare: on a case-insensitive filesystem refs/heads/MAIN is refs/heads/main.
    if (forDelete && !ref.startsWith(VERIFY_REF_PREFIX)) throw new Error(`refused ref name ${JSON.stringify(ref)}: only a ref under ${VERIFY_REF_PREFIX} is deleted`);
  }

  /**
   * Read the tip of origin's `refs/heads/<branch>` with `ls-remote`, fetching nothing: undefined when origin has no such
   * branch. Runs on the serial chain like every other remote command. Throws `OriginFetchError` (refused or
   * unreachable) when origin cannot be read. See specs/pull-runner "Lease expiry".
   */
  branchTip(branch: string): Promise<string | undefined> {
    return this.serial(async () => {
      await this.ensure();
      const ref = `refs/heads/${branch}`;
      const r = await this.remoteGit(['ls-remote', '--heads', this.remote, ref]);
      if (r.code !== 0) throw new OriginFetchError(`git ls-remote ${this.remote} ${ref} failed: ${r.stderr.trim() || r.stdout.trim()}`, classifyFetchFailure(r.stderr, r.timedOut));
      for (const line of r.stdout.split('\n')) {
        const [sha, name] = line.trim().split(/\s+/);
        if (sha && name === ref) return sha.toLowerCase();
      }
      return undefined;
    });
  }

  /**
   * `branchTip` from the tick, which never waits for origin: a read the tick starts while origin is idle is awaited at
   * most `tickWaitMs`; one queued behind another remote command is not awaited. `pending` while the read runs on; a
   * later call answers its outcome (a failed read throws its error) and forgets it. A read is tagged with `tag` (the
   * lease's `expiresAt`): a read started under another tag is dropped and a new one started, so a read from before a
   * lease renewal never decides a later expiry. See specs/integration-pipeline "The tick never waits for origin" and
   * specs/pull-runner "Lease expiry".
   */
  async branchTipFromTick(branch: string, tag?: number): Promise<{ pending: true } | { pending: false; tip: string | undefined }> {
    let read = this.tipReads.get(branch);
    if (read && read.tag !== tag) {
      // Started for an earlier lease expiry: the worker renewed its lease since and may have pushed more.
      this.tipReads.delete(branch);
      read = undefined;
    }
    let wait = false;
    if (!read) {
      wait = !this.busy;
      const started: TipRead = { done: this.branchTip(branch), ...(tag !== undefined ? { tag } : {}) };
      started.done.then(
        (tip) => (started.outcome = { tip }),
        (error: unknown) => (started.outcome = { error }),
      );
      this.tipReads.set(branch, started);
      read = started;
      if (wait) await within(read.done, this.tickWaitMs).catch(() => undefined);
      // Let the outcome handlers run when the read settled within the wait.
      await Promise.resolve();
    }
    const outcome = read.outcome;
    if (!outcome) return { pending: true };
    if (this.tipReads.get(branch) === read) this.tipReads.delete(branch);
    if ('error' in outcome) throw outcome.error;
    return { pending: false, tip: outcome.tip };
  }

  /** Drop a tick's read of a branch tip (the launch ended, or its expiry gave up); a running read runs on and is ignored. */
  forgetBranchTip(branch: string): void {
    this.tipReads.delete(branch);
  }

  /** Fetch unless one ran within `fetchIntervalMs`; a failed fetch keeps the last observed head. */
  async maybeFetch(opts: { awaitFetch?: boolean } = {}): Promise<void> {
    if (this.now() - this.lastFetchAt < (this.opts.fetchIntervalMs ?? 0)) return;
    // Never wait behind a running push or fetch: the last observed head stands until the remote is free.
    if (this.busy) return;
    const fetching = this.fetch().catch(() => {
      // The tracking ref keeps the last head origin was seen at; an unreachable origin is tried again after the interval.
      this.lastFetchAt = this.now();
    });
    // A slow fetch runs on (bounded by remoteTimeoutMs) while the tick goes on with the last fetched head.
    if (opts.awaitFetch) await fetching;
    else await within(fetching, this.tickWaitMs);
  }

  private get tickWaitMs(): number {
    return this.opts.tickWaitMs ?? DEFAULT_TICK_WAIT_MS;
  }

  /**
   * Push a tag from the tick: waits at most `tickWaitMs`. Undefined when the push is still running; it runs on and its
   * outcome is kept, so a later call for the same tag answers `'pushed'` from it without pushing again, or waits on it
   * while it still runs. A push that ended in a failure after the wait is pushed again by the next call. Errors as
   * `pushTag`. See specs/integration-pipeline "A slow tag push is confirmed when it completes".
   */
  async pushTagFromTick(name: string, sha: string): Promise<'pushed' | undefined> {
    let push = this.tagPushes.get(name);
    if (push && (push.sha !== sha || push.outcome === 'failed')) {
      this.tagPushes.delete(name);
      push = undefined;
    }
    if (push?.outcome === 'pushed') {
      this.tagPushes.delete(name);
      return 'pushed';
    }
    if (!push) {
      const started: TagPush = { sha, done: this.pushTag(name, sha) };
      started.done.then(
        () => (started.outcome = 'pushed'),
        () => (started.outcome = 'failed'),
      );
      this.tagPushes.set(name, started);
      push = started;
    }
    let r: { value: void } | undefined;
    try {
      r = await within(push.done, this.tickWaitMs);
    } catch (err) {
      if (this.tagPushes.get(name) === push) this.tagPushes.delete(name);
      throw err;
    }
    if (!r) return undefined;
    if (this.tagPushes.get(name) === push) this.tagPushes.delete(name);
    return 'pushed';
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
   * On success the tracking ref is moved to `sha`, so base selection sees the publication at once. A failure says
   * whether the lease failed, origin refused, or origin could not be reached in time.
   */
  pushBranch(sha: string, expected: string | undefined): Promise<PushResult> {
    return this.serial(async () => {
      await this.ensure();
      const ref = `refs/heads/${this.opts.integrationBranch}`;
      const r = await this.remoteGit(['push', '--quiet', '--no-verify', `--force-with-lease=${ref}:${expected ?? ''}`, this.remote, `${sha}:${ref}`]);
      if (r.code !== 0) {
        const message = (r.stderr.trim() || r.stdout.trim() || `git push exited ${r.code}`).slice(-4000);
        return { ok: false, kind: classifyPushFailure(r.stderr, r.timedOut), message };
      }
      await git(this.repo, ['update-ref', this.trackingRef, sha]);
      return { ok: true };
    });
  }

  /** Push a tag without force. Pushing a tag origin already holds at the same sha is a no-op. */
  pushTag(name: string, sha: string): Promise<void> {
    return this.serial(async () => {
      await this.ensure();
      const ref = `refs/tags/${name}`;
      const r = await this.remoteGit(['push', '--quiet', '--no-verify', this.remote, `${ref}:${ref}`]);
      if (r.code === 0) return;
      if (r.timedOut) throw new Error(`git push ${this.remote} ${ref} failed: ${r.stderr.trim()}`);
      const remote = await this.remoteGit(['ls-remote', this.remote, ref]);
      const remoteSha = remote.code === 0 ? remote.stdout.trim().split(/\s+/)[0] : undefined;
      if (remoteSha && remoteSha === sha) return;
      if (remoteSha) throw new TagConflictError(name, remoteSha, sha);
      throw new Error(`git push ${this.remote} ${ref} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    });
  }

  /**
   * Delete `<ref>` on origin, then the clone's `<ref>`. A ref origin does not have, or the clone never had, is not an
   * error. Runs on the serial chain like every other remote command. A name outside `refs/verify/` or one
   * `git check-ref-format` rejects is refused before origin is touched. Any other failure rejects and leaves the
   * clone's ref.
   */
  deleteRef(ref: string): Promise<void> {
    return this.serial(async () => {
      await this.checkRefName(ref, true);
      await this.ensure();
      const r = await this.remoteGit(['push', '--quiet', '--no-verify', this.remote, `:${ref}`]);
      if (r.code !== 0 && (r.timedOut || !/remote ref does not exist/i.test(r.stderr))) {
        throw new Error(`git push ${this.remote} :${ref} failed: ${r.stderr.trim() || r.stdout.trim()}`);
      }
      await git(this.repo, ['update-ref', '-d', ref], { allowFail: true });
    });
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
}
