/**
 * The run id per deployment (ORC-87): with store.kind postgres, store.runId over ORCH_RUN_ID over a hash of
 * git.originUrl over the repository path hash; an invalid explicit id is refused naming it; SQLite is unchanged.
 * See specs/state-backend "Run id per deployment" and specs/operator-control "Run directory".
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSetFlags } from '../../src/runs/resolve.js';
import { chooseRunId, originIdentity, repoRunId, runDirFor, runIdFor, runIdForOrigin, runIdWarning, runPaths } from '../../src/runs/runDir.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function repoWith(yaml?: string, origin?: string): string {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-runid-')));
  dirs.push(d);
  execFileSync('git', ['init', '-q', '-b', 'main', d]);
  if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: d });
  if (yaml !== undefined) writeFileSync(path.join(d, 'orchestrator.yaml'), yaml);
  return d;
}

const repo = '/srv/data/repo';

describe('chooseRunId', () => {
  it('postgres: store.runId wins over ORCH_RUN_ID, which wins over git.originUrl, which wins over the path hash', () => {
    const env = { ORCH_RUN_ID: 'from-env' };
    expect(chooseRunId({ kind: 'postgres', storeRunId: 'from-file', env, originUrl: 'https://git.example/a.git', repo })).toEqual({ runId: 'from-file', source: 'store.runId' });
    expect(chooseRunId({ kind: 'postgres', env, originUrl: 'https://git.example/a.git', repo })).toEqual({ runId: 'from-env', source: 'ORCH_RUN_ID' });
    expect(chooseRunId({ kind: 'postgres', env: {}, originUrl: 'https://git.example/a.git', repo })).toEqual({ runId: runIdForOrigin('https://git.example/a.git'), source: 'git.originUrl' });
    expect(chooseRunId({ kind: 'postgres', env: {}, repo })).toEqual({ runId: runIdFor(repo), source: 'repository' });
  });

  it('postgres: two origins on the same repository path get different ids; a credential in the URL does not change the id', () => {
    const a = chooseRunId({ kind: 'postgres', env: {}, originUrl: 'https://git.example/a.git', repo }).runId;
    const b = chooseRunId({ kind: 'postgres', env: {}, originUrl: 'https://git.example/b.git', repo }).runId;
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(runIdForOrigin('https://user:tok1@git.example/a.git')).toBe(runIdForOrigin('https://git.example/a.git'));
    expect(originIdentity('https://user:tok1@git.example/a.git')).not.toContain('tok1');
    expect(originIdentity('git@git.example:a.git')).toBe('git@git.example:a.git');
  });

  it('an invalid store.runId or ORCH_RUN_ID is refused with a message naming it', () => {
    for (const bad of ['', 'has space', 'a/b', 'x'.repeat(65), 'café']) {
      expect(() => chooseRunId({ kind: 'postgres', storeRunId: bad, env: {}, repo })).toThrow(`invalid run id ${JSON.stringify(bad)} from store.runId`);
    }
    expect(() => chooseRunId({ kind: 'postgres', env: { ORCH_RUN_ID: 'no;way' }, repo })).toThrow('invalid run id "no;way" from ORCH_RUN_ID');
    expect(chooseRunId({ kind: 'postgres', storeRunId: 'A-z_0-9', env: {}, repo }).runId).toBe('A-z_0-9');
    expect(chooseRunId({ kind: 'postgres', storeRunId: 'x'.repeat(64), env: {}, repo }).runId).toHaveLength(64);
  });

  it('sqlite: the path hash, whatever store.runId, ORCH_RUN_ID and git.originUrl say (even invalid ones)', () => {
    expect(chooseRunId({ kind: 'sqlite', storeRunId: 'bad id', env: { ORCH_RUN_ID: 'x' }, originUrl: 'https://git.example/a.git', pushIntegration: true, repo })).toEqual({ runId: runIdFor(repo), source: 'repository' });
  });

  it('store.runId is never an override: --set store.runId is refused', () => {
    expect(() => parseSetFlags(['store.runId=x'])).toThrow('unknown key "store.runId"');
  });

  it('warns only for a Postgres run on the path hash', () => {
    expect(runIdWarning('postgres', { runId: 'r', source: 'repository' })).toMatch(/path hash.*store\.runId, ORCH_RUN_ID or git\.originUrl/);
    expect(runIdWarning('postgres', { runId: 'r', source: 'git.originUrl' })).toBeUndefined();
    expect(runIdWarning('sqlite', { runId: 'r', source: 'repository' })).toBeUndefined();
  });
});

describe('the run directory follows the run id', () => {
  const env = (extra: Record<string, string> = {}) => ({ ORCH_HOME: path.join(homedir(), '.orch-unused'), ...extra });

  it('sqlite (no file, or a file without a store block): the path hash, as before; ORCH_RUN_ID is ignored', () => {
    for (const r of [repoWith(), repoWith('runner:\n  mode: pull\n'), repoWith('store:\n  kind: sqlite\n  runId: ignored\ngit:\n  originUrl: https://git.example/a.git\n')]) {
      expect(runDirFor(r, env({ ORCH_RUN_ID: 'nope' }))).toBe(path.join(homedir(), '.orch-unused', 'runs', runIdFor(r)));
      expect(path.basename(runPaths(r, env()).runDir)).toBe(runIdFor(r));
    }
  });

  it('postgres: store.runId, then ORCH_RUN_ID, then git.originUrl, then the clone origin while pushIntegration is on, then the path hash', () => {
    const fileId = repoWith('store:\n  kind: postgres\n  runId: team-a\ngit:\n  originUrl: https://git.example/a.git\n');
    expect(path.basename(runDirFor(fileId, env({ ORCH_RUN_ID: 'team-b' })))).toBe('team-a');
    const envId = repoWith('store:\n  kind: postgres\ngit:\n  originUrl: https://git.example/a.git\n');
    expect(path.basename(runDirFor(envId, env({ ORCH_RUN_ID: 'team-b' })))).toBe('team-b');
    expect(path.basename(runDirFor(envId, env()))).toBe(runIdForOrigin('https://git.example/a.git'));
    const pushing = repoWith('store:\n  kind: postgres\ngit:\n  pushIntegration: true\n', 'https://git.example/c.git');
    expect(repoRunId(pushing, env())).toEqual({ runId: runIdForOrigin('https://git.example/c.git'), source: 'origin' });
    const notPushing = repoWith('store:\n  kind: postgres\n', 'https://git.example/c.git');
    expect(repoRunId(notPushing, env())).toEqual({ runId: runIdFor(notPushing), source: 'repository' });
  });

  it('postgres with an invalid store.runId: resolving the run directory throws naming it', () => {
    const r = repoWith('store:\n  kind: postgres\n  runId: "../escape"\n');
    expect(() => runDirFor(r, env())).toThrow('invalid run id "../escape" from store.runId');
  });
});
