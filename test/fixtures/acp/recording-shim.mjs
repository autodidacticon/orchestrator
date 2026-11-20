#!/usr/bin/env node
// A recording stand-in for the orchestrator's MCP shim (GH-197): a stdio MCP server with the shim's five tools, their real
// names, descriptions and schemas (src/agent/mcp-shim.ts, as test/fixtures/opencode/brief-run/fake-shim.mjs has them). It
// never contacts a daemon.
//
//   node recording-shim.mjs <calls-file> [--block-sec <n>] [--orch-env-file <path>] [--marker <NAME>]
//
// At start it appends {"event":"start"} to the calls file with its argv, cwd, the names of its environment variables, the
// values of ORCH_LAUNCH_ID, ORCH_TOKEN, ORCH_API and of the marker variable (PROBE_MARKER unless --marker names another),
// where each ORCH_* value came from (env or the env file), and its parent chain (pid, ppid, pgid, command name). Then it
// appends every MCP request ({"event":"request"}) and every tool call ({"event":"call"}). `block` is answered after
// --block-sec seconds (default 75); the other tools at once. --orch-env-file layers KEY=VALUE lines over the environment, as
// the real shim's envWithFile does.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const callsFile = argv[0];
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const blockSec = Number(opt('--block-sec', '75'));
const marker = opt('--marker', 'PROBE_MARKER');
const envFile = opt('--orch-env-file');
const rec = (o) => appendFileSync(callsFile, JSON.stringify({ t: Date.now(), pid: process.pid, ...o }) + '\n');

const fromFile = {};
let envFileError;
if (envFile) {
  try {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (m) fromFile[m[1]] = m[2];
    }
  } catch (err) { envFileError = err.code ?? String(err); }
}
const SHOWN = ['ORCH_LAUNCH_ID', 'ORCH_TOKEN', 'ORCH_API'];
const values = {};
for (const k of [...SHOWN, marker]) {
  if (fromFile[k] !== undefined) values[k] = { value: fromFile[k], source: 'envFile', ...(process.env[k] !== undefined ? { envValue: process.env[k] } : {}) };
  else if (process.env[k] !== undefined) values[k] = { value: process.env[k], source: 'env' };
}
let chain = [];
try {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8' }).split('\n').map((l) => l.trim().split(/\s+/)).filter((r) => r.length >= 4);
  const byPid = new Map(rows.map(([pid, ppid, pgid, ...comm]) => [Number(pid), { ppid: Number(ppid), pgid: Number(pgid), comm: comm.join(' ').split('/').pop() }]));
  for (let pid = process.pid; pid > 1 && chain.length < 8; ) { const p = byPid.get(pid); if (!p) break; chain.push({ pid, ppid: p.ppid, pgid: p.pgid, comm: p.comm }); pid = p.ppid; }
} catch (err) { chain = [{ error: String(err) }]; }
rec({ event: 'start', argv: process.argv.slice(1), cwd: process.cwd(), envNames: Object.keys(process.env).sort(), values, ...(envFile ? { envFile, envFileError } : {}), chain });
if (envFileError) { process.stderr.write(`--orch-env-file ${envFile}: cannot read the shim env file (${envFileError})\n`); process.exit(1); }

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], isError: false });
const str = { type: 'string' };
const strs = { type: 'array', items: str };
const tools = [
  { name: 'heartbeat', description: 'Renew the lease and report progress; a changed progress text counts as progress for stuck detection.', inputSchema: { type: 'object', properties: { progress: str } } },
  { name: 'report', description: 'Final report. kind=submit requires a committed, clean worktree; kind=fail gives up. seq must increase per call.', inputSchema: { type: 'object', properties: { seq: { type: 'integer', minimum: 0 }, kind: { type: 'string', enum: ['submit', 'fail'] }, summary: str, interfaces: strs, decisions: strs, deviations: strs, followUps: strs, tests: strs, acceptance: { type: 'array', items: { type: 'object', properties: { criterion: str, evidence: str }, required: ['criterion', 'evidence'] } }, noChanges: { type: 'object', properties: { justification: str } }, proposals: { type: 'array', description: 'Follow-up tasks you discovered; a human accepts them into the graph. followUps stays free text.', items: { type: 'object', properties: { title: str, description: str, acceptanceCriteria: strs, deps: strs, scope: strs, labels: strs }, required: ['title', 'description', 'acceptanceCriteria'] } }, tried: str, why: str, whatWouldUnblock: str }, required: ['seq', 'kind'] } },
  { name: 'block', description: 'Ask a human a question and wait for the answer. Returns {answer} or {timeout:true}.', inputSchema: { type: 'object', properties: { seq: { type: 'integer', minimum: 0 }, kind: { type: 'string', enum: ['needsDecision', 'needsAccess', 'impossible', 'dependencyCancelled', 'outOfScope', 'insufficientSpec', 'milestoneRejected'] }, message: str, options: strs }, required: ['seq', 'kind', 'message'] } },
  { name: 'inbox', description: 'Fetch pending notices from the orchestrator: stuck (no progress observed), nudge (a message from the operator), baseMoved (the integration branch advanced; head and files). Check after long steps.', inputSchema: { type: 'object', properties: {} } },
  { name: 'log', description: 'Append a log line to the launch log.', inputSchema: { type: 'object', properties: { text: str, seq: { type: 'integer' } }, required: ['text'] } },
];
const ANSWER = 'Name the file greeting.txt and write exactly this line into it: hello from opencode';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const { id, method, params } = m;
    if (method !== 'tools/call') rec({ event: 'request', method, ...(method === 'initialize' ? { params } : {}) });
    if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'orchestrator-agent-api', version: '0.7.0' } } });
    else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools } });
    else if (method === 'tools/call') {
      const name = params?.name;
      const a = params?.arguments ?? {};
      rec({ event: 'call', tool: name, args: a });
      if (name === 'block') setTimeout(() => { rec({ event: 'answered', tool: name }); send({ jsonrpc: '2.0', id, result: text({ status: 200, answer: ANSWER }) }); }, blockSec * 1000);
      else if (name === 'report') send({ jsonrpc: '2.0', id, result: text({ status: 202, accepted: true, seq: a.seq }) });
      else if (name === 'inbox') send({ jsonrpc: '2.0', id, result: text({ status: 200, notices: [] }) });
      else send({ jsonrpc: '2.0', id, result: text({ status: 200, ok: true }) });
    } else if (method === 'ping') send({ jsonrpc: '2.0', id, result: {} });
    else if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
process.stdin.on('end', () => { rec({ event: 'stdinClosed' }); process.exit(0); });
process.on('SIGTERM', () => { rec({ event: 'signal', signal: 'SIGTERM' }); process.exit(143); });
