#!/usr/bin/env node
// Probe: what codex-cli does with a plugin's hooks/hooks.json and .mcp.json (ORC-81).
// Builds a scratch marketplace holding one plugin, "probe", whose hooks and MCP server
// record their argv, cwd, environment and process ancestry; installs it into a scratch
// CODEX_HOME; runs codex with a minimal environment; and prints every record as JSON
// (results.json beside this file). Usage: node probe.mjs [model] > results.json
// The exec steps need ChatGPT or API-key auth: auth.json is copied from $CODEX_HOME or ~/.codex.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const model = process.argv[2] ?? 'gpt-6-astra';
const scratch = mkdtempSync(path.join(tmpdir(), 'orch-plugin-probe-'));
const market = path.join(scratch, 'market');
const src = path.join(market, 'plugins', 'probe');
const codexHome = path.join(scratch, 'codex-home');
const emptyHome = path.join(scratch, 'codex-home-empty');
const out = path.join(scratch, 'records.jsonl');
const work = path.join(scratch, 'work');
for (const d of [path.join(market, '.agents', 'plugins'), path.join(src, '.codex-plugin'), path.join(src, 'hooks'), codexHome, emptyHome, work]) mkdirSync(d, { recursive: true });

// Values are recorded only for these names; every other variable is recorded by name.
const SHOWN = ['PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CODEX_PLUGIN_ROOT', 'CODEX_HOME', 'ORCH_HOME', 'ORCH_URL', 'PROBE_EXTRA'];
const recorder = `
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const label = process.argv[2];
const shown = new Set(${JSON.stringify(SHOWN)});
const env = Object.fromEntries(Object.keys(process.env).sort().map((k) => [k, shown.has(k) ? process.env[k] : '<set>']));
const ps = execFileSync('ps', ['-axo', 'pid=,ppid=,comm=']).toString().split('\\n').map((l) => l.trim().split(/\\s+/)).filter((p) => p.length >= 3);
const byPid = new Map(ps.map(([pid, ppid, ...comm]) => [Number(pid), { ppid: Number(ppid), comm: comm.join(' ') }]));
const chain = [];
for (let pid = process.pid; pid > 1 && chain.length < 3; ) { const p = byPid.get(pid); if (!p) break; chain.push({ pid, comm: p.comm.split('/').pop() }); pid = p.ppid; }
const stdin = label.startsWith('hook') ? readFileSync(0, 'utf8') : '';
appendFileSync(${JSON.stringify(out)}, JSON.stringify({ label, argv: process.argv.slice(3), cwd: process.cwd(), env, stdin, chain }) + '\\n');
if (label === 'hook-start') process.stdout.write('PROBE-SESSION-START-LINE\\n');
if (label === 'mcp') {
  // A minimal MCP server: answers initialize and tools/list, then idles until stdin closes.
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === undefined) continue;
      const result = m.method === 'initialize' ? { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '0' } } : m.method === 'tools/list' ? { tools: [] } : {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    }
  });
}
`;
writeFileSync(path.join(src, 'record.mjs'), recorder);
writeFileSync(path.join(market, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'probe-market', plugins: [{ name: 'probe', source: { source: 'local', path: './plugins/probe' }, policy: { installation: 'AVAILABLE' }, category: 'Developer Tools' }] }, null, 2));
writeFileSync(path.join(src, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'probe', version: '0.0.1', description: 'probe', mcpServers: './.mcp.json', hooks: './hooks/hooks.json' }, null, 2));
// The MCP server forwards the variables the orchestrator plugin forwards, plus the candidates ORCH_URL and CODEX_HOME.
writeFileSync(path.join(src, '.mcp.json'), JSON.stringify({ mcpServers: { probe_server: { command: 'node', args: ['./record.mjs', 'mcp'], cwd: '.', env_vars: ['PATH', 'HOME', 'ORCH_HOME', 'ORCH_URL', 'CODEX_HOME'] } } }, null, 2));
// The shape hosts/codex/hooks/hooks.json uses. The second SessionStart hook passes ${PLUGIN_ROOT}
// double- and single-quoted, so its argv shows whether codex substitutes it before the shell runs.
const abs = path.join(src, 'record.mjs');
writeFileSync(path.join(src, 'hooks', 'hooks.json'), JSON.stringify({
  description: 'probe',
  hooks: {
    SessionStart: [{ matcher: 'startup|resume|clear', hooks: [
      { type: 'command', command: 'node "${PLUGIN_ROOT}/record.mjs" hook-start plugin-root-form', timeout: 10 },
      { type: 'command', command: `node "${abs}" hook-start-quoting "\${PLUGIN_ROOT}" '\${PLUGIN_ROOT}'`, timeout: 10 },
    ] }],
    // hooks/list shows each hook's effective timeoutSec: the first declares none, the second 5.
    SessionEnd: [{ hooks: [
      { type: 'command', command: 'node "${PLUGIN_ROOT}/record.mjs" hook-end plugin-root-form' },
      { type: 'command', command: 'node "${PLUGIN_ROOT}/record.mjs" hook-end-timeout-5 plugin-root-form', timeout: 5 },
    ] }],
  },
}, null, 2));

const auth = path.join(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), 'auth.json');
if (existsSync(auth)) copyFileSync(auth, path.join(codexHome, 'auth.json'));
// A minimal environment, so the records hold nothing from the caller's. PROBE_EXTRA is in no env_vars list.
const base = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const env = { ...base, CODEX_HOME: codexHome, ORCH_HOME: path.join(scratch, 'orch-home'), ORCH_URL: 'http://127.0.0.1:9/probe-url', PROBE_EXTRA: 'from-codex-env' };
const run = (args, opts = {}) => {
  const r = spawnSync('codex', args, { env, cwd: work, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  return { args, code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const records = () => {
  const lines = existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  rmSync(out, { force: true });
  return lines;
};
const tail = (s, n = 1500) => (s.length > n ? `...${s.slice(-n)}` : s);
const has = (s) => s.includes('PROBE-SESSION-START-LINE');

/** codex app-server over stdio: initialize, then each request in turn; returns the responses. */
async function appServer(requests) {
  const child = spawn('codex', ['app-server'], { env, cwd: work, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); setTimeout(() => resolve({ timeout: method }), 30_000); });
  await call('initialize', { clientInfo: { name: 'orch-probe', title: 'orch-probe', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
  const responses = [];
  for (const [method, params] of requests) responses.push({ method, params, response: await call(method, typeof params === 'function' ? params(responses) : params) });
  child.kill();
  return responses;
}

execFileSync('git', ['init', '-q'], { cwd: work });
const steps = [];
// The session's rollout files: the lines that hold the SessionStart hook's output.
const sessions = path.join(codexHome, 'sessions');
const rolloutLines = () => {
  const found = [];
  const walk = (d) => { for (const e of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else found.push(...readFileSync(p, 'utf8').split('\n').filter(has)); } };
  walk(sessions);
  rmSync(sessions, { recursive: true, force: true });
  return found.map((l) => JSON.parse(l));
};
const step = (name, args, opts) => {
  const r = run(args, opts);
  steps.push({ name, args: r.args, code: r.code, startLineInStdout: has(r.stdout), startLineInStderr: has(r.stderr), startLineInRollout: rolloutLines(), stdout: tail(r.stdout), stderr: tail(r.stderr), records: records() });
};
step('marketplace add', ['plugin', 'marketplace', 'add', market]);
step('plugin add', ['plugin', 'add', 'probe@probe-market']);
// Not --ephemeral: the rollout under CODEX_HOME/sessions records what the hooks added to the context.
const execArgs = (extra) => ['exec', ...extra, '--json', '--skip-git-repo-check', '-m', model, '-c', 'model_reasoning_effort="low"', '-s', 'read-only', 'Reply with only the word ok.'];
steps.push({ name: 'app-server hooks/list before trust', responses: await appServer([['hooks/list', { cwds: [work] }]]), records: records() });
step('exec, hooks untrusted', execArgs([]));
step('exec --dangerously-bypass-hook-trust', execArgs(['--dangerously-bypass-hook-trust']));
step('debug prompt-input --dangerously-bypass-hook-trust', ['--dangerously-bypass-hook-trust', 'debug', 'prompt-input', 'hi']);
// What the TUI's hook review writes (config/batchWrite of hooks.state."<key>".trusted_hash), done through the same app-server API.
const trust = await appServer([
  ['hooks/list', { cwds: [work] }],
  ['config/batchWrite', (prev) => ({ edits: (prev[0].response.result?.data ?? []).flatMap((e) => e.hooks).filter((h) => h.source === 'plugin').map((h) => ({ keyPath: `hooks.state.${JSON.stringify(h.key)}.trusted_hash`, mergeStrategy: 'upsert', value: h.currentHash })) })],
  ['hooks/list', { cwds: [work] }],
]);
steps.push({ name: 'app-server trust the plugin hooks', responses: trust, config: readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), records: records() });
step('exec, hooks trusted in config.toml', execArgs([]));
// What a codex worker started from the MCP server's environment authenticates with: codex exec
// in a CODEX_HOME without auth.json, given each key variable (fake keys, so the API's 401 names
// the key codex sent), and codex exec in the CODEX_HOME that holds auth.json.
const auth401 = (name, home, extra) => {
  const r = spawnSync('codex', ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-m', model, 'Reply with only the word ok.'], { env: { ...base, CODEX_HOME: home, ...extra }, cwd: work, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = (r.stdout ?? '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  const last = events.filter((e) => e.type === 'turn.failed' || e.type === 'turn.completed' || e.type === 'error').at(-1);
  steps.push({ name, code: r.status, last: last?.error?.message?.slice(0, 160) ?? last?.message?.slice(0, 160) ?? last?.type, stderr: tail(r.stderr ?? '', 300) });
};
auth401('worker auth: CODEX_HOME without auth.json, no key', emptyHome, {});
auth401('worker auth: CODEX_HOME without auth.json, OPENAI_API_KEY', emptyHome, { OPENAI_API_KEY: 'sk-probe-openai-0000' });
auth401('worker auth: CODEX_HOME without auth.json, CODEX_API_KEY', emptyHome, { CODEX_API_KEY: 'sk-probe-codex-0000' });
auth401('worker auth: CODEX_HOME with auth.json', codexHome, {});

const redact = (v) => JSON.parse(JSON.stringify(v).replaceAll(`/private${scratch}`, '<scratch>').replaceAll(scratch, '<scratch>').replaceAll(homedir(), '~'));
process.stdout.write(JSON.stringify(redact({ codex: execFileSync('codex', ['--version']).toString().trim(), model, steps }), null, 2) + '\n');
rmSync(scratch, { recursive: true, force: true });
