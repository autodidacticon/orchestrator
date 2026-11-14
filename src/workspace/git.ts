/**
 * Thin git wrapper over execFile. Every call names its cwd explicitly.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly code: number | string | null,
  ) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim() || stdout.trim()}`);
    this.name = 'GitError';
  }
}

/**
 * GIT_OPTIONAL_LOCKS=0: the daemon's reads of a live worktree must not refresh its index, which takes index.lock
 * and makes the agent's own `git commit` fail. The setting covers `git status`, but porcelain `git diff` refreshes
 * the index regardless, so worktree reads use plumbing (`git diff-index`) instead. Writes still lock. See
 * specs/health-monitoring "Worktree observation takes no index lock".
 */
const baseEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
  /** Killed because it did not finish within `timeoutMs`. */
  timedOut?: boolean;
}

export async function git(cwd: string, args: string[], opts: { allowFail?: boolean; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<GitResult> {
  if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
    const r = await gitBounded(cwd, args, opts.env, opts.timeoutMs);
    if (r.code !== 0 && !opts.allowFail) throw new GitError(args, r.stdout, r.stderr, r.code);
    return r;
  }
  try {
    const { stdout, stderr } = await execFileP('git', args, { cwd, env: { ...baseEnv, ...opts.env }, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string | null };
    if (opts.allowFail) return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : 1 };
    throw new GitError(args, e.stdout ?? '', e.stderr ?? '', e.code ?? null);
  }
}

/**
 * A git command that talks to a remote, bounded by `timeoutMs`. It runs in its own process group, and on timeout the
 * whole group is killed, so the transport helpers it started (ssh, a remote-helper, a local upload-pack) die with it
 * and nothing holds its pipes open. See specs/integration-pipeline "Remote commands are bounded".
 */
function gitBounded(cwd: string, args: string[], env: Record<string, string> | undefined, timeoutMs: number): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid as number), 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    const done = (code: number) => {
      clearTimeout(timer);
      if (timedOut) resolve({ stdout, stderr: `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}git ${args[0]} timed out after ${timeoutMs}ms and was killed`, code: code || 1, timedOut });
      else resolve({ stdout, stderr, code });
    };
    child.on('close', (code) => done(code ?? 1));
    child.on('error', (err) => {
      stderr += String(err);
      done(1);
    });
  });
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim();
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true })).code === 0;
}

/** Parse `git status --porcelain=v1 -z` output into paths. */
export function parsePorcelain(out: string): string[] {
  const files: string[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const xy = p.slice(0, 2);
    const path = p.slice(3);
    files.push(path);
    // Renames carry the original path as the next NUL-separated entry.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return files;
}

/** Changed paths in the worktree; with `untracked: false`, only tracked files and staged paths. */
export async function dirtyFiles(worktree: string, opts: { untracked?: boolean } = {}): Promise<string[]> {
  const { stdout } = await git(worktree, ['status', '--porcelain=v1', '-z', `--untracked-files=${opts.untracked === false ? 'no' : 'all'}`]);
  return parsePorcelain(stdout);
}

export async function worktreeAdd(repo: string, path: string, branch: string, baseSha: string): Promise<void> {
  await git(repo, ['worktree', 'add', '-b', branch, path, baseSha]);
}

export async function worktreeAddDetached(repo: string, path: string, sha: string): Promise<void> {
  await git(repo, ['worktree', 'add', '--detach', path, sha]);
}

export async function worktreeRemove(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', path], { allowFail: true });
  await git(repo, ['worktree', 'prune'], { allowFail: true });
}

export async function worktreeList(repo: string): Promise<string[]> {
  const { stdout } = await git(repo, ['worktree', 'list', '--porcelain']);
  return stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim());
}

/** The clone already holds a tag under the same name at another sha. */
export class LocalTagConflictError extends Error {
  constructor(
    public readonly tag: string,
    public readonly existingSha: string,
    public readonly sha: string,
  ) {
    super(`tag ${tag} exists in the clone at ${existingSha}, not ${sha}; it is never moved`);
    this.name = 'LocalTagConflictError';
  }
}

/** Create or confirm a tag. Idempotent when it already points at `sha`; throws LocalTagConflictError when it points elsewhere. */
export async function tagIdempotent(repo: string, name: string, sha: string): Promise<void> {
  const existing = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}^{commit}`], { allowFail: true });
  if (existing.code === 0) {
    if (existing.stdout.trim() === sha) return;
    throw new LocalTagConflictError(name, existing.stdout.trim(), sha);
  }
  await git(repo, ['tag', name, sha]);
}

/** Compare-and-swap ref update. Returns false if the old value did not match. */
export async function updateRefCas(repo: string, ref: string, newSha: string, oldSha: string): Promise<boolean> {
  const r = await git(repo, ['update-ref', ref, newSha, oldSha], { allowFail: true });
  return r.code === 0;
}

/** Commits on `ref` (first-parent) whose message contains the trailer value. */
export async function findTrailer(repo: string, ref: string, trailer: string, value: string): Promise<string | undefined> {
  const r = await git(repo, ['log', '--first-parent', '--format=%H', '-F', `--grep=${trailer}: ${value}`, ref], { allowFail: true });
  const sha = r.stdout.trim().split('\n')[0];
  return sha || undefined;
}

export async function commitTrailers(repo: string, sha: string): Promise<Record<string, string>> {
  const r = await git(repo, ['show', '-s', '--format=%(trailers:only,unfold)', sha]);
  const out: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line.trim());
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

export async function firstParentLog(repo: string, ref: string, limit = 200): Promise<string[]> {
  const r = await git(repo, ['log', '--first-parent', '--format=%H', `-n${limit}`, ref]);
  return r.stdout.trim().split('\n').filter(Boolean);
}
