/**
 * `Origin.fetchRef` and `Origin.deleteRef`: a ref outside `refs/heads/` fetched from and deleted on a bare origin, on
 * the same serial chain as every other remote command. Nothing in the daemon calls them yet (#32 will, for
 * `refs/verify/<jobId>`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Origin, OriginFetchError } from '../../src/workspace/origin.js';
import { gitIn, makeRepo } from './harness.js';

/** A temp dir with the daemon's clone and a bare origin cloned from it; the clone's `origin` is not configured yet. */
function fixture(): { dir: string; repo: string; bare: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-origin-ref-'));
  const repo = makeRepo(dir);
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  return { dir, repo, bare };
}

let clones = 0;

/** Commit `file` in a second clone of origin, on top of origin's main (or as a root commit with `orphan`), and push it to `ref` on origin. */
function pushToOrigin(dir: string, bare: string, ref: string, file: string, opts: { orphan?: boolean; force?: boolean } = {}): string {
  const other = path.join(dir, `other-${clones++}`);
  gitIn(dir, 'clone', '-q', bare, other);
  if (opts.orphan) {
    gitIn(other, 'checkout', '-q', '--orphan', 'tmp');
    gitIn(other, 'rm', '-q', '-rf', '.');
  }
  writeFileSync(path.join(other, file), `${file}\n`);
  gitIn(other, 'add', file);
  gitIn(other, 'commit', '-q', '-m', `add ${file}`);
  gitIn(other, 'push', '-q', ...(opts.force ? ['--force'] : []), 'origin', `HEAD:${ref}`);
  return gitIn(other, 'rev-parse', 'HEAD');
}

/** The sha `ref` names in `cwd`, or undefined when it does not exist. */
function refSha(cwd: string, ref: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

describe('Origin.fetchRef', () => {
  it('criterion 1: fetches a ref into the clone, follows a forced move, and answers undefined for a ref origin lacks', async () => {
    const f = fixture();
    const origin = new Origin({ repo: f.repo, integrationBranch: 'main', url: f.bare });
    const first = pushToOrigin(f.dir, f.bare, 'refs/verify/x', 'a.txt');
    expect(await origin.fetchRef('refs/verify/x')).toBe(first);
    expect(refSha(f.repo, 'refs/verify/x')).toBe(first);

    // Forced to a commit that does not descend from the first.
    const second = pushToOrigin(f.dir, f.bare, 'refs/verify/x', 'b.txt', { orphan: true, force: true });
    expect(() => execFileSync('git', ['merge-base', '--is-ancestor', first, second], { cwd: f.bare })).toThrow();
    expect(await origin.fetchRef('refs/verify/x')).toBe(second);
    expect(refSha(f.repo, 'refs/verify/x')).toBe(second);

    expect(await origin.fetchRef('refs/verify/none')).toBeUndefined();

    // Gone from origin while the clone still holds it: the answer comes from origin, the clone's ref is left.
    gitIn(f.bare, 'update-ref', '-d', 'refs/verify/x');
    expect(await origin.fetchRef('refs/verify/x')).toBeUndefined();
    expect(refSha(f.repo, 'refs/verify/x')).toBe(second);
  }, 30_000);

  it('criterion 2: an origin that does not exist, and a stalled fetch, reject with OriginFetchError of kind unreachable', async () => {
    const f = fixture();
    const missing = new Origin({ repo: f.repo, integrationBranch: 'main', url: path.join(f.dir, 'nowhere.git') });
    const err = await missing.fetchRef('refs/verify/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OriginFetchError);
    expect((err as OriginFetchError).kind).toBe('unreachable');

    const g = fixture();
    gitIn(g.repo, 'remote', 'add', 'origin', g.bare);
    gitIn(g.repo, 'config', 'remote.origin.uploadpack', 'sleep 30; :');
    const stalled = new Origin({ repo: g.repo, integrationBranch: 'main', remoteTimeoutMs: 800 });
    const t0 = Date.now();
    const timedOut = await stalled.fetchRef('refs/verify/x').catch((e: unknown) => e);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(timedOut).toBeInstanceOf(OriginFetchError);
    expect((timedOut as OriginFetchError).kind).toBe('unreachable');
    expect((timedOut as OriginFetchError).message).toContain('timed out after 800ms');
    expect(stalled.busy).toBe(false);
  }, 30_000);
});

describe('Origin.deleteRef', () => {
  it('criterion 3: deletes the ref on origin and in the clone; a ref already gone is not an error', async () => {
    const f = fixture();
    const origin = new Origin({ repo: f.repo, integrationBranch: 'main', url: f.bare });
    const sha = pushToOrigin(f.dir, f.bare, 'refs/verify/x', 'a.txt');
    expect(await origin.fetchRef('refs/verify/x')).toBe(sha);
    expect(refSha(f.repo, 'refs/verify/x')).toBe(sha);

    await expect(origin.deleteRef('refs/verify/x')).resolves.toBeUndefined();
    expect(gitIn(f.repo, 'ls-remote', f.bare, 'refs/verify/x')).toBe('');
    expect(refSha(f.repo, 'refs/verify/x')).toBeUndefined();
    // Gone from origin and from the clone: a second call resolves.
    await expect(origin.deleteRef('refs/verify/x')).resolves.toBeUndefined();

    // Origin lacks the ref, the clone holds it: the call resolves and the clone's ref is gone.
    gitIn(f.repo, 'update-ref', 'refs/verify/y', sha);
    await expect(origin.deleteRef('refs/verify/y')).resolves.toBeUndefined();
    expect(refSha(f.repo, 'refs/verify/y')).toBeUndefined();

    const missing = new Origin({ repo: f.repo, integrationBranch: 'main', remote: 'gone', url: path.join(f.dir, 'nowhere.git') });
    const err = await missing.deleteRef('refs/verify/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.startsWith('git push')).toBe(true);
  }, 30_000);
});

describe('ref names', () => {
  it('criterion 4: a name outside refs/, one git check-ref-format rejects, or the integration branch is refused before origin is touched', async () => {
    const f = fixture();
    const mainBefore = gitIn(f.bare, 'rev-parse', 'refs/heads/main');
    const origin = new Origin({ repo: f.repo, integrationBranch: 'main', url: f.bare });
    const refusals: unknown[] = [];
    for (const name of ['heads/x', 'refs/verify/a..b', 'refs/verify/x.lock']) {
      refusals.push(await origin.fetchRef(name).then(() => 'resolved', (e: unknown) => e));
      refusals.push(await origin.deleteRef(name).then(() => 'resolved', (e: unknown) => e));
    }
    refusals.push(await origin.deleteRef('refs/heads/main').then(() => 'resolved', (e: unknown) => e));
    expect(refusals).toHaveLength(7);
    for (const r of refusals) {
      expect(r).toBeInstanceOf(Error);
      expect(r).not.toBeInstanceOf(OriginFetchError);
    }
    expect((refusals[2] as Error).message).toContain('refs/verify/a..b');
    expect((refusals[6] as Error).message).toContain('refs/heads/main');
    expect(gitIn(f.repo, 'remote')).toBe('');
    expect(gitIn(f.bare, 'rev-parse', 'refs/heads/main')).toBe(mainBefore);
  }, 30_000);
});

describe('one at a time', () => {
  it('criterion 5: a fetch called while a stalled delete holds the chain waits for it, then answers origin', async () => {
    const f = fixture();
    const sha = pushToOrigin(f.dir, f.bare, 'refs/verify/x', 'a.txt');
    gitIn(f.repo, 'remote', 'add', 'origin', f.bare);
    gitIn(f.repo, 'config', 'remote.origin.receivepack', 'sleep 30; :');
    const origin = new Origin({ repo: f.repo, integrationBranch: 'main', remoteTimeoutMs: 800 });
    const order: string[] = [];
    const t0 = Date.now();
    const deleting = origin.deleteRef('refs/verify/x').then(
      () => void order.push('delete resolved'),
      (e: unknown) => void order.push(`delete rejected ${(e as Error).message.includes('timed out after 800ms') ? 'timeout' : (e as Error).message}`),
    );
    const fetching = origin.fetchRef('refs/verify/x').then((v) => {
      order.push('fetch resolved');
      return v;
    });
    const [, fetched] = await Promise.all([deleting, fetching]);
    expect(order).toEqual(['delete rejected timeout', 'fetch resolved']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700);
    expect(fetched).toBe(sha);
    expect(gitIn(f.repo, 'ls-remote', f.bare, 'refs/verify/x')).toBe(`${sha}\trefs/verify/x`);
  }, 30_000);
});

describe('deleteRef takes only verify refs (GH-184)', () => {
  it('criterion 5: refs/heads/main, refs/heads/MAIN and refs/remotes/origin/main are refused and touch neither the clone nor origin; a missing verify ref resolves', async () => {
    const f = fixture();
    const origin = new Origin({ repo: f.repo, integrationBranch: 'main', url: f.bare });
    const cloneMain = gitIn(f.repo, 'rev-parse', 'refs/heads/main');
    gitIn(f.repo, 'update-ref', 'refs/remotes/origin/main', cloneMain);
    const originMain = gitIn(f.bare, 'rev-parse', 'refs/heads/main');
    for (const name of ['refs/heads/main', 'refs/heads/MAIN', 'refs/remotes/origin/main', 'refs/heads/feature', 'refs/tags/v1', 'refs/verifyx/a']) {
      const err = await origin.deleteRef(name).then(() => 'resolved', (e: unknown) => e);
      expect(err, name).toBeInstanceOf(Error);
      expect((err as Error).message, name).toContain(JSON.stringify(name));
      expect((err as Error).message, name).toContain('refs/verify/');
    }
    expect(gitIn(f.repo, 'remote')).toBe('');
    expect(gitIn(f.repo, 'rev-parse', 'refs/heads/main')).toBe(cloneMain);
    expect(gitIn(f.repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(cloneMain);
    expect(gitIn(f.bare, 'rev-parse', 'refs/heads/main')).toBe(originMain);

    // A verify ref neither origin nor the clone has.
    await expect(origin.deleteRef('refs/verify/missing')).resolves.toBeUndefined();
    expect(gitIn(f.bare, 'rev-parse', 'refs/heads/main')).toBe(originMain);
  }, 30_000);

  it("criterion 5: a push git answers with \"remote ref does not exist\" resolves and removes the clone's ref; another failure rejects", async () => {
    const f = fixture();
    const origin = new Origin({ repo: f.repo, integrationBranch: 'main', url: f.bare });
    const sha = gitIn(f.repo, 'rev-parse', 'HEAD');
    // Git 2.55 exits 0 for a deletion of a ref origin lacks: answer as older git does.
    const remoteGit = (origin as unknown as { remoteGit: (a: string[]) => Promise<unknown> }).remoteGit.bind(origin);
    let stderr = "error: unable to delete 'refs/verify/gone': remote ref does not exist\nerror: failed to push some refs";
    (origin as unknown as { remoteGit: (a: string[]) => Promise<unknown> }).remoteGit = async (args: string[]) =>
      args[0] === 'push' ? { code: 1, stdout: '', stderr, timedOut: false } : remoteGit(args);
    gitIn(f.repo, 'update-ref', 'refs/verify/gone', sha);
    await expect(origin.deleteRef('refs/verify/gone')).resolves.toBeUndefined();
    expect(refSha(f.repo, 'refs/verify/gone')).toBeUndefined();
    stderr = ' ! [remote rejected] refs/verify/gone (hook declined)';
    gitIn(f.repo, 'update-ref', 'refs/verify/gone', sha);
    await expect(origin.deleteRef('refs/verify/gone')).rejects.toThrow(/hook declined/);
    expect(refSha(f.repo, 'refs/verify/gone')).toBe(sha);
  }, 30_000);
});
