// Tiny stdio MCP server: one tool that (1) writes a file OUTSIDE the worktree,
// (2) GETs a local HTTP listener, (3) runs `git commit` in the worktree from
// this (MCP server) process, and reports its own environment. Decides whether
// Codex sandboxes MCP server processes.
import { McpServer } from '/Users/richard/git/orchestrator/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { StdioServerTransport } from '/Users/richard/git/orchestrator/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import { writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';

const OUT = process.env.PROBE_OUT;      // outside.txt path
const WT = process.env.PROBE_WT;        // worktree path
const URL = process.env.PROBE_URL;      // local http listener
const LOG = process.env.PROBE_LOG;      // server-side log

function log(s) { try { appendFileSync(LOG, s + '\n'); } catch {} }
log(`server start pid=${process.pid} ppid=${process.ppid} cwd=${process.cwd()} uid=${process.getuid?.()}`);
log('CODEX env: ' + JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /CODEX|SANDBOX|SEATBELT|ORCH/i.test(k)))));
log('env keys: ' + Object.keys(process.env).sort().join(','));

const server = new McpServer({ name: 'probe', version: '0.0.1' });
server.registerTool('probe_write', { description: 'Write the probe marker file and report. Call exactly once.', inputSchema: {} }, async () => {
  const r = {};
  try { writeFileSync(OUT, `written by mcp server pid=${process.pid} at ${new Date().toISOString()}\n`); r.outsideWrite = 'ok'; } catch (e) { r.outsideWrite = 'ERR ' + e.message; }
  try { writeFileSync('/private/tmp/claude-501/probe-tmp-marker.txt', 'x'); r.tmpWrite = 'ok'; } catch (e) { r.tmpWrite = 'ERR ' + e.message; }
  r.http = await new Promise((res) => {
    const req = http.get(URL, (resp) => { resp.resume(); res('ok status=' + resp.statusCode); });
    req.on('error', (e) => res('ERR ' + e.message));
    req.setTimeout(3000, () => { req.destroy(); res('ERR timeout'); });
  });
  try {
    writeFileSync(`${WT}/mcp-committed.txt`, 'committed from the MCP server process\n');
    execFileSync('git', ['-C', WT, 'add', 'mcp-committed.txt'], { stdio: 'pipe' });
    const out = execFileSync('git', ['-C', WT, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-q', '-m', 'probe: commit from MCP server process'], { stdio: 'pipe' }).toString();
    r.gitCommit = 'ok ' + execFileSync('git', ['-C', WT, 'rev-parse', '--short', 'HEAD']).toString().trim() + ' ' + out.trim();
  } catch (e) { r.gitCommit = 'ERR ' + (e.stderr?.toString() || e.message); }
  r.pid = process.pid; r.ppid = process.ppid; r.cwd = process.cwd();
  log('tool result: ' + JSON.stringify(r));
  return { content: [{ type: 'text', text: JSON.stringify(r) }] };
});
await server.connect(new StdioServerTransport());
