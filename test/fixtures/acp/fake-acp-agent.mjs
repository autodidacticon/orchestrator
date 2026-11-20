#!/usr/bin/env node
// A scripted ACP agent for acp-client.mjs --self-test: node fake-acp-agent.mjs <scenario> <pid-file>.
// Scenarios: end-turn, permission, refusal, init-error, hang (never answers the prompt until session/cancel), hang-term (the
// same, with a child process of its own that it leaves running). It writes {agent, child} to the pid file.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [scenario, pidFile] = process.argv.slice(2);
let child;
if (scenario === 'hang-term') {
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}
if (pidFile) writeFileSync(pidFile, JSON.stringify({ agent: process.pid, child: child?.pid ?? null }));
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
let promptId = null;
const options = [
  { optionId: 'opt-allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'opt-reject-once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'opt-reject-always', name: 'Always reject', kind: 'reject_always' },
];

async function onPrompt(id, params) {
  const s = params.sessionId;
  promptId = id;
  update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } });
  if (scenario === 'permission') {
    for (const command of ['uname -s', 'rm -rf build']) {
      update(s, { sessionUpdate: 'tool_call', toolCallId: command, title: command, kind: 'execute', status: 'pending', rawInput: { command } });
      const r = await ask('session/request_permission', { sessionId: s, toolCall: { toolCallId: command, title: command, kind: 'execute', rawInput: { command } }, options });
      update(s, { sessionUpdate: 'tool_call_update', toolCallId: command, status: r.result?.outcome?.optionId === 'opt-allow-once' ? 'completed' : 'failed' });
    }
  }
  if (scenario === 'hang' || scenario === 'hang-term') return; // answered on session/cancel
  update(s, { sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0, currency: 'USD' } });
  send({ jsonrpc: '2.0', id, result: { stopReason: scenario === 'refusal' ? 'refusal' : 'end_turn' } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.method === undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); continue; }
    if (m.method === 'initialize') {
      if (scenario === 'init-error') send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'scripted initialize failure' } });
      else send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } });
    } else if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'fake-session-1' } });
    else if (m.method === 'session/prompt') void onPrompt(m.id, m.params);
    else if (m.method === 'session/cancel') { if (promptId !== null) send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } }); }
    else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
  }
});
process.stdin.on('end', () => process.exit(0));
