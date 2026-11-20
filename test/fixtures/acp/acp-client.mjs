#!/usr/bin/env node
// A small Agent Client Protocol (version 1) client, a probe tool (GH-197). One process, one agent, one session, one turn.
// JSON-RPC over the agent's stdio, newline-delimited, framed by hand so that every frame is visible. Node built-ins only.
//
//   node acp-client.mjs --agent-json '["opencode","acp","--pure"]' --cwd <dir> [--prompt-file <file>] [--mcp-json <file>]
//     [--policy <file>] [--frames <file>] [--client-capabilities <json>] [--turn-timeout-ms <n>] [--cancel-grace-ms <n>]
//     [--no-permission-answer] [--requests-json <file>]
//   node acp-client.mjs --self-test
//
// The agent is a child in the client's own process group (not detached) with the client's environment and working directory;
// whoever starts the client gives it its group, its environment and its directory. Every frame of both directions goes to the
// frames file as {"t","dir":"send"|"recv","msg"} (a non-JSON stdout line of the agent as {"t","dir":"recv","raw"}). Stdout gets
// one JSON object per line: initialized, session, update, permission, usage, result. The agent's stderr is copied to stderr.
// Without --prompt-file the client stops after session/new (and the extra requests) and exits 0.
// Exit codes: 0 end_turn (or no prompt), 2 another stop reason, 3 cancelled (SIGTERM/SIGINT), 4 an error of initialize,
// session/new or the prompt (or the agent exited first), 5 the turn time limit, 127 the agent could not be started.
// --policy: {"default":"reject"|"allow","allow":[{"kind"?,"title"?,"command"?}],"reject":[...]}: each field a glob (* and ?)
// matched against the request's toolCall.kind, toolCall.title and toolCall.rawInput.command; an entry matches when all its
// fields do. The answer is the offered option of kind allow_once or reject_once, never an *_always option; an allowed request
// with no allow_once is rejected, and with no reject_once offered the answer is cancelled.
// --requests-json: [{"when":"beforeSession"|"afterSession","method","params"}], "{sessionId}" in a string is filled in.
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXIT = { endTurn: 0, otherStop: 2, cancelled: 3, error: 4, timeout: 5, noAgent: 127 };

function parseArgs(argv) {
  const o = { cancelGraceMs: 5000, turnTimeoutMs: 600_000, permissionAnswer: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${a} needs a value`); return x; };
    if (a === '--agent-json') o.agent = JSON.parse(v());
    else if (a === '--cwd') o.cwd = v();
    else if (a === '--prompt-file') o.promptFile = v();
    else if (a === '--mcp-json') o.mcpFile = v();
    else if (a === '--policy') o.policyFile = v();
    else if (a === '--frames') o.frames = v();
    else if (a === '--client-capabilities') o.clientCapabilities = JSON.parse(v());
    else if (a === '--turn-timeout-ms') o.turnTimeoutMs = Number(v());
    else if (a === '--cancel-grace-ms') o.cancelGraceMs = Number(v());
    else if (a === '--no-permission-answer') o.permissionAnswer = false;
    else if (a === '--requests-json') o.requestsFile = v();
    else if (a === '--self-test') o.selfTest = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const globRe = (g) => new RegExp(`^${String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '.')}$`);
const matches = (entry, req) => Object.entries(entry).every(([k, g]) => req[k] !== undefined && globRe(g).test(String(req[k])));

/** The policy's answer to one session/request_permission: { optionId } or { cancelled }, with the decision. */
function decide(policy, params) {
  const tc = params?.toolCall ?? {};
  const raw = tc.rawInput ?? {};
  const req = { kind: tc.kind, title: tc.title, command: typeof raw.command === 'string' ? raw.command : Array.isArray(raw.command) ? raw.command.join(' ') : undefined };
  const rejected = (policy.reject ?? []).some((e) => matches(e, req));
  const allowed = !rejected && ((policy.allow ?? []).some((e) => matches(e, req)) || policy.default === 'allow');
  const options = params?.options ?? [];
  const once = (kind) => options.find((x) => x.kind === kind);
  const pick = allowed ? once('allow_once') ?? once('reject_once') : once('reject_once');
  return { request: req, decision: allowed ? 'allow' : 'reject', outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' }, kind: pick?.kind ?? null };
}

/** The pids under `root` (not `root` itself), from one ps listing. */
function descendants(root) {
  let rows;
  try { rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([pid, ppid, pgid, ...c]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), comm: c.join(' ').split('/').pop() })); } catch { return []; }
  const out = [];
  const walk = (p) => { for (const r of rows) if (r.ppid === p && r.pid !== process.pid) { out.push(r); walk(r.pid); } };
  walk(root);
  return out;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(o) {
  if (!Array.isArray(o.agent) || !o.agent.length) throw new Error('--agent-json must be a non-empty argv array');
  if (!o.cwd) throw new Error('--cwd is required');
  const t0 = Date.now();
  const out = (type, body) => process.stdout.write(JSON.stringify({ type, t: Date.now() - t0, ...body }) + '\n');
  const frame = (dir, entry) => { if (o.frames) appendFileSync(o.frames, JSON.stringify({ t: Date.now() - t0, dir, ...entry }) + '\n'); };
  const policy = o.policyFile ? JSON.parse(readFileSync(o.policyFile, 'utf8')) : { default: 'reject', allow: [] };
  const mcpServers = o.mcpFile ? JSON.parse(readFileSync(o.mcpFile, 'utf8')) : [];
  const extra = o.requestsFile ? JSON.parse(readFileSync(o.requestsFile, 'utf8')) : [];
  if (o.frames) writeFileSync(o.frames, '');

  let child;
  try {
    child = spawn(o.agent[0], o.agent.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    out('result', { error: `cannot start the agent: ${err.message}`, exitCode: EXIT.noAgent });
    return EXIT.noAgent;
  }
  const started = await new Promise((resolve) => { child.once('spawn', () => resolve(true)); child.once('error', (err) => resolve(err)); });
  if (started !== true) {
    out('result', { error: `cannot start the agent: ${started.message}`, code: started.code, exitCode: EXIT.noAgent });
    return EXIT.noAgent;
  }
  let exited = null;
  const exitP = new Promise((resolve) => child.once('exit', (code, signal) => { exited = { code, signal, t: Date.now() - t0 }; resolve(exited); }));
  child.stdin.on('error', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));

  let nextId = 0;
  const pending = new Map(); // id -> resolve
  const permissions = new Map(); // agent request id -> params (unanswered)
  const send = (msg) => { frame('send', { msg }); if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(msg) + '\n'); };
  const request = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
  const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  const onRequest = (msg) => {
    if (msg.method === 'session/request_permission') {
      const d = decide(policy, msg.params);
      out('permission', { id: msg.id, toolCall: msg.params?.toolCall, options: msg.params?.options, request: d.request, decision: o.permissionAnswer ? d.decision : 'unanswered', answer: o.permissionAnswer ? d.outcome : null, kind: o.permissionAnswer ? d.kind : null });
      if (o.permissionAnswer) respond(msg.id, { outcome: d.outcome });
      else permissions.set(msg.id, msg.params);
      return;
    }
    // No fs and no terminal capability is advertised, so every other request is refused.
    respondError(msg.id, -32601, `method not supported by this client: ${msg.method}`);
  };
  const onNotification = (msg) => {
    if (msg.method !== 'session/update') return;
    const u = msg.params?.update ?? {};
    if (u.sessionUpdate === 'usage_update') out('usage', { update: u });
    else out('update', { kind: u.sessionUpdate, ...(u.toolCallId ? { toolCallId: u.toolCallId } : {}), ...(u.title ? { title: u.title } : {}), ...(u.status ? { status: u.status } : {}), ...(u.kind ? { toolKind: u.kind } : {}) });
  };
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { frame('recv', { raw: line }); continue; }
      frame('recv', { msg });
      if (msg.method !== undefined && msg.id !== undefined) onRequest(msg);
      else if (msg.method !== undefined) onNotification(msg);
      else if (pending.has(msg.id)) { const r = pending.get(msg.id); pending.delete(msg.id); r(msg); }
    }
  });
  const orExit = (p) => Promise.race([p, exitP.then((e) => ({ exited: e }))]);

  /** Close the agent's stdin, wait the grace, then SIGTERM and SIGKILL what is left of its tree. */
  const finish = async (body, code) => {
    const tree = exited ? [] : descendants(child.pid);
    let how = exited ? 'before' : null;
    if (!exited) { child.stdin.end(); if (await Promise.race([exitP, sleep(o.cancelGraceMs).then(() => null)])) how = 'stdinClosed'; }
    if (!exited) { child.kill('SIGTERM'); if (await Promise.race([exitP, sleep(2000).then(() => null)])) how = 'sigterm'; }
    if (!exited) { child.kill('SIGKILL'); await exitP; how = 'sigkill'; }
    // What the agent started gets 2 s to end on its own once the agent is gone.
    for (let i = 0; i < 20 && tree.some((p) => alive(p.pid)); i++) await sleep(100);
    const killed = [];
    for (const p of tree) if (alive(p.pid)) { try { process.kill(p.pid, 'SIGTERM'); killed.push(p); } catch {} }
    if (killed.length) { await sleep(1000); for (const p of killed) if (alive(p.pid)) try { process.kill(p.pid, 'SIGKILL'); } catch {} }
    // treeAtEnd: the agent's process tree when the turn was over, before stdin was closed.
    out('result', { ...body, exitCode: code, agentPid: child.pid, agentExit: { ...exited, how }, treeAtEnd: tree, killedDescendants: killed });
    return code;
  };

  const init = await orExit(request('initialize', { protocolVersion: 1, clientCapabilities: o.clientCapabilities ?? { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'orch-acp-probe', version: '0.1.0' } }));
  if (init.exited || init.error) return finish({ stage: 'initialize', error: init.error ?? 'the agent exited before answering' }, EXIT.error);
  out('initialized', { protocolVersion: init.result?.protocolVersion, agentCapabilities: init.result?.agentCapabilities, authMethods: init.result?.authMethods, agentInfo: init.result?.agentInfo });
  const extras = async (when, sessionId) => {
    for (const r of extra.filter((x) => (x.when ?? 'afterSession') === when)) {
      const params = JSON.parse(JSON.stringify(r.params ?? {}).replaceAll('{sessionId}', sessionId ?? ''));
      const res = await orExit(request(r.method, params));
      out('extra', { method: r.method, ...(res.exited ? { exited: res.exited } : res.error ? { error: res.error } : { result: res.result }) });
    }
  };
  await extras('beforeSession');
  const sess = await orExit(request('session/new', { cwd: o.cwd, mcpServers }));
  if (sess.exited || sess.error) return finish({ stage: 'session/new', error: sess.error ?? 'the agent exited before answering' }, EXIT.error);
  const sessionId = sess.result?.sessionId;
  out('session', { sessionId, modes: sess.result?.modes, models: sess.result?.models, configOptions: sess.result?.configOptions });
  await extras('afterSession', sessionId);
  if (!o.promptFile) return finish({ stage: 'session/new', stopReason: null, noPrompt: true }, EXIT.endTurn);

  const prompt = readFileSync(o.promptFile, 'utf8');
  let stopping = null; // 'signal' | 'timeout'
  const cancel = (why) => {
    if (stopping) return;
    stopping = why;
    send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    for (const [id] of permissions) respond(id, { outcome: { outcome: 'cancelled' } });
    permissions.clear();
  };
  const turn = orExit(request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }));
  let stopNow;
  const stopped = new Promise((r) => { stopNow = r; });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { cancel('signal'); stopNow(sig); });
  const timer = setTimeout(() => { cancel('timeout'); stopNow('timeout'); }, o.turnTimeoutMs);
  const first = await Promise.race([turn, stopped.then((s) => ({ stop: s }))]);
  clearTimeout(timer);
  let answer = first;
  if (first.stop) answer = await Promise.race([turn, sleep(o.cancelGraceMs).then(() => ({ noAnswer: true }))]);
  const body = { stage: 'session/prompt', sessionId, ...(stopping ? { stoppedBy: stopping } : {}) };
  if (answer.noAnswer) body.error = `no answer to session/prompt within ${o.cancelGraceMs} ms of session/cancel`;
  else if (answer.exited) body.error = 'the agent exited before answering session/prompt';
  else if (answer.error) body.error = answer.error;
  else { body.stopReason = answer.result?.stopReason; if (answer.result?.usage) body.usage = answer.result.usage; }
  const code = stopping === 'signal' ? EXIT.cancelled : stopping === 'timeout' ? EXIT.timeout : body.error ? EXIT.error : body.stopReason === 'end_turn' ? EXIT.endTurn : body.stopReason === 'cancelled' ? EXIT.cancelled : EXIT.otherStop;
  return finish(body, code);
}

// ---- self-test against fake-acp-agent.mjs: no model, no installed CLI ----
async function selfTest() {
  const self = fileURLToPath(import.meta.url);
  const fake = path.join(HERE, 'fake-acp-agent.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-selftest-'));
  const failures = [];
  const lines = (s) => s.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const run = (scenario, extra = [], agent) => new Promise((resolve) => {
    const frames = path.join(dir, `${scenario}.frames.jsonl`);
    const pidFile = path.join(dir, `${scenario}.pids.json`);
    writeFileSync(path.join(dir, 'prompt.txt'), 'Say hello.');
    const args = [self, '--agent-json', JSON.stringify(agent ?? [process.execPath, fake, scenario, pidFile]), '--cwd', dir, '--prompt-file', path.join(dir, 'prompt.txt'), '--frames', frames, '--cancel-grace-ms', '1000', ...extra];
    const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    c.stdout.on('data', (d) => { stdout += d; if (scenario === 'hang-term' && stdout.includes('"type":"update"') && !c.sentTerm) { c.sentTerm = true; setTimeout(() => c.kill('SIGTERM'), 200); } });
    c.on('exit', (code) => resolve({ code, out: lines(stdout), frames: existsSync(frames) ? lines(readFileSync(frames, 'utf8')) : [], pids: existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, 'utf8')) : null }));
  });
  const check = (name, ok, detail) => { console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${detail ? `: ${detail}` : ''}`); if (!ok) failures.push(name); };
  const result = (r) => r.out.find((x) => x.type === 'result') ?? {};

  let r = await run('end-turn');
  check('a turn that ends end_turn (exit 0)', r.code === 0 && result(r).stopReason === 'end_turn', `exit ${r.code}`);
  check('the initialize request carries protocolVersion 1', r.frames[0]?.msg?.method === 'initialize' && r.frames[0].msg.params.protocolVersion === 1);
  check('usage_update is printed as a usage line', r.out.some((x) => x.type === 'usage' && x.update.used === 1200));

  const policy = path.join(dir, 'policy.json');
  writeFileSync(policy, JSON.stringify({ default: 'reject', allow: [{ kind: 'execute', command: 'uname *' }] }));
  r = await run('permission', ['--policy', policy]);
  const perms = r.out.filter((x) => x.type === 'permission');
  const answers = r.frames.filter((f) => f.dir === 'send' && f.msg.result?.outcome).map((f) => f.msg.result.outcome.optionId);
  check('one permission request allowed from the policy file (allow_once)', perms[0]?.decision === 'allow' && perms[0]?.kind === 'allow_once' && answers[0] === 'opt-allow-once', JSON.stringify(answers));
  check('one permission request rejected from the policy file (reject_once)', perms[1]?.decision === 'reject' && perms[1]?.kind === 'reject_once' && answers[1] === 'opt-reject-once');
  check('no *_always option chosen', answers.length === 2 && answers.every((a) => !/always/.test(a)) && r.code === 0, `exit ${r.code}`);

  r = await run('refusal');
  check('a stop reason refusal (exit 2)', r.code === 2 && result(r).stopReason === 'refusal', `exit ${r.code}`);
  r = await run('init-error');
  check('an initialize error (exit 4)', r.code === 4 && result(r).stage === 'initialize', `exit ${r.code}`);
  r = await run('hang', ['--turn-timeout-ms', '1500']);
  check('a turn past --turn-timeout-ms (exit 5)', r.code === 5 && r.frames.some((f) => f.msg?.method === 'session/cancel'), `exit ${r.code}`);
  r = await run('missing', [], [path.join(dir, 'no-such-agent')]);
  check('an agent command that does not exist (exit 127)', r.code === 127, `exit ${r.code}`);
  r = await run('hang-term');
  await sleep(300);
  const left = r.pids ? [r.pids.agent, r.pids.child].filter(alive) : ['no pid file'];
  const cancelAt = r.frames.findIndex((f) => f.msg?.method === 'session/cancel');
  check('SIGTERM during a turn: a session/cancel frame, then exit 3 with no process of the agent left', r.code === 3 && cancelAt >= 0 && left.length === 0, `exit ${r.code}, left ${JSON.stringify(left)}`);
  for (const pid of left) if (typeof pid === 'number') try { process.kill(pid, 'SIGKILL'); } catch {}
  rmSync(dir, { recursive: true, force: true });
  if (failures.length) { console.log(`acp-client self-test: ${failures.length} failed`); return 1; }
  console.log('acp-client self-test: ok');
  return 0;
}

const o = (() => { try { return parseArgs(process.argv.slice(2)); } catch (err) { process.stderr.write(`acp-client: ${err.message}\n`); process.exit(64); } })();
(o.selfTest ? selfTest() : main(o)).then((code) => process.exit(code), (err) => { process.stderr.write(`acp-client: ${err.stack ?? err}\n`); process.stdout.write(JSON.stringify({ type: 'result', error: String(err.message ?? err), exitCode: EXIT.error }) + '\n'); process.exit(EXIT.error); });
