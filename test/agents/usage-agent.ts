/**
 * A command-mode agent for the worker loop's usage tests: it never calls the API. Like fallback-agent.ts it appends a
 * README line, commits, and leaves a fallback submit in `.orchestrator/report.json`; then it prints a result object in
 * Claude Code's `--output-format json` shape as the last line of its standard output.
 * argv: <brief.json path> <taskId> <launchId> and any of
 *   no-cost    the object has num_turns and tokens and no total_cost_usd
 *   no-object  print text only, no object
 *   no-report  leave no report.json
 *   wait       commit nothing and leave no report: change README.md (uncommitted), print the object, record the pid
 *              (`pid`) and a ready marker (`ready`) in $USAGE_AGENT_DIR, a directory outside the clone, and wait for at
 *              most 60 seconds
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

const [briefPath, taskId, launchId, ...flags] = process.argv.slice(2) as [string, string, string, ...string[]];
const has = (f: string) => flags.includes(f);
const cwd = process.cwd();
const env = { ...process.env, GIT_AUTHOR_NAME: 'agent', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'agent', GIT_COMMITTER_EMAIL: 'a@x' };
const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
// Synchronous writes: piped stdout is asynchronous, and an exit right after could cut it.
const print = (text: string) => writeSync(1, text);

const usage = { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 7 };
const result = has('no-cost')
  ? { type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, num_turns: 2, result: 'done', usage }
  : { type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, duration_api_ms: 1000, num_turns: 2, result: 'done', total_cost_usd: 0.25, usage };

print(`the usage agent works on ${taskId}\n`);
if (has('wait')) {
  const dir = process.env['USAGE_AGENT_DIR'];
  if (!dir) throw new Error('USAGE_AGENT_DIR is required for wait');
  appendFileSync(path.join(cwd, 'README.md'), '- changed by the usage agent\n');
  print(`${JSON.stringify(result)}\n`);
  writeFileSync(path.join(dir, 'pid'), String(process.pid));
  writeFileSync(path.join(dir, 'ready'), '1');
  setTimeout(() => process.exit(0), 60_000);
} else {
  appendFileSync(path.join(cwd, 'README.md'), `- ${taskId} by the usage agent\n`);
  git('add', 'README.md');
  git('commit', '-q', '-m', `${taskId}: README line`);
  if (!has('no-report')) {
    const brief = JSON.parse(readFileSync(briefPath, 'utf8')) as { acceptanceCriteria?: string[] };
    const acceptance = (brief.acceptanceCriteria ?? []).map((_c, i) => ({ criterion: String(i + 1), evidence: 'usage agent' }));
    writeFileSync(path.join(cwd, '.orchestrator', 'report.json'), JSON.stringify({ launchId, seq: 1, kind: 'submit', body: { summary: `${taskId} by the usage agent`, acceptance } }));
  }
  print(has('no-object') ? 'done, and no result object\n' : `${JSON.stringify(result)}\n`);
}
