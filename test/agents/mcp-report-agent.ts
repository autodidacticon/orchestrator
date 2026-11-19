/**
 * A command-mode agent for the remote worker loop's tests that reports as a Claude agent would: it reads the MCP
 * config the loop wrote (the `{mcpConfig}` slot), starts the `orchestrator` server it names as an MCP client does (its
 * command, args and env over the agent's environment), appends a README line, commits without pushing, and calls the
 * `report` tool with kind submit. It logs what it saw as one JSON line in $AGENT_LOG before the call, prints the tool's
 * answer to stderr, and exits 1 when the submit was not accepted.
 * argv: <mcp.json path> <brief.json path> <taskId>, filled by the loop's template substitution.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [mcpPath, briefPath, taskId] = process.argv.slice(2) as [string, string, string];
const config = JSON.parse(readFileSync(mcpPath, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
const server = config.mcpServers['orchestrator']!;
const brief = JSON.parse(readFileSync(briefPath, 'utf8')) as { acceptanceCriteria?: string[] };
const cwd = process.cwd();
const env = { ...process.env, GIT_AUTHOR_NAME: 'agent', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'agent', GIT_COMMITTER_EMAIL: 'a@x' };
const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

appendFileSync(path.join(cwd, 'README.md'), `- ${taskId} by the MCP report agent\n`);
git('add', 'README.md');
git('commit', '-q', '-m', `${taskId}: README line`);
const head = git('rev-parse', 'HEAD').trim();

const log = process.env['AGENT_LOG'];
if (log) appendFileSync(log, `${JSON.stringify({ taskId, cwd, head, mcpPath, shimEnv: server.env })}\n`);

const client = new Client({ name: 'mcp-report-agent', version: '0' });
await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...(process.env as Record<string, string>), ...server.env }, stderr: 'inherit' }));
try {
  const acceptance = (brief.acceptanceCriteria ?? []).map((_c, i) => ({ criterion: String(i + 1), evidence: 'MCP report agent' }));
  const r = (await client.callTool({ name: 'report', arguments: { seq: 1, kind: 'submit', summary: `${taskId} by the MCP report agent`, acceptance } })) as { content: Array<{ text: string }> };
  const answer = r.content[0]!.text;
  process.stderr.write(`mcp-report-agent report: ${answer}\n`);
  process.exitCode = (JSON.parse(answer) as { accepted?: boolean }).accepted === true ? 0 : 1;
} finally {
  await client.close().catch(() => undefined);
}
