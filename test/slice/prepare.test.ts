import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigInput } from '../../src/config.js';
import { pidAlive } from '../../src/runner/subprocess.js';
import type { Launch } from '../../src/state/store.js';
import { runCheck } from '../../src/verify/verifier.js';
import { gitIn, makeRepo, makeSlice, single, type SliceHarness } from './harness.js';

/**
 * The prepare command with a real repository and real processes (ORC-130). Commands use only sh builtins, touch,
 * mkdir, test and sleep, plus one node helper for a held output pipe; nothing needs the network or a package manager.
 * See specs/pull-runner "Prepare command" and "Prepare failure".
 */
let h: SliceHarness | undefined;
const dirs: string[] = [];
const strays: number[] = [];
const savedUrl = process.env['ORCH_URL'];
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedUrl === undefined) delete process.env['ORCH_URL'];
  else process.env['ORCH_URL'] = savedUrl;
});

function scratch(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'orch-prepare-'));
  dirs.push(d);
  return d;
}

async function slice(config: ConfigInput, opts: { ignore?: boolean; behavior?: string } = {}): Promise<SliceHarness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-slice-'));
  const repo = makeRepo(dir);
  // Only the repository's own ignore rules count: a user's global ignore file may list node_modules.
  const noExcludes = path.join(dir, 'no-excludes');
  writeFileSync(noExcludes, '');
  gitIn(repo, 'config', 'core.excludesFile', noExcludes);
  if (opts.ignore) {
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    gitIn(repo, 'add', '.gitignore');
    gitIn(repo, 'commit', '-q', '-m', 'ignore node_modules');
  }
  return makeSlice({ graph: single(opts.behavior ?? 'commitAndSubmit'), dir, repo, config: { runner: { mode: 'spawn' }, ...config } });
}

const firstLaunch = (s: SliceHarness): Launch | undefined => [...s.store.listLaunches({ taskId: 'T1' })].sort((a, b) => a.launchNo - b.launchNo).at(0);
const failures = (s: SliceHarness) => s.store.listEvents({ kind: 'launch.prepareFailed' });

function pgrep(pattern: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').map(Number).filter((n) => n > 0);
  } catch {
    return [];
  }
}

async function until(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !pred(); ) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('slice: prepare command', () => {
  it('an ignored install tree in the check environment: prepared before the agent starts, never committed', async () => {
    process.env['ORCH_URL'] = 'http://127.0.0.1:9/should-not-leak';
    h = await slice(
      {
        prepareCommand: 'test -z "$ORCH_URL" && test -n "$ORCH_HOME" && mkdir -p node_modules && touch node_modules/marker',
        runner: { mode: 'spawn', claude: { commit: 'daemon' } },
      },
      { ignore: true, behavior: 'submitDirty' },
    );
    const seenAtSpawn: boolean[] = [];
    const spawn = h.runner.spawn.bind(h.runner);
    h.runner.spawn = async (l, env) => {
      seenAtSpawn.push(existsSync(path.join(l.worktree, 'node_modules', 'marker')));
      return spawn(l, env);
    };
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 30_000);
    const l = firstLaunch(h)!;
    expect(h.store.listEvents({ kind: 'launch.prepared', launchId: l.launchId })).toMatchObject([{ payload: { command: expect.stringContaining('touch node_modules/marker') } }]);
    expect(failures(h)).toEqual([]);
    expect(seenAtSpawn).toEqual([true]);
    const job = h.store.listJobs({ taskId: 'T1', status: 'published' })[0]!;
    const files = gitIn(h.repo, 'ls-tree', '-r', '--name-only', job.publishedSha!).split('\n');
    expect(files).toContain('T1.txt');
    expect(files.some((f) => f.startsWith('node_modules'))).toBe(false);
    expect(gitIn(h.repo, 'log', '-1', '--format=%an', l.branch)).toBe('orchestrator');
  });

  it('the command carries its launch id: pgrep finds it, and killByLaunchId ends it', async () => {
    h = await slice({ prepareCommand: 'sleep 30' });
    await h.orch.tick();
    await h.orch.prepareStarted();
    const l = firstLaunch(h)!;
    const label = `orch-prepare-${l.launchId}`;
    await until(() => pgrep(label).length > 0);
    const [outer] = pgrep(label);
    const children = (() => {
      try {
        return execFileSync('pgrep', ['-P', String(outer)], { encoding: 'utf8' }).split('\n').map(Number).filter((n) => n > 0);
      } catch {
        return [];
      }
    })();
    await h.runner.killByLaunchId(l.launchId);
    // `close` comes only when every holder of the output pipe, the sleep included, is gone.
    await h.orch.prepareJobs.get(l.launchId)!.done;
    expect(pgrep(label)).toEqual([]);
    for (const pid of [outer!, ...children]) expect(pidAlive(pid)).toBe(false);
    await h.orch.tick();
    expect(failures(h)[0]!.payload).toMatchObject({ reason: 'killed', exitCode: null });
  });

  it('an install tree the repository does not ignore is a dirty failure naming its files', async () => {
    h = await slice({ prepareCommand: 'mkdir -p node_modules && touch node_modules/marker' });
    await h.orch.tick();
    await h.waitFor(() => failures(h!).length > 0);
    expect(failures(h)[0]!.payload).toMatchObject({ reason: 'dirty', dirty: ['node_modules/marker'] });
    expect(h.store.getLaunch(failures(h)[0]!.launchId!)).toMatchObject({ status: 'ended', endReason: 'prepareCommandFailed' });
    expect(h.orch.entry('T1').attempts).toBe(0);
  });

  it('a command past prepareTimeoutMs is killed with its group and fails as timeout', async () => {
    const pidFile = path.join(scratch(), 'pids');
    h = await slice({ prepareCommand: `echo $$ >> ${pidFile}; sleep 30`, prepareTimeoutMs: 2_000 });
    await h.orch.tick();
    await h.waitFor(() => failures(h!).length > 0, 15_000);
    expect(failures(h)[0]!.payload).toMatchObject({ reason: 'timeout' });
    const pid = Number(readFileSync(pidFile, 'utf8').split('\n')[0]);
    expect(pid).toBeGreaterThan(0);
    expect(pidAlive(pid)).toBe(false);
  });

  it('a non-zero exit fails as exit with its code', async () => {
    h = await slice({ prepareCommand: 'exit 7' });
    await h.orch.tick();
    await h.waitFor(() => failures(h!).length > 0);
    expect(failures(h)[0]!.payload).toMatchObject({ reason: 'exit', exitCode: 7 });
  });

  it('runCheck: an aborted signal starts nothing; a held pipe after exit resolves as timedOut after the bounded wait', async () => {
    const dir = scratch();
    const marker = path.join(dir, 'started');
    const ac = new AbortController();
    ac.abort();
    const r = await runCheck(`touch ${marker}`, dir, 1_000, 1024, dir, { label: 'orch-prepare-test', signal: ac.signal });
    expect(r).toEqual({ code: null, timedOut: false, aborted: true, output: '' });
    await new Promise((res) => setTimeout(res, 200));
    expect(existsSync(marker)).toBe(false);

    // The helper starts a detached sleep that inherits stdout (outside the group), records its pid and exits 0.
    const pidFile = path.join(dir, 'held');
    const helper = 'const c=require("child_process").spawn("sleep",["30"],{detached:true,stdio:"inherit"});require("fs").writeFileSync(process.argv[1],String(c.pid));c.unref();process.exit(0)';
    const t0 = Date.now();
    const held = await runCheck(`"${process.execPath}" -e '${helper}' ${pidFile}`, dir, 1_000, 1024, dir, { label: 'orch-prepare-test', closeWaitMs: 200 });
    const sleeper = Number(readFileSync(pidFile, 'utf8'));
    strays.push(sleeper);
    expect(held.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(pidAlive(sleeper)).toBe(true);
  });
});
