#!/usr/bin/env node
// Probe (GH-197): Agent Client Protocol against OpenCode. Drives `opencode acp` with ../acp-client.mjs and ../recording-shim.mjs
// through the runs S0..S9 of the task, keeps every frame, and writes results.json beside this file.
//
//   node probe.mjs --run S0,S1,...   run those scenarios (each in a fresh scratch directory), write their evidence and
//                                    records/<run>.json at once, then rebuild results.json
//   node probe.mjs --assemble        rebuild results.json from records/ and the answers below (no model, no opencode)
//   node probe.mjs --check           check results.json and its evidence files (no model, no opencode); exit 1 naming a question
//
// Every CLI runs here, with a hard time limit, as a detached child that leads its own process group; at the limit the script
// signals that group and nothing else. Children get a short environment built here (PATH, HOME, USER, LANG, TMPDIR, the
// XDG_* directories under the scratch directory, the three fake ORCH_* values and the marker), never the caller's. The
// scratch directory lives under the real path of os.tmpdir() and is removed in an exit handler. Evidence is redacted:
// the scratch directory becomes <scratch>, the home directory ~, every git identity Fixture Author <author@example.invalid>.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACP = path.dirname(HERE);
const CLIENT = path.join(ACP, 'acp-client.mjs');
const SHIM = path.join(ACP, 'recording-shim.mjs');
const RESULTS = path.join(HERE, 'results.json');
const RECORDS = path.join(HERE, 'records');
const MODEL = 'opencode/big-pickle';
const HOME = homedir();
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- redaction
let scratchRoots = [];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IDENTITY = /^(\s*(?:Author|Commit|Committer|Signed-off-by|Co-Authored-By):\s*)[^<\n]*?(\s*<|$)/gim;
const ANSI = /\x1b\[[0-9;]*m/g;
function redactString(s) {
  let out = s.replace(ANSI, '');
  for (const root of scratchRoots) out = out.split(root).join('<scratch>');
  out = out.split(REPO).join('<repo>');
  out = out.split(HOME).join('~');
  out = out.replace(IDENTITY, (_, a, b) => `${a}Fixture Author${b}`).replace(EMAIL, 'author@example.invalid');
  return out;
}
function redact(v) {
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactString(k), redact(x)]));
  return v;
}
/** A JSONL text redacted line by line: decoded, redacted, encoded again; a non-JSON line as a string. */
const redactJsonl = (text) => text.split('\n').map((l) => { if (!l.trim()) return l; try { return JSON.stringify(redact(JSON.parse(l))); } catch { return redactString(l); } }).join('\n');

// ---------------------------------------------------------------- user configuration hashes
function hashTree(root) {
  const out = {};
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (e.isFile()) out[p] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}
const USER_CONFIG = path.join(HOME, '.config', 'opencode');

// ---------------------------------------------------------------- scratch
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.invalid', GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'author@example.invalid' } });
}
function makeScratch() {
  const scratch = mkdtempSync(path.join(realpathSync(tmpdir()), 'acp-probe-'));
  scratchRoots = [...new Set([scratch, scratch.replace(/^\/private/, ''), ...scratchRoots])].sort((a, b) => b.length - a.length);
  const repo = path.join(scratch, 'repo');
  mkdirSync(repo);
  mkdirSync(path.join(scratch, 'home'));
  git(repo, 'init', '-q', '-b', 'main');
  // The repository's own identity, so the agent's commits never take the user's (the linked worktree shares this config).
  git(repo, 'config', 'user.name', 'Fixture Author');
  git(repo, 'config', 'user.email', 'author@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, 'README.md'), '# probe repo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'initial');
  writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '.orchestrator/\n', { flag: 'a' });
  git(repo, 'worktree', 'add', '-q', '-b', 'task/PROBE/l1', path.join(scratch, 'wt'));
  return { scratch, repo, wt: path.join(scratch, 'wt'), home: path.join(scratch, 'home') };
}

// ---------------------------------------------------------------- processes
function psRows() {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8' }).split('\n').map((l) => l.trim().split(/\s+/)).filter((r) => r.length >= 4)
      .map(([pid, ppid, pgid, ...c]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), comm: c.join(' ') }));
  } catch { return []; }
}
function subtree(rows, root) {
  const out = [];
  const add = (pid) => { for (const r of rows) if (r.ppid === pid) { out.push(r); add(r.pid); } };
  const self = rows.find((r) => r.pid === root);
  if (self) out.push(self);
  add(root);
  return out;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const short = (comm) => comm.split('/').pop();

/** Samples the process tree under `root` every 500 ms; remembers every process seen and the largest listing. */
function watchTree(root) {
  const seen = new Map();
  let largest = [];
  const tick = () => {
    const rows = psRows();
    const tree = subtree(rows, root());
    for (const r of tree) if (!seen.has(r.pid)) seen.set(r.pid, { ...r, comm: short(r.comm) });
    if (tree.length >= largest.length) largest = [...tree.map((r) => ({ ...r, comm: short(r.comm), in: 'tree' })), ...rows.filter((r) => /(^|\/)opencode$/.test(r.comm) && !tree.some((t) => t.pid === r.pid)).map((r) => ({ ...r, comm: short(r.comm), in: 'opencode' }))];
  };
  tick();
  const timer = setInterval(tick, 500);
  return { stop: () => { clearInterval(timer); tick(); }, seen, largest: () => largest };
}
/** Processes seen in a run that are still alive with the same command: each is killed and named. */
async function reapOrphans(seen) {
  const rows = psRows();
  const left = [...seen.values()].filter((p) => rows.some((r) => r.pid === p.pid && short(r.comm) === p.comm));
  for (const p of left) try { process.kill(p.pid, 'SIGTERM'); } catch {}
  if (left.length) await sleep(1500);
  for (const p of left) if (alive(p.pid)) try { process.kill(p.pid, 'SIGKILL'); } catch {}
  return left.map((p) => ({ pid: p.pid, pgid: p.pgid, comm: p.comm }));
}

// ---------------------------------------------------------------- environment
function childEnv(ctx, run, extra = {}) {
  const x = path.join(ctx.scratch, 'xdg', run.xdg ?? run.id);
  const env = {
    PATH: process.env.PATH,
    HOME: ctx.home,
    USER: process.env.USER ?? 'probe',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    XDG_DATA_HOME: path.join(x, 'data'),
    XDG_CONFIG_HOME: path.join(x, 'config'),
    XDG_STATE_HOME: path.join(x, 'state'),
    XDG_CACHE_HOME: path.join(x, 'cache'),
    ORCH_LAUNCH_ID: 'probe-launch',
    ORCH_TOKEN: run.token,
    ORCH_API: 'http://127.0.0.1:9',
    PROBE_MARKER: 'from-client-env',
    ...extra,
  };
  for (const k of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) mkdirSync(env[k], { recursive: true });
  return env;
}
/** What a run record shows of the environment: values for the XDG, ORCH, marker, HOME and PWD variables, names for the rest. */
const SHOWN_ENV = /^(XDG_.*|ORCH_.*|PROBE_MARKER|HOME|PWD|OPENCODE_CONFIG_CONTENT)$/;
const shownEnv = (env) => Object.fromEntries(Object.keys(env).sort().map((k) => [k, SHOWN_ENV.test(k) ? env[k] : '<set>']));

// ---------------------------------------------------------------- configuration and prompts
/** The derived ruleset's shape (src/runner/opencode.ts openCodePermission, `derived`, with `node *` from the toolchain). */
const DERIVED = { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', edit: 'allow', write: 'allow', bash: { '*': 'deny', 'git *': 'allow', 'node *': 'allow' }, 'orchestrator_*': 'allow' };
/** OPENCODE_CONFIG_CONTENT as openCodeConfig writes it, minus the mcp block (the shim comes over ACP), plus the model. */
const baseConfig = (over = {}) => ({ $schema: 'https://opencode.ai/config.json', model: MODEL, snapshots: false, share: 'disabled', permission: DERIVED, ...over });
const ASK_RULES = { '*': 'ask', read: 'allow', bash: { '*': 'ask', 'git *': 'allow' }, 'orchestrator_*': 'allow' };

const shimServer = (ctx, run, opts = {}) => ({
  name: 'orchestrator',
  command: process.execPath,
  args: [SHIM, path.join(ctx.out, 'shim.jsonl'), '--block-sec', String(opts.blockSec ?? 75), ...(opts.args ?? [])],
  env: opts.noEnv ? [] : [{ name: 'ORCH_LAUNCH_ID', value: 'probe-launch' }, { name: 'ORCH_TOKEN', value: run.token }, { name: 'ORCH_API', value: 'http://127.0.0.1:9' }, { name: 'PROBE_FROM_SESSION', value: '1' }],
});
const badShim = (ctx) => ({ name: 'orchestrator', command: process.execPath, args: [SHIM, path.join(ctx.out, 'shim.jsonl'), '--orch-env-file', path.join(ctx.scratch, 'no-such-env-file')], env: [{ name: 'PROBE_FROM_SESSION', value: '1' }] });

function taskPrompt(ctx) {
  // The wording of test/fixtures/opencode/brief-run/brief-q3.md with this worktree and branch.
  return readFileSync(path.join(ACP, '..', 'opencode', 'brief-run', 'brief-q3.md'), 'utf8')
    .replaceAll('task/T1/l1', 'task/PROBE/l1')
    .replaceAll('<scratch>/proj5', ctx.wt)
    .replace(/- Base commit: `[0-9a-f]+`/, `- Base commit: \`${git(ctx.repo, 'rev-parse', 'HEAD').trim()}\``);
}
const P = {
  pwd: 'Run the shell command pwd with your bash tool and reply with its output only.',
  heartbeat: 'Call the orchestrator_heartbeat tool once with progress "probe". If you have no such tool, reply NO-TOOL. Then reply DONE.',
  uname: 'First call the orchestrator_heartbeat tool once with progress "probe". Then run exactly the shell command `uname -s` with your bash tool. If the command is rejected, reply FALLBACK-OK and stop; otherwise reply with its output only.',
  sleep: 'Run exactly the shell command `sleep 60` with your bash tool and wait for it to finish, then reply DONE. Do not run anything else.',
  ok: 'Reply with the single word OK.',
};

// ---------------------------------------------------------------- one client run
const AGENT = (logs = true) => ['opencode', 'acp', '--pure', ...(logs ? ['--print-logs', '--log-level', 'WARN'] : [])];
const counters = new Map();

/**
 * Starts acp-client.mjs as a detached child (its own process group) with the run's environment, writes its stdout and stderr
 * to files, samples its process tree, and enforces the hard limit. `drive(api)` may signal it. Returns the run record.
 */
async function clientRun(ctx, run, o) {
  const dir = path.join(ctx.out);
  const files = { frames: path.join(dir, `frames.jsonl`), stdout: path.join(dir, 'client.jsonl'), stderr: path.join(dir, 'stderr.txt'), mcp: path.join(dir, 'mcp.json'), policy: path.join(dir, 'policy.json'), prompt: path.join(dir, 'prompt.txt'), requests: path.join(dir, 'requests.json') };
  writeFileSync(files.mcp, JSON.stringify(o.mcpServers ?? []));
  writeFileSync(files.policy, JSON.stringify(o.policy ?? { default: 'reject', allow: [] }));
  if (o.prompt) writeFileSync(files.prompt, o.prompt);
  if (o.requests) writeFileSync(files.requests, JSON.stringify(o.requests));
  const cwd = o.spawnCwd ?? ctx.wt;
  const env = childEnv(ctx, run, { PWD: o.pwd ?? cwd, ...(o.config ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(o.config) } : {}), ...(o.env ?? {}) });
  const args = [CLIENT, '--agent-json', JSON.stringify(o.agent ?? AGENT()), '--cwd', o.sessionCwd ?? ctx.wt, '--mcp-json', files.mcp, '--policy', files.policy, '--frames', files.frames, '--turn-timeout-ms', String(o.turnTimeoutMs ?? 290_000), '--cancel-grace-ms', String(o.cancelGraceMs ?? 15_000), ...(o.prompt ? ['--prompt-file', files.prompt] : []), ...(o.requests ? ['--requests-json', files.requests] : []), ...(o.clientArgs ?? [])];
  const t0 = Date.now();
  const out = [];
  let stderr = '';
  const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const watch = watchTree(() => child.pid);
  const listeners = [];
  let sbuf = '';
  child.stdout.on('data', (d) => { sbuf += d; let i; while ((i = sbuf.indexOf('\n')) >= 0) { const l = sbuf.slice(0, i); sbuf = sbuf.slice(i + 1); try { const m = JSON.parse(l); out.push(m); for (const f of listeners) f(m); } catch { out.push({ raw: l }); } } });
  child.stderr.on('data', (d) => { stderr += d; });
  const exitP = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal, ms: Date.now() - t0 })));
  const limitMs = o.limitMs ?? 330_000;
  let timedOut = false;
  const limit = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000); }, limitMs);
  const api = { pid: child.pid, t0, waitFor: (pred) => new Promise((r) => { const hit = out.find(pred); if (hit) return r(hit); listeners.push((m) => { if (pred(m)) r(m); }); }), exitP, signalGroup: (s) => process.kill(-child.pid, s), signal: (s) => process.kill(child.pid, s), tree: () => subtree(psRows(), child.pid).map((r) => ({ ...r, comm: short(r.comm) })) };
  // A drive notes what it saw in api.notes as it goes, so a client that exits first still leaves the notes.
  api.notes = {};
  const driven = o.drive ? (await Promise.race([o.drive(api), exitP.then(() => undefined)])) ?? (Object.keys(api.notes).length ? api.notes : undefined) : undefined;
  const exit = await exitP;
  clearTimeout(limit);
  await sleep(1000);
  watch.stop();
  const orphans = await reapOrphans(watch.seen);
  const record = { command: ['node', 'acp-client.mjs', ...args.slice(1)], spawnCwd: cwd, env: shownEnv(env), exit, timedOut, limitMs, driven: driven ?? null, orphans, processes: watch.largest(), client: out };
  return { record, files, stderr, env };
}

/** The token's value searched in the run's XDG directories and logs: where it was found. */
function findToken(ctx, run, token, extraFiles) {
  const hits = [];
  const x = path.join(ctx.scratch, 'xdg', run.xdg ?? run.id);
  const walk = (d) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) { try { if (statSync(p).size < 64 * 1024 * 1024 && readFileSync(p).includes(token)) hits.push(p); } catch {} } } };
  walk(x);
  for (const [label, f] of Object.entries(extraFiles)) if (existsSync(f) && readFileSync(f).includes(token)) hits.push(`${label}:${f}`);
  return hits;
}

function frameStats(framesText) {
  const fs = framesText.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let maxGap = 0, at = null;
  for (let i = 1; i < fs.length; i++) { const g = fs[i].t - fs[i - 1].t; if (g > maxGap) { maxGap = g; at = fs[i - 1].t; } }
  const raw = fs.filter((f) => f.raw !== undefined).length;
  const usage = fs.filter((f) => f.msg?.params?.update?.sessionUpdate === 'usage_update').map((f) => f.msg.params.update);
  const promptAnswer = fs.find((f) => f.dir === 'recv' && f.msg && f.msg.id !== undefined && f.msg.method === undefined && fs.some((s) => s.dir === 'send' && s.msg?.method === 'session/prompt' && s.msg.id === f.msg.id));
  return { frames: fs.length, nonJsonStdoutLines: raw, maxGapMs: maxGap, maxGapAfterMs: at, usageUpdates: usage.length, lastUsage: usage[usage.length - 1] ?? null, promptAnswer: promptAnswer?.msg ?? null };
}

/** Writes the evidence of one run and its record at once. */
function saveRun(ctx, id, scenario, base, extra = {}) {
  const ev = {};
  const put = (sub, ext, text, jsonl) => { if (text === undefined || text === null) return; const f = path.join(HERE, sub, `${id}.${ext}`); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, jsonl ? redactJsonl(text) : redactString(text)); ev[sub] = path.relative(HERE, f); };
  const read = (f) => (f && existsSync(f) ? readFileSync(f, 'utf8') : undefined);
  put('frames', 'jsonl', read(base.files?.frames), true);
  put('stderr', 'txt', base.stderr);
  // The shim's parent chain is cut at this script's process: rows above it are not the script's own tree.
  const shimText = read(path.join(ctx.out, 'shim.jsonl'));
  put('shim', 'jsonl', shimText?.split('\n').map((l) => { if (!l.startsWith('{')) return l; const o = JSON.parse(l); if (Array.isArray(o.chain)) { const i = o.chain.findIndex((c) => c.pid === process.pid); if (i >= 0) o.chain = o.chain.slice(0, i + 1); else o.chain = o.chain.slice(0, 4); } return JSON.stringify(o); }).join('\n'), true);
  const log = path.join(ctx.scratch, 'xdg', extra.xdg ?? id, 'data', 'opencode', 'log', 'opencode.log');
  if (existsSync(log)) { const t = readFileSync(log, 'utf8'); put('logs', 'log', t.length > 200_000 ? t.slice(-200_000) : t); }
  put('client', 'jsonl', base.record?.client ? base.record.client.map((m) => JSON.stringify(m)).join('\n') + '\n' : undefined, true);
  if (extra.runStdout !== undefined) put('run', 'jsonl', extra.runStdout, true);
  const framesText = read(base.files?.frames);
  const { client: _c, ...rec } = base.record ?? {};
  const record = redact({ id, scenario, probedAt: now(), modelCalls: extra.modelCalls ?? 0, ...rec, ...(framesText ? { frameStats: frameStats(framesText) } : {}), ...extra.fields, evidence: ev });
  mkdirSync(RECORDS, { recursive: true });
  writeFileSync(path.join(RECORDS, `${id}.json`), JSON.stringify(record, null, 2) + '\n');
  console.error(`[probe] ${id}: exit ${JSON.stringify(record.exit)} modelCalls ${record.modelCalls} orphans ${JSON.stringify(record.orphans)}`);
  return record;
}

function newCtx(id) {
  const s = makeScratch();
  const out = path.join(s.scratch, 'out', id);
  mkdirSync(out, { recursive: true });
  return { ...s, out };
}
const token = () => `orch-probe-token-${randomBytes(4).toString('hex')}`;
const cleanups = [];
function cleanupAll() { for (const d of cleanups.splice(0)) { try { git(path.join(d, 'repo'), 'worktree', 'prune'); } catch {} rmSync(d, { recursive: true, force: true }); } }
process.on('exit', cleanupAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanupAll(); process.exit(130); });

/** A scenario run: a fresh scratch, one client run, evidence saved; `after` adds fields read from the scratch before removal. */
async function scenario(id, scen, o, after) {
  const ctx = newCtx(id);
  cleanups.push(ctx.scratch);
  const run = { id, token: token(), xdg: o.xdg };
  const opts = typeof o === 'function' ? o(ctx, run) : o;
  if (typeof o !== 'function' && o.build) Object.assign(opts, o.build(ctx, run));
  const base = await clientRun(ctx, run, opts);
  // stderr is on disk before any token search, the after() hook's included.
  writeFileSync(path.join(ctx.out, 'stderr.txt'), base.stderr);
  const fields = { token: run.token, tokenFoundIn: findToken(ctx, run, run.token, { stderr: path.join(ctx.out, 'stderr.txt'), frames: base.files.frames }), ...(after ? await after(ctx, run, base) : {}) };
  return saveRun(ctx, id, scen, base, { modelCalls: opts.prompt ? 1 : 0, fields });
}

const gitFacts = (ctx) => ({
  branchLog: git(ctx.wt, 'log', '--format=%h %s%n%an <%ae>', 'main..task/PROBE/l1').trim().split('\n').filter(Boolean),
  worktreeStatus: git(ctx.wt, 'status', '--short', '--untracked-files=all').trim().split('\n').filter(Boolean),
  files: readdirSync(ctx.wt).filter((f) => f !== '.git'),
});
const xdgListing = (ctx, run) => {
  const x = path.join(ctx.scratch, 'xdg', run.xdg ?? run.id);
  const out = [];
  const walk = (d, depth) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); out.push(path.relative(x, p) + (e.isDirectory() ? '/' : '')); if (e.isDirectory() && depth < 3) walk(p, depth + 1); } };
  walk(x, 0);
  return out;
};

// ---------------------------------------------------------------- scenarios
const SCENARIOS = {
  async S0() {
    const reqs = [{ when: 'afterSession', method: 'session/set_model', params: { sessionId: '{sessionId}', modelId: MODEL } }, { when: 'afterSession', method: 'session/set_config_option', params: { sessionId: '{sessionId}', configId: 'model', value: MODEL } }, { when: 'afterSession', method: 'session/set_mode', params: { sessionId: '{sessionId}', modeId: 'build' } }, { when: 'afterSession', method: 'session/set_model', params: { sessionId: '{sessionId}', modelId: 'opencode/gpt-bogus-9' } }];
    for (const [id, logs, bad] of [['S0-good', false, false], ['S0-good-logs', true, false], ['S0-badshim', false, true], ['S0-badshim-logs', true, true]]) {
      await scenario(id, 'S0', { agent: AGENT(logs), config: baseConfig(), requests: logs ? reqs : undefined, build: (ctx, run) => ({ mcpServers: [bad ? badShim(ctx) : shimServer(ctx, run)] }), limitMs: 90_000 }, async (ctx, run) => ({ xdg: xdgListing(ctx, run) }));
    }
  },
  // S0, model selection without a turn: a valid non-default model in OPENCODE_CONFIG_CONTENT, then an unknown one set over ACP.
  async S0m() {
    const reqs = [{ when: 'afterSession', method: 'session/set_config_option', params: { sessionId: '{sessionId}', configId: 'model', value: 'opencode/gpt-bogus-9' } }, { when: 'afterSession', method: 'session/set_config_option', params: { sessionId: '{sessionId}', configId: 'effort', value: 'high' } }];
    await scenario('S0-model', 'S0', { agent: AGENT(true), config: baseConfig({ model: 'opencode/nemotron-3.5-lightning-free' }), requests: reqs, build: (ctx, run) => ({ mcpServers: [shimServer(ctx, run)] }), limitMs: 90_000 });
  },
  async S1() {
    await scenario('S1', 'S1', { config: baseConfig(), build: (ctx, run) => ({ prompt: taskPrompt(ctx), mcpServers: [shimServer(ctx, run)] }), limitMs: 330_000 }, async (ctx, run) => ({ git: gitFacts(ctx), xdg: xdgListing(ctx, run) }));
  },
  // S1 was cut at 60 s. The 1.18.30 binary takes an MCP call's timeout from the added server's own config, else from the config
  // file's mcp.<name> entry of the same name, else from experimental.mcp_timeout (MCP.tools, function Oe). Two shapes, one run each:
  // S1b, a disabled mcp.orchestrator entry carrying only the timeout (its command records to its own calls file, so the evidence
  // shows which registration served the calls); S1b-exp, experimental.mcp_timeout.
  async S1b() {
    await scenario('S1b', 'S1b', { build: (ctx, run) => ({ config: baseConfig({ mcp: { orchestrator: { type: 'local', command: [process.execPath, SHIM, path.join(ctx.out, 'shim-config.jsonl')], enabled: false, timeout: 900_000 } } }), prompt: taskPrompt(ctx), mcpServers: [shimServer(ctx, run)] }), limitMs: 330_000 }, async (ctx) => ({ git: gitFacts(ctx), configShimCalls: existsSync(path.join(ctx.out, 'shim-config.jsonl')) ? readFileSync(path.join(ctx.out, 'shim-config.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0 }));
    await scenario('S1b-exp', 'S1b', { config: baseConfig({ experimental: { mcp_timeout: 900_000 } }), build: (ctx, run) => ({ prompt: taskPrompt(ctx), mcpServers: [shimServer(ctx, run)] }), limitMs: 330_000 }, async (ctx) => ({ git: gitFacts(ctx) }));
  },
  async S1e() {
    await scenario('S1e', 'S1e', { config: baseConfig(), build: (ctx, run) => {
      const envFile = path.join(ctx.home, 'shim.env');
      run.fileToken = token();
      writeFileSync(envFile, `ORCH_LAUNCH_ID=probe-launch\nORCH_TOKEN=${run.fileToken}\nORCH_API=http://127.0.0.1:9\n`, { mode: 0o600 });
      return { prompt: taskPrompt(ctx), mcpServers: [shimServer(ctx, run, { noEnv: true, args: ['--orch-env-file', envFile] })] };
    }, limitMs: 330_000 }, async (ctx, run) => ({ git: gitFacts(ctx), fileToken: run.fileToken, fileTokenFoundIn: findToken(ctx, run, run.fileToken, { stderr: path.join(ctx.out, 'stderr.txt'), frames: path.join(ctx.out, 'frames.jsonl') }) }));
  },
  async S1d() {
    await scenario('S1d', 'S1d', { prompt: P.pwd, config: baseConfig({ permission: { ...DERIVED, bash: { ...DERIVED.bash, pwd: 'allow' } } }), build: (ctx, run) => {
      const dirs = Object.fromEntries(['dir-flag', 'dir-spawn', 'dir-pwd'].map((d) => { const p = path.join(ctx.scratch, d); mkdirSync(p); return [d, p]; }));
      return { mcpServers: [shimServer(ctx, run)], agent: [...AGENT(), '--cwd', dirs['dir-flag']], spawnCwd: dirs['dir-spawn'], pwd: dirs['dir-pwd'] };
    }, limitMs: 200_000 });
  },
  async S1f() {
    await scenario('S1f', 'S1f', { prompt: P.heartbeat, config: baseConfig(), build: (ctx) => ({ mcpServers: [badShim(ctx)] }), limitMs: 200_000 });
  },
  async S2() { await permissionRun('S2', { default: 'reject', allow: [] }); },
  async S3() { await permissionRun('S3', { default: 'reject', allow: [{ command: 'uname -s' }, { title: 'uname -s' }] }); },
  async S4() {
    await permissionRun('S4', { default: 'reject', allow: [] }, {
      clientArgs: ['--no-permission-answer'], limitMs: 330_000,
      drive: async (api) => { const p = await api.waitFor((m) => m.type === 'permission'); await sleep(120_000); const at = Date.now() - api.t0; api.signal('SIGINT'); return { permissionAtMs: p.t, cancelSentAtClientMs: at }; },
    });
  },
  async S5() {
    await scenario('S5', 'S5', { prompt: P.sleep, config: sleepConfig(), build: (ctx, run) => ({ mcpServers: [shimServer(ctx, run)] }), limitMs: 200_000, drive: async (api) => {
      await api.waitFor((m) => m.type === 'update' && /sleep/.test(m.title ?? '') );
      await sleep(10_000);
      const before = api.tree();
      api.signal('SIGINT');
      return { treeBeforeCancel: before, cancelAtMs: Date.now() - api.t0 };
    } });
  },
  async S6a() {
    for (const [id, sig] of [['S6a-term', 'SIGTERM'], ['S6a-kill', 'SIGKILL']]) {
      await scenario(id, 'S6a', { prompt: P.sleep, config: sleepConfig(), build: (ctx, run) => ({ mcpServers: [shimServer(ctx, run)] }), limitMs: 200_000, drive: async (api) => {
        await api.waitFor((m) => m.type === 'update' && /sleep/.test(m.title ?? ''));
        await sleep(10_000);
        const before = api.tree();
        api.notes.signal = sig; api.notes.treeBeforeSignal = before;
        api.signalGroup(sig);
        await sleep(3000);
        return { signal: sig, treeBeforeSignal: before, aliveAfter3s: before.filter((p) => alive(p.pid)) };
      } });
    }
  },
  async S6b() { await detachedRun(); },
  async S7() {
    await scenario('S7', 'S7', { prompt: P.ok, config: baseConfig({ model: 'opencode/gpt-bogus-9' }), build: (ctx, run) => ({ mcpServers: [shimServer(ctx, run)] }), limitMs: 200_000 });
  },
  async S8() { await concurrentStarts(); },
  async S9() { await opencodeRun(); },
};
function sleepConfig() { return baseConfig({ permission: { ...DERIVED, bash: { ...DERIVED.bash, 'sleep *': 'allow' } } }); }
async function permissionRun(id, policy, extra = {}) {
  await scenario(id, id, { prompt: P.uname, config: baseConfig({ permission: ASK_RULES }), policy, build: (ctx, run) => ({ mcpServers: [shimServer(ctx, run)] }), limitMs: 240_000, ...extra });
}

/** S6b: the client started the way SubprocessRunner starts an agent (sh -c, detached, stdin ignored, stdout and stderr in one file) by a parent that exits at once. */
async function detachedRun() {
  const id = 'S6b';
  const ctx = newCtx(id);
  cleanups.push(ctx.scratch);
  const run = { id, token: token() };
  const files = { frames: path.join(ctx.out, 'frames.jsonl'), log: path.join(ctx.out, 'launch.log'), mcp: path.join(ctx.out, 'mcp.json'), policy: path.join(ctx.out, 'policy.json'), prompt: path.join(ctx.out, 'prompt.txt') };
  writeFileSync(files.mcp, JSON.stringify([shimServer(ctx, run)]));
  writeFileSync(files.policy, JSON.stringify({ default: 'reject', allow: [] }));
  writeFileSync(files.prompt, P.heartbeat);
  const env = childEnv(ctx, run, { PWD: ctx.wt, OPENCODE_CONFIG_CONTENT: JSON.stringify(baseConfig()) });
  const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  const cmd = [process.execPath, CLIENT, '--agent-json', JSON.stringify(AGENT()), '--cwd', ctx.wt, '--mcp-json', files.mcp, '--policy', files.policy, '--frames', files.frames, '--prompt-file', files.prompt, '--turn-timeout-ms', '240000'].map(q).join(' ');
  const parentSrc = `const { spawn } = require('node:child_process'); const fs = require('node:fs'); const log = fs.openSync(${JSON.stringify(files.log)}, 'a'); const c = spawn('/bin/sh', ['-c', ${JSON.stringify(cmd)}], { cwd: ${JSON.stringify(ctx.wt)}, env: process.env, detached: true, stdio: ['ignore', log, log] }); c.unref(); process.stdout.write(String(c.pid)); process.exit(0);`;
  const t0 = Date.now();
  const parent = spawnSync(process.execPath, ['-e', parentSrc], { env, encoding: 'utf8', timeout: 10_000 });
  const parentMs = Date.now() - t0;
  const shPid = Number(parent.stdout);
  const watch = watchTree(() => shPid);
  const deadline = Date.now() + 300_000;
  let result = null;
  while (Date.now() < deadline) {
    const text = existsSync(files.log) ? readFileSync(files.log, 'utf8') : '';
    const line = text.split('\n').find((l) => l.startsWith('{"type":"result"'));
    if (line && !alive(shPid)) { result = JSON.parse(line); break; }
    await sleep(1000);
  }
  if (alive(shPid)) { try { process.kill(-shPid, 'SIGTERM'); } catch {} }
  await sleep(1000);
  watch.stop();
  const orphans = await reapOrphans(watch.seen);
  const log = existsSync(files.log) ? readFileSync(files.log, 'utf8') : '';
  const record = { command: ['node', '-e', '<parent: spawn sh -c <client> detached, stdin ignored, stdout+stderr to launch.log, exit>'], clientCommand: cmd, env: shownEnv(env), parentExit: { code: parent.status, ms: parentMs }, shPid, exit: result ? { code: result.exitCode, ms: Date.now() - t0 } : null, finishedAfterParentExit: Boolean(result), orphans, processes: watch.largest(), client: log.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) };
  const fields = { token: run.token, tokenFoundIn: findToken(ctx, run, run.token, { launchLog: files.log, frames: files.frames }) };
  saveRun(ctx, id, 'S6b', { record, files, stderr: log.split('\n').filter((l) => !l.startsWith('{"type":')).join('\n') }, { modelCalls: 1, fields });
}

/** S8: eight clients started in the same instant on one data directory, no prompt. */
async function concurrentStarts() {
  const ctx = newCtx('S8');
  cleanups.push(ctx.scratch);
  const runs = Array.from({ length: 8 }, (_, i) => ({ id: `S8-${i + 1}`, token: token(), xdg: 'S8-shared' }));
  const results = await Promise.all(runs.map(async (run) => {
    const sub = { ...ctx, out: path.join(ctx.scratch, 'out', run.id) };
    mkdirSync(sub.out, { recursive: true });
    const base = await clientRun(sub, run, { config: baseConfig(), mcpServers: [shimServer(sub, run)], limitMs: 120_000 });
    writeFileSync(path.join(sub.out, 'stderr.txt'), base.stderr);
    return { run, sub, base };
  }));
  for (const { run, sub, base } of results) saveRun(sub, run.id, 'S8', base, { modelCalls: 0, xdg: 'S8-shared', fields: { token: run.token, sharedXdg: 'S8-shared' } });
}

/** S9: the prompt of S1 through `opencode run --format json`, as OpenCodeRunner composes it, for the usage comparison. */
async function opencodeRun() {
  const id = 'S9';
  const ctx = newCtx(id);
  cleanups.push(ctx.scratch);
  const run = { id, token: token() };
  const promptFile = path.join(ctx.out, 'prompt.md');
  writeFileSync(promptFile, taskPrompt(ctx));
  const shim = shimServer(ctx, run);
  // openCodeConfig: the shim as mcp.orchestrator with the call timeout maxWaitMs + 60000 (here 300000 + 60000), no environment block.
  const config = baseConfig({ mcp: { orchestrator: { type: 'local', command: [shim.command, ...shim.args], enabled: true, timeout: 360_000 } } });
  const env = childEnv(ctx, run, { PWD: ctx.wt, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) });
  const args = ['run', '--format', 'json', '--pure', '--print-logs', '--log-level', 'WARN', '-m', MODEL];
  const t0 = Date.now();
  const { fd } = { fd: (await import('node:fs')).openSync(promptFile, 'r') };
  const child = spawn('opencode', args, { cwd: ctx.wt, env, detached: true, stdio: [fd, 'pipe', 'pipe'] });
  const watch = watchTree(() => child.pid);
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  let timedOut = false;
  const limit = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000); }, 330_000);
  const exit = await new Promise((r) => child.on('exit', (code, signal) => r({ code, signal, ms: Date.now() - t0 })));
  clearTimeout(limit);
  await sleep(1000);
  watch.stop();
  const orphans = await reapOrphans(watch.seen);
  const steps = stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.type === 'step_finish');
  const sum = (f) => steps.reduce((a, e) => a + (f(e.part) ?? 0), 0);
  const usage = { steps: steps.length, turns: steps.filter((e) => e.part?.reason === 'stop').length, input: sum((p) => p.tokens?.input), output: sum((p) => p.tokens?.output), reasoning: sum((p) => p.tokens?.reasoning), cacheRead: sum((p) => p.tokens?.cache?.read), cacheWrite: sum((p) => p.tokens?.cache?.write), cost: sum((p) => p.cost) };
  const record = { command: ['opencode', ...args, '<', 'prompt.md'], env: shownEnv(env), exit, timedOut, orphans, processes: watch.largest() };
  writeFileSync(path.join(ctx.out, 'stderr.txt'), stderr);
  const fields = { usage, git: gitFacts(ctx), token: run.token, tokenFoundIn: findToken(ctx, run, run.token, { stderr: path.join(ctx.out, 'stderr.txt') }) };
  saveRun(ctx, id, 'S9', { record, files: {}, stderr }, { modelCalls: 1, runStdout: stdout, fields });
}

// ---------------------------------------------------------------- results.json
const QUESTIONS = JSON.parse(readFileSync(path.join(HERE, 'answers.json'), 'utf8'));

function assemble() {
  const runs = existsSync(RECORDS) ? readdirSync(RECORDS).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(path.join(RECORDS, f), 'utf8'))) : [];
  const prev = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {};
  const results = {
    cli: 'opencode',
    version: prev.version ?? null,
    model: MODEL,
    probedAt: prev.probedAt ?? now(),
    client: 'test/fixtures/acp/acp-client.mjs',
    shim: 'test/fixtures/acp/recording-shim.mjs',
    questions: QUESTIONS.questions,
    userConfig: prev.userConfig ?? [],
    runs,
  };
  const tmp = `${RESULTS}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(results, null, 2) + '\n');
  renameSync(tmp, RESULTS);
  return results;
}

function check() {
  let r;
  try { r = JSON.parse(readFileSync(RESULTS, 'utf8')); } catch (err) { console.log(`acp probe opencode: results.json does not parse (${err.message})`); return 1; }
  const problems = [];
  const bad = new Set();
  const flag = (ids, text) => { for (const id of ids) bad.add(id); problems.push(`${ids.length ? ids.join(', ') : 'results.json'}: ${text}`); };
  for (const k of ['cli', 'version', 'model', 'probedAt', 'questions', 'runs', 'userConfig']) if (r[k] === undefined) flag([], `lacks ${k}`);
  if (r.cli !== 'opencode') flag([], 'cli is not opencode');
  for (let n = 1; n <= 18; n++) {
    const id = `Q${n}`;
    const q = (r.questions ?? []).find((x) => x.id === id);
    if (!q) { flag([id], 'missing'); continue; }
    if (!['yes', 'no', 'partly', 'blocked'].includes(q.answer)) flag([id], `answer ${JSON.stringify(q.answer)}`);
    if (!q.summary) flag([id], 'no summary');
    if (!Array.isArray(q.commands) || !q.commands.length) flag([id], 'no commands');
    if (!Array.isArray(q.evidence) || !q.evidence.length) flag([id], 'no evidence');
    for (const e of q.evidence ?? []) if (!existsSync(path.join(HERE, e))) flag([id], `evidence file ${e} does not exist`);
    if (q.answer === 'blocked' && !q.reason) flag([id], 'blocked without a reason');
  }
  // A run's record, or one of its evidence files, missing is charged to every question that cites the run.
  for (const run of r.runs ?? []) if (!existsSync(path.join(RECORDS, `${run.id}.json`))) flag((r.questions ?? []).filter((q) => (q.runs ?? []).includes(run.id)).map((q) => q.id), `run ${run.id}: records/${run.id}.json does not exist`);
  for (const run of r.runs ?? []) for (const [k, f] of Object.entries(run.evidence ?? {})) {
    if (existsSync(path.join(HERE, f))) continue;
    flag((r.questions ?? []).filter((q) => (q.runs ?? []).includes(run.id)).map((q) => q.id), `run ${run.id}: ${k} file ${f} does not exist`);
  }
  for (const p of problems) console.log(p);
  console.log(`acp probe opencode: ${18 - [...bad].filter((id) => /^Q([1-9]|1[0-8])$/.test(id)).length} of 18 questions recorded`);
  return problems.length ? 1 : 0;
}

// ---------------------------------------------------------------- main
const argv = process.argv.slice(2);
if (argv[0] === '--check') process.exit(check());
if (argv[0] === '--assemble') { assemble(); process.exit(check()); }
if (argv[0] === '--run') {
  const ids = (argv[1] ?? '').split(',').filter(Boolean);
  for (const id of ids) if (!SCENARIOS[id]) { console.error(`unknown scenario ${id}`); process.exit(64); }
  const before = hashTree(USER_CONFIG);
  const version = spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } }).stdout.trim();
  for (const id of ids) await SCENARIOS[id]();
  const after = hashTree(USER_CONFIG);
  // Parallel invocations: one writer at a time.
  const lock = `${RESULTS}.lock`;
  for (let i = 0; ; i++) { try { mkdirSync(lock); break; } catch { if (i > 600) rmSync(lock, { recursive: true, force: true }); await sleep(100); } }
  process.on('exit', () => rmSync(lock, { recursive: true, force: true }));
  const prev = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {};
  const old = new Map((prev.userConfig ?? []).map((u) => [u.path, u]));
  const userConfig = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().map((p) => {
    const rel = redactString(p);
    const o = old.get(rel);
    return { path: rel, sha256Before: o?.sha256Before ?? before[p] ?? null, sha256After: after[p] ?? null, changedBy: [...new Set([...(o?.changedBy ?? []), ...(before[p] !== after[p] ? ids : [])])] };
  });
  writeFileSync(RESULTS, JSON.stringify({ ...prev, version, probedAt: prev.probedAt ?? now(), userConfig }, null, 2) + '\n');
  assemble();
  process.exit(0);
}
console.error('usage: node probe.mjs --run S0,S1,... | --assemble | --check');
process.exit(64);
