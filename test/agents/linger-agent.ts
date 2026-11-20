/**
 * A command-mode agent for the worker loop's revoked-launch tests: it appends a README line, commits, pushes HEAD to the
 * launch branch (the clone's checked-out branch), and submits over HTTP with ORCH_API, ORCH_LAUNCH_ID and ORCH_TOKEN,
 * one evidence entry per acceptance criterion. It records its pid (`pid`) and the submit's answer (`submitted`) in
 * $LINGER_AGENT_DIR, a directory outside the clone, and then waits up to 60 seconds.
 * argv: optionally
 *   print   500 ms after the submit, print a Claude Code result object as the last line of standard output and exit 0
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

const dir = process.env['LINGER_AGENT_DIR'];
if (!dir) throw new Error('LINGER_AGENT_DIR is required');
const api = process.env['ORCH_API'];
const launchId = process.env['ORCH_LAUNCH_ID'];
const token = process.env['ORCH_TOKEN'];
if (!api || !launchId || !token) throw new Error('ORCH_API, ORCH_LAUNCH_ID and ORCH_TOKEN are required');
const print = process.argv.slice(2).includes('print');
const cwd = process.cwd();
const env = { ...process.env, GIT_AUTHOR_NAME: 'agent', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'agent', GIT_COMMITTER_EMAIL: 'a@x' };
const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

writeFileSync(path.join(dir, 'pid'), String(process.pid));
appendFileSync(path.join(cwd, 'README.md'), '- by the linger agent\n');
git('add', 'README.md');
git('commit', '-q', '-m', 'linger agent: README line');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
const sealedSha = git('rev-parse', 'HEAD');
const brief = JSON.parse(readFileSync(path.join(cwd, '.orchestrator', 'brief.json'), 'utf8')) as { acceptanceCriteria?: string[] };
const acceptance = (brief.acceptanceCriteria ?? []).map((_c, i) => ({ criterion: String(i + 1), evidence: 'linger agent' }));
const res = await fetch(`${api}/v1/launches/${launchId}/report`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ seq: 1, kind: 'submit', summary: 'by the linger agent', sealedSha, acceptance }),
});
writeFileSync(path.join(dir, 'submitted'), `${res.status} ${await res.text()}`);
if (print) {
  const usage = { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 7 };
  const result = { type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, duration_api_ms: 1000, num_turns: 2, result: 'done', total_cost_usd: 0.25, usage };
  setTimeout(() => {
    // Synchronous: piped stdout is asynchronous, and the exit right after could cut it.
    writeSync(1, `${JSON.stringify(result)}\n`);
    process.exit(0);
  }, 500);
} else setTimeout(() => process.exit(0), 60_000);
