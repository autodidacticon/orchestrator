/**
 * Real workspace over git worktrees. See specs/integration-pipeline "Repository layout".
 */
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { composeBrief } from '../brief/compose.js';
import type { Id } from '../graph/model.js';
import type { Launch } from '../state/store.js';
import { existsSync } from 'node:fs';
import { dirtyFiles, git, LocalTagConflictError, refExists, revParse, tagIdempotent, worktreeAdd, worktreeList, worktreeReattach, worktreeRemove } from './git.js';
import { treeFingerprint } from './fingerprint.js';
import { type Origin, TagConflictError } from './origin.js';
import type { BriefInput, FallbackReport, PreserveOptions, RemoveOptions, SealOptions, SealResult, TagPushResult, Workspace } from './workspace.js';

export const ORCH_DIR = '.orchestrator';
export const FALLBACK_FILE = 'report.json';

export class GitWorkspace implements Workspace {
  private origin: Origin | undefined;

  constructor(
    public readonly repo: string,
    public readonly integrationBranch: string,
    public readonly worktreesRoot: string,
  ) {}

  /** Make origin the source of truth: base selection reads its head and milestone tags are pushed. See specs/integration-pipeline "Origin as source of truth". */
  useOrigin(origin: Origin | undefined): void {
    this.origin = origin;
  }

  /**
   * Without an origin, the clone's integration branch. With one, origin's head as last fetched (fetching when the
   * interval allows); the clone's head instead while it holds publications origin has not received yet, so a base
   * always contains every published dependency.
   */
  async integrationHead(opts: { awaitFetch?: boolean } = {}): Promise<string> {
    const local = await revParse(this.repo, this.integrationBranch);
    const origin = this.origin;
    if (!origin) return local;
    await origin.maybeFetch(opts);
    const remote = await origin.head();
    // A swap whose push is in flight is not yet published: its lease may still fail.
    if (remote !== undefined && local === origin.inFlight) return remote;
    const rel = await origin.relation(local, remote);
    return rel === 'ahead' || rel === 'noRemoteBranch' || remote === undefined ? local : remote;
  }

  async prepare(launch: Launch, brief: BriefInput): Promise<void> {
    await mkdir(path.dirname(launch.worktree), { recursive: true });
    if (await refExists(this.repo, `refs/heads/${launch.branch}`)) {
      // Re-preparing a launch whose worktree vanished: reset its branch to the base and attach a new worktree.
      await worktreeReattach(this.repo, launch.worktree, launch.branch, launch.baseSha);
    } else {
      await worktreeAdd(this.repo, launch.worktree, launch.branch, launch.baseSha);
    }
    await this.ensureExcluded();
    const dir = path.join(launch.worktree, ORCH_DIR);
    await mkdir(dir, { recursive: true });
    const { markdown, json } = composeBrief(brief, { fallbackPath: path.join(dir, FALLBACK_FILE) });
    await writeFile(path.join(dir, 'brief.md'), markdown, 'utf8');
    await writeFile(path.join(dir, 'brief.json'), JSON.stringify(json, null, 2), 'utf8');
  }

  /** info/exclude lives in the common git dir and is shared by all worktrees. Idempotent. */
  private async ensureExcluded(): Promise<void> {
    const common = (await git(this.repo, ['rev-parse', '--git-common-dir'])).stdout.trim();
    const absCommon = path.isAbsolute(common) ? common : path.join(this.repo, common);
    const file = path.join(absCommon, 'info', 'exclude');
    await mkdir(path.dirname(file), { recursive: true });
    const current = await readFile(file, 'utf8').catch(() => '');
    const line = `${ORCH_DIR}/`;
    if (!current.split('\n').some((l) => l.trim() === line)) {
      await writeFile(file, `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}${line}\n`, 'utf8');
    }
  }

  async seal(launch: Launch, opts: SealOptions = {}): Promise<SealResult> {
    const dirty = (await dirtyFiles(launch.worktree)).filter((f) => !f.startsWith(`${ORCH_DIR}/`));
    if (dirty.length && !opts.autoCommit) return { ok: false, dirty };
    if (dirty.length && opts.autoCommit) {
      // The daemon commit policy: commit what the agent left, as `preserve` does. A clean worktree commits nothing, so an empty submission stays empty.
      await this.commitAll(launch, opts.autoCommit.message);
      return { ok: true, sealedSha: await revParse(launch.worktree, 'HEAD'), committed: true };
    }
    return { ok: true, sealedSha: await revParse(launch.worktree, 'HEAD') };
  }

  /** Commit every change outside `.orchestrator/` as the orchestrator, skipping hooks. */
  private async commitAll(launch: Launch, message: string, opts: PreserveOptions = {}): Promise<void> {
    // The brief directory is git-ignored in every worktree; `add -A` skips it, and the reset is a guard for a repository that tracks it.
    // Without untracked files, `add -u` stages changes to tracked files; paths the worker staged itself are already in the index.
    await git(launch.worktree, ['add', opts.untracked === false ? '-u' : '-A']);
    await git(launch.worktree, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', ORCH_DIR], { allowFail: true });
    await git(launch.worktree, ['-c', 'user.name=orchestrator', '-c', 'user.email=orchestrator@localhost', 'commit', '-q', '--no-verify', '-m', message]);
  }

  async readFallback(launch: Launch): Promise<FallbackReport | undefined> {
    const p = path.join(launch.worktree, ORCH_DIR, FALLBACK_FILE);
    let text: string;
    try {
      text = await readFile(p, 'utf8');
    } catch {
      return undefined;
    }
    await rm(p, { force: true });
    try {
      const parsed = JSON.parse(text) as Partial<FallbackReport>;
      if (!parsed || typeof parsed !== 'object' || !parsed.kind) return undefined;
      return {
        launchId: String(parsed.launchId ?? launch.launchId),
        seq: Number(parsed.seq ?? 0),
        kind: parsed.kind,
        body: (parsed.body ?? {}) as Record<string, unknown>,
      };
    } catch {
      return undefined;
    }
  }

  /** Never throws; false when the worktree is still on disk or registered after the attempts (see worktreeRemove). */
  async remove(launch: Launch, opts: RemoveOptions = {}): Promise<boolean> {
    return worktreeRemove(this.repo, launch.worktree, opts);
  }

  async listWorktrees(): Promise<string[]> {
    const root = await realpath(path.resolve(this.worktreesRoot)).catch(() => path.resolve(this.worktreesRoot));
    const all = await worktreeList(this.repo);
    const out: string[] = [];
    for (const p of all) {
      const real = await realpath(p).catch(() => path.resolve(p));
      if (real.startsWith(`${root}${path.sep}`)) out.push(path.basename(real));
    }
    return out;
  }

  /**
   * Tag locally (idempotent); with an origin, push the tag without force, so an existing tag on origin is never moved.
   * Never throws: a tag the clone already holds at another sha (one `git clone` brought from origin, say) is a conflict
   * and is not pushed; a remote that is busy with another command is left for a later tick.
   * See specs/integration-pipeline "Milestone tag conflicts never throw".
   */
  async tagMilestone(id: Id, version: number, sha: string): Promise<TagPushResult | void> {
    const name = `milestone/${id}/v${version}`;
    try {
      await tagIdempotent(this.repo, name, sha);
    } catch (err) {
      if (err instanceof LocalTagConflictError) return { pushed: false, error: err.message, conflict: { remoteSha: err.existingSha, where: 'clone' } };
      return { pushed: false, error: String(err) };
    }
    if (!this.origin) return;
    if (this.origin.busy) return { pushed: false, error: `${this.origin.remote} is busy with another command; the tag is pushed on a later tick` };
    try {
      if (!(await this.origin.pushTagFromTick(name, sha))) return { pushed: false, error: `the push of ${name} to ${this.origin.remote} is still running; it is confirmed on a later tick` };
      return { pushed: true };
    } catch (err) {
      if (err instanceof TagConflictError) return { pushed: false, error: err.message, conflict: { remoteSha: err.remoteSha, where: 'origin' } };
      return { pushed: false, error: String(err) };
    }
  }

  async diffStat(from: string, to: string): Promise<string> {
    const r = await git(this.repo, ['diff', '--stat', `${from}..${to}`], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : '';
  }

  async exists(launch: Launch): Promise<boolean> {
    return existsSync(path.join(launch.worktree, ORCH_DIR, 'brief.json'));
  }

  async preserve(launch: Launch, opts: PreserveOptions = {}): Promise<{ headSha: string; wipCommit?: string }> {
    const untracked = opts.untracked ?? true;
    const dirty = (await dirtyFiles(launch.worktree, { untracked })).filter((f) => !f.startsWith(`${ORCH_DIR}/`));
    let wipCommit: string | undefined;
    if (dirty.length) {
      await this.commitAll(launch, 'WIP: uncommitted work preserved by the orchestrator at release', { untracked });
      wipCommit = await revParse(launch.worktree, 'HEAD');
    }
    return { headSha: await revParse(launch.worktree, 'HEAD'), wipCommit };
  }

  /** The shared tree fingerprint (src/workspace/fingerprint.ts), the same function a remote worker's loop uses for its clone. */
  async fingerprint(launch: Launch): Promise<string> {
    return treeFingerprint(launch.worktree);
  }
}
