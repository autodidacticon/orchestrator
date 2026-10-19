// Fake orchestrator shim: the five agent tools with the real descriptions; every call appended to argv[2]; block waits argv[3] seconds.
import { appendFileSync } from 'node:fs';
const callsFile = process.argv[2]; const blockSec = Number(process.argv[3] ?? 70);
const rec = (o) => appendFileSync(callsFile, JSON.stringify({ t: Date.now(), ...o }) + '\n');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const str = { type: 'string' }; const strs = { type: 'array', items: str };
const tools = [
  { name: 'heartbeat', description: 'Renew the lease and report progress; a changed progress text counts as progress for stuck detection.', inputSchema: { type: 'object', properties: { progress: str } } },
  { name: 'report', description: 'Final report. kind=submit requires a committed, clean worktree; kind=fail gives up. seq must increase per call.', inputSchema: { type: 'object', properties: { seq: { type: 'integer', minimum: 0 }, kind: { type: 'string', enum: ['submit', 'fail'] }, summary: str, interfaces: strs, decisions: strs, deviations: strs, followUps: strs, tests: strs, acceptance: { type: 'array', items: { type: 'object', properties: { criterion: str, evidence: str }, required: ['criterion', 'evidence'] } }, noChanges: { type: 'object', properties: { justification: str } }, tried: str, why: str, whatWouldUnblock: str }, required: ['seq', 'kind'] } },
  { name: 'block', description: 'Ask a human a question and wait for the answer. Returns {answer} or {timeout:true}.', inputSchema: { type: 'object', properties: { seq: { type: 'integer', minimum: 0 }, kind: { type: 'string', enum: ['needsDecision', 'needsAccess', 'impossible', 'dependencyCancelled', 'outOfScope', 'insufficientSpec', 'milestoneRejected'] }, message: str, options: strs }, required: ['seq', 'kind', 'message'] } },
  { name: 'inbox', description: 'Fetch pending notices from the orchestrator: stuck (no progress observed), nudge (a message from the operator), baseMoved (the integration branch advanced; head and files). Check after long steps.', inputSchema: { type: 'object', properties: {} } },
  { name: 'log', description: 'Append a log line to the launch log.', inputSchema: { type: 'object', properties: { text: str, seq: { type: 'integer' } }, required: ['text'] } },
];
let buf = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } const { id, method, params } = m;
  if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'orchestrator-agent-api', version: '0.4.0' } } });
  else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools } });
  else if (method === 'tools/call') { const name = params?.name; const a = params?.arguments ?? {}; rec({ tool: name, args: a });
    if (name === 'block') setTimeout(() => send({ jsonrpc: '2.0', id, result: text({ status: 200, answer: 'Name the file greeting.txt and write exactly this line into it: hello from opencode' }) }), blockSec * 1000);
    else if (name === 'report') send({ jsonrpc: '2.0', id, result: text({ status: 202, accepted: true, seq: a.seq }) });
    else if (name === 'inbox') send({ jsonrpc: '2.0', id, result: text({ status: 200, notices: [] }) });
    else send({ jsonrpc: '2.0', id, result: text({ status: 200, ok: true }) }); }
  else if (method === 'ping') send({ jsonrpc: '2.0', id, result: {} });
  else if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } }); } });
