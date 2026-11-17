/**
 * The origin run id rule is frozen: each address below and its run id are both literals, written down once and never
 * recomputed here. A failing vector is a finding about the Node version or the code, never a reason to edit the
 * literal. The repository path hash and the advisory lock key are pinned the same way.
 * See specs/state-backend "Origin identity is frozen".
 */
import { describe, expect, it } from 'vitest';
import { runIdFor, runIdForOrigin } from '../../src/runs/runDir.js';
import { runLockKey } from '../../src/state/pg/sink.js';

const VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['https://git.example.com/team/project.git', '88b53ae7afc6f781'],
  ['https://git.example.com/team/project', '30774d330900e9dc'],
  ['https://git.example.com/team/project/', '884bf3a568293c95'],
  ['https://GIT.example.com:443/team/project.git', '88b53ae7afc6f781'],
  ['https://x-access-token:secret@git.example.com/team/project.git', '88b53ae7afc6f781'],
  ['http://GIT.example.com:80/team/project.git', '559e44dca6da773f'],
  ['https://git.example.com:8443/team/project.git', 'a239ddc3441f6d6c'],
  ['ssh://git@git.example.com/team/project.git', '80a522b921e76c20'],
  ['ssh://other@git.example.com/team/project.git', '80a522b921e76c20'],
  ['ssh://git@GIT.example.com/team/project.git', 'a929f8abcff79ed4'],
  ['ssh://git@git.example.com:22/team/project.git', 'a52c4abb760e2b58'],
  ['git://git-origin.orch.svc:9418/fixture.git', 'af1507c5d17cfdef'],
  ['git://git-origin.orch.svc/fixture.git', 'f62598e6976ef69f'],
  ['git://GIT-origin.orch.svc:9418/fixture.git', 'b8f0f7a20f4b0a50'],
  ['git@git.example.com:team/project.git', '9245f0dda77f617c'],
  ['other@git.example.com:team/project.git', 'a93c1af9aa06b2a6'],
  ['git@GIT.example.com:team/project.git', '27f5d6b225cee7c8'],
  ['git.example.com:team/project.git', '430a03b607b6e432'],
  ['GIT.example.com:team/project.git', '430a03b607b6e432'],
  ['/srv/git/project.git', '86fb6c3ee3132ede'],
];

describe('run id vectors', () => {
  it('origin run ids are frozen', () => {
    expect(VECTORS).toHaveLength(20);
    for (const [url, id] of VECTORS) expect(runIdForOrigin(url), url).toBe(id);
  });

  it('the groups the deploy notes describe hold, compared as literals', () => {
    // Three path spellings of one repository are three run ids.
    expect(runIdForOrigin('https://git.example.com/team/project.git')).toBe('88b53ae7afc6f781');
    expect(runIdForOrigin('https://git.example.com/team/project')).toBe('30774d330900e9dc');
    expect(runIdForOrigin('https://git.example.com/team/project/')).toBe('884bf3a568293c95');
    // A credential, host case and the default port leave an https id unchanged.
    expect(runIdForOrigin('https://x-access-token:secret@git.example.com/team/project.git')).toBe('88b53ae7afc6f781');
    expect(runIdForOrigin('https://GIT.example.com:443/team/project.git')).toBe('88b53ae7afc6f781');
    // ssh:// drops its user but keeps host case and a written port.
    expect(runIdForOrigin('ssh://other@git.example.com/team/project.git')).toBe('80a522b921e76c20');
    expect(runIdForOrigin('ssh://git@GIT.example.com/team/project.git')).toBe('a929f8abcff79ed4');
    expect(runIdForOrigin('ssh://git@git.example.com:22/team/project.git')).toBe('a52c4abb760e2b58');
    // An scp-like user changes the id; an scp-like address without a user has its host lowercased.
    expect(runIdForOrigin('git@git.example.com:team/project.git')).toBe('9245f0dda77f617c');
    expect(runIdForOrigin('other@git.example.com:team/project.git')).toBe('a93c1af9aa06b2a6');
    expect(runIdForOrigin('GIT.example.com:team/project.git')).toBe('430a03b607b6e432');
  });

  it('the repository path hash is frozen', () => {
    expect(runIdFor('/data/repo')).toBe('a960975d94094405');
  });

  it('the advisory lock key is frozen', () => {
    expect(runLockKey('88b53ae7afc6f781')).toBe('8850301660709999398');
  });
});
