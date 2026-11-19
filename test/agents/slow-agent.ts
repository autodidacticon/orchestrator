/**
 * A command-mode agent for the worker loop's termination tests: it never calls the API. It does what its arguments say,
 * in order, then records its pid (`pid`) and a ready marker (`ready`) in $SLOW_AGENT_DIR, a directory outside the clone,
 * and waits for at most 60 seconds.
 * argv: any of
 *   modify      append a line to the tracked README.md (left uncommitted)
 *   untracked   write the untracked file new-file.txt
 *   commit      append a line to shared.txt and commit it; the sha goes to $SLOW_AGENT_DIR/commit
 *   lock        create .git/index.lock, so a later `git add` fails
 *   report      write a fallback submit to .orchestrator/report.json, one evidence entry per criterion
 *   ignore-term ignore SIGTERM
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.env['SLOW_AGENT_DIR'];
if (!dir) throw new Error('SLOW_AGENT_DIR is required');
const cwd = process.cwd();
const env = { ...process.env, GIT_AUTHOR_NAME: 'agent', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'agent', GIT_COMMITTER_EMAIL: 'a@x' };
const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

for (const step of process.argv.slice(2)) {
  if (step === 'modify') appendFileSync(path.join(cwd, 'README.md'), '- changed by the slow agent\n');
  else if (step === 'untracked') writeFileSync(path.join(cwd, 'new-file.txt'), 'new\n');
  else if (step === 'commit') {
    appendFileSync(path.join(cwd, 'shared.txt'), 'committed by the slow agent\n');
    git('add', 'shared.txt');
    git('commit', '-q', '-m', 'slow agent: shared line');
    writeFileSync(path.join(dir, 'commit'), git('rev-parse', 'HEAD'));
  } else if (step === 'lock') writeFileSync(path.join(cwd, '.git', 'index.lock'), '');
  else if (step === 'report') {
    const brief = JSON.parse(readFileSync(path.join(cwd, '.orchestrator', 'brief.json'), 'utf8')) as { acceptanceCriteria?: string[]; launchId?: string };
    const acceptance = (brief.acceptanceCriteria ?? []).map((_c, i) => ({ criterion: String(i + 1), evidence: 'slow agent' }));
    writeFileSync(path.join(cwd, '.orchestrator', 'report.json'), JSON.stringify({ launchId: brief.launchId, seq: 1, kind: 'submit', body: { summary: 'by the slow agent', acceptance } }));
  } else if (step === 'ignore-term') process.on('SIGTERM', () => undefined);
  else throw new Error(`unknown step ${step}`);
}
writeFileSync(path.join(dir, 'pid'), String(process.pid));
writeFileSync(path.join(dir, 'ready'), '1');
setTimeout(() => process.exit(0), 60_000);
