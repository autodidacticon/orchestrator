/**
 * The remote worker's clone cache: one clone per `repoUrl`, reused across launches. Before each launch the clone is
 * fetched, the launch branch is created at its start commit, and every file git does not track is removed except
 * `.orchestrator/`, which the clone's `.git/info/exclude` keeps out of git. See specs/worker-pool "Clone cache".
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** The directory the loop writes the brief, the MCP config and (from the agent) the fallback report into. */
export const ORCH_DIR = '.orchestrator';
export const FALLBACK_FILE = 'report.json';
const EXCLUDE_LINE = `/${ORCH_DIR}/`;

/** git in `cwd`; never prompts for credentials. Rejects with git's stderr on a non-zero exit. */
export async function gitOut(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(e.stderr || e.message || String(err)).trim()}`);
  }
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await gitOut(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** The cache directory of a repository: a readable name from the URL plus a hash of the whole URL. */
export function cloneDirFor(cache: string, repoUrl: string): string {
  const base = path.basename(repoUrl.replace(/[/\\]+$/, '')).replace(/\.git$/, '') || 'repo';
  const name = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
  const hash = createHash('sha256').update(repoUrl).digest('hex').slice(0, 12);
  return path.join(cache, `${name}-${hash}`);
}

/** Clone `repoUrl` into its cache directory unless a clone is already there; a directory that is not a clone is replaced. */
export async function ensureClone(cache: string, repoUrl: string): Promise<string> {
  const dir = cloneDirFor(cache, repoUrl);
  await mkdir(cache, { recursive: true });
  if (existsSync(path.join(dir, '.git')) && (await gitOk(dir, ['rev-parse', '--git-dir']))) {
    if ((await gitOut(dir, ['remote', 'get-url', 'origin']).catch(() => '')) !== repoUrl) {
      if (!(await gitOk(dir, ['remote', 'set-url', 'origin', repoUrl]))) await gitOut(dir, ['remote', 'add', 'origin', repoUrl]);
    }
  } else {
    await rm(dir, { recursive: true, force: true });
    await gitOut(cache, ['clone', '-q', repoUrl, dir]);
  }
  await excludeOrchDir(dir);
  return dir;
}

/** Add `/.orchestrator/` to the clone's `.git/info/exclude` once. */
async function excludeOrchDir(dir: string): Promise<void> {
  const file = path.join(dir, '.git', 'info', 'exclude');
  const text = await readFile(file, 'utf8').catch(() => '');
  if (text.split(/\r?\n/).includes(EXCLUDE_LINE)) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}${EXCLUDE_LINE}\n`);
}

/**
 * Make the clone ready for a launch: fetch origin, create (or reset) `branch` at `start`, and remove every untracked
 * and ignored file but `.orchestrator/`. A start commit the fetch did not bring is fetched by its sha. Answers the
 * clone directory.
 */
export async function prepareClone(o: { cache: string; repoUrl: string; branch: string; start: string }): Promise<string> {
  const dir = await ensureClone(o.cache, o.repoUrl);
  // An operation a previous agent left half done would keep the checkout from moving.
  for (const [marker, args] of [
    ['rebase-merge', ['rebase', '--abort']],
    ['rebase-apply', ['am', '--abort']],
    ['MERGE_HEAD', ['merge', '--abort']],
    ['CHERRY_PICK_HEAD', ['cherry-pick', '--abort']],
  ] as const) {
    if (existsSync(path.join(dir, '.git', marker))) await gitOk(dir, [...args]);
  }
  await gitOut(dir, ['fetch', '-q', '--prune', 'origin']);
  if (!(await gitOk(dir, ['cat-file', '-e', `${o.start}^{commit}`]))) {
    await gitOut(dir, ['fetch', '-q', 'origin', o.start]);
  }
  await gitOut(dir, ['checkout', '-q', '-f', '-B', o.branch, o.start]);
  await gitOut(dir, ['clean', '-q', '-ffdx', '-e', EXCLUDE_LINE]);
  await mkdir(path.join(dir, ORCH_DIR), { recursive: true });
  // A report a previous agent left behind belongs to another launch.
  await rm(path.join(dir, ORCH_DIR, FALLBACK_FILE), { force: true });
  return dir;
}
