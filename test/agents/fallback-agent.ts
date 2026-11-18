/**
 * A command-mode agent for the remote worker loop's tests: it never calls the API. It records where it ran and what
 * git saw there (one JSON line in $AGENT_LOG), appends a README line, commits without pushing, leaves untracked junk
 * behind, and writes `.orchestrator/report.json` for the loop to relay.
 * argv: <brief.json path> <taskId> <launchId>, filled by the loop's template substitution.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [briefPath, taskId, launchId] = process.argv.slice(2) as [string, string, string];
const brief = JSON.parse(readFileSync(briefPath, 'utf8')) as { acceptanceCriteria?: string[]; worktree?: string; launchId?: string };
const cwd = process.cwd();
const env = { ...process.env, GIT_AUTHOR_NAME: 'agent', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'agent', GIT_COMMITTER_EMAIL: 'a@x' };
const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

const log = process.env['AGENT_LOG'];
if (log) {
  appendFileSync(
    log,
    `${JSON.stringify({ taskId, launchId, cwd, briefWorktree: brief.worktree, briefLaunchId: brief.launchId, branch: git('rev-parse', '--abbrev-ref', 'HEAD').trim(), head: git('rev-parse', 'HEAD').trim(), status: git('status', '--porcelain', '--ignored').trim(), env: { ORCH_LAUNCH_ID: process.env['ORCH_LAUNCH_ID'], ORCH_WORKTREE: process.env['ORCH_WORKTREE'] } })}\n`,
  );
}
appendFileSync(path.join(cwd, 'README.md'), `- ${taskId} by the fallback agent\n`);
git('add', 'README.md');
git('commit', '-q', '-m', `${taskId}: README line`);
// Junk the next launch in this clone must not see: an untracked file, an untracked directory, and a modified tracked file left uncommitted.
writeFileSync(path.join(cwd, `junk-${taskId}.txt`), 'junk\n');
mkdirSync(path.join(cwd, 'junk-dir'), { recursive: true });
writeFileSync(path.join(cwd, 'junk-dir', 'x'), 'x\n');
appendFileSync(path.join(cwd, 'shared.txt'), 'uncommitted\n');
const acceptance = (brief.acceptanceCriteria ?? []).map((_c, i) => ({ criterion: String(i + 1), evidence: 'fallback agent' }));
// No sealedSha and no push: the loop pushes the branch and fills it from HEAD. A dirty tree does not matter to a remote seal.
writeFileSync(path.join(cwd, '.orchestrator', 'report.json'), JSON.stringify({ launchId, seq: 1, kind: 'submit', body: { summary: `${taskId} by the fallback agent`, acceptance } }));
