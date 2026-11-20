#!/usr/bin/env node
// Probe (GH-198): the Antigravity CLI (`agy`) as a worker harness, headless (`agy -p`) and over ACP (`agy acp`, driven by
// ../acp/acp-client.mjs with ../acp/recording-shim.mjs as the shim).
//
//   node probe.mjs --preflight [--bin <agy>] [--model <slug>]  one line per prerequisite, `ok: ...` or `missing: ...`
//   node probe.mjs --run R1,R2,... [--bin <agy>] [--model <slug>]  runs those runs, writes their evidence at once
//   node probe.mjs --assemble                              rebuilds results.json from records/ and answers.json
//   node probe.mjs --check                                 checks results.json and its evidence (no model, no agy)
//
// Every CLI runs here, as a detached child that leads its own process group, under a hard time limit; at the limit the
// script signals that group (-pid) and nothing else. Children get a short environment built here: PATH, HOME (the user's or
// a scratch home), USER, LANG, TMPDIR, the variables a run names, and the fake ORCH_* values; never the caller's. Scratch
// lives under the real path of os.tmpdir() and is removed in an exit handler. Evidence is redacted: the scratch directory
// becomes <scratch>, this checkout <repo>, the home directory ~, every git identity Fixture Author <author@example.invalid>.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, accessSync, constants } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACP = path.join(HERE, '..', 'acp');
const CLIENT = path.join(ACP, 'acp-client.mjs');
const SHIM = path.join(ACP, 'recording-shim.mjs');
const RESULTS = path.join(HERE, 'results.json');
const RECORDS = path.join(HERE, 'records');
const HOME = homedir();
const REPO = path.resolve(HERE, '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const MAX_MODEL_RUNS = 20;

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const BIN_ARG = opt('--bin', 'agy');
const MODEL_ARG = opt('--model');
// The issue's `Probe model:` line, as the brief had it on 2026-11-20 (no slug named); --model stands for the owner's answer.
const ISSUE_PROBE_MODEL_LINE = 'Probe model: (not named yet)';

// ---------------------------------------------------------------- redaction
let scratchRoots = [];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IDENTITY = /^(\s*(?:Author|Commit|Committer|Signed-off-by|Co-Authored-By):\s*)[^<\n]*?(\s*<|$)/gim;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const USER_NAME = (() => { try { return userInfo().username; } catch { return ''; } })();
const PS_ROW = /\s\d+\s+\d+\.\d+\s+\d+\.\d+\s+\d+\s+\d+\s+(\?\?|s\d+)\s/g;
const KEYS = /AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]{20,}/g;
function redactString(s) {
  let out = String(s).replace(ANSI, '');
  for (const root of scratchRoots) out = out.split(root).join('<scratch>');
  out = out.split(REPO).join('<repo>');
  out = out.split(HOME).join('~');
  out = out.replace(IDENTITY, (_, a, b) => `${a}Fixture Author${b}`).replace(EMAIL, 'author@example.invalid').replace(KEYS, '<key>');
  if (USER_NAME.length > 2) out = out.replace(new RegExp(`${USER_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '<user>');
  // A `ps aux` listing a model ran holds the whole process table: it is dropped, not kept (H7, A7).
  if ((out.match(PS_ROW) ?? []).length >= 3) out = '<removed: a process listing the model ran, the whole process table>';
  return out;
}
function redact(v) {
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactString(k), redact(x)]));
  return v;
}
const redactJsonl = (text) => text.split('\n').map((l) => { if (!l.trim()) return l; try { return JSON.stringify(redact(JSON.parse(l))); } catch { return redactString(l); } }).join('\n');

// ---------------------------------------------------------------- user configuration
const USER_FILES = [
  path.join(HOME, '.gemini', 'antigravity-cli', 'settings.json'),
  path.join(HOME, '.gemini', 'config', 'mcp_config.json'),
  path.join(HOME, '.gemini', 'GEMINI.md'),
];
const sha = (f) => { try { return createHash('sha256').update(readFileSync(f)).digest('hex'); } catch { return 'absent'; } };
const hashUser = () => Object.fromEntries(USER_FILES.map((f) => [f, sha(f)]));
/** Names (not contents) of the files under ~/.gemini with their size and mtime, to see what a run wrote there. */
function geminiListing() {
  const root = path.join(HOME, '.gemini');
  const out = {};
  const walk = (d, depth) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) { if (depth < 6) walk(p, depth + 1); } else { try { const s = statSync(p); out[p] = `${s.size}@${Math.floor(s.mtimeMs)}`; } catch {} } } };
  walk(root, 0);
  return out;
}
const diffListing = (a, b) => ({ added: Object.keys(b).filter((k) => !(k in a)).map(redactString), changed: Object.keys(b).filter((k) => k in a && a[k] !== b[k]).map(redactString), removed: Object.keys(a).filter((k) => !(k in b)).map(redactString) });

// ---------------------------------------------------------------- binary
function resolveBin(bin) {
  if (bin.includes('/')) { try { accessSync(bin, constants.X_OK); return path.resolve(bin); } catch { return null; } }
  for (const d of (process.env.PATH ?? '').split(':')) { const p = path.join(d, bin); try { accessSync(p, constants.X_OK); if (statSync(p).isFile()) return p; } catch {} }
  return null;
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
  const add = (pid) => { for (const r of rows) if (r.ppid === pid && !out.some((o) => o.pid === r.pid)) { out.push(r); add(r.pid); } };
  const self = rows.find((r) => r.pid === root);
  if (self) out.push(self);
  add(root);
  return out;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const short = (comm) => comm.split('/').pop();
const isHarness = (comm) => /(^|\/)(agy|antigravity[^/]*|language_server[^/]*)$/i.test(comm);

/** Samples the process tree under root (and the process group) every 500 ms; remembers every process seen. */
function watchTree(rootPid) {
  const seen = new Map();
  let largest = [];
  const tick = () => {
    const rows = psRows();
    const tree = subtree(rows, rootPid);
    for (const r of rows) if (r.pgid === rootPid && !tree.some((t) => t.pid === r.pid)) tree.push(r);
    for (const r of tree) if (!seen.has(r.pid)) seen.set(r.pid, { ...r, comm: short(r.comm) });
    if (tree.length >= largest.length) largest = [...tree.map((r) => ({ ...r, comm: short(r.comm), in: 'tree' })), ...rows.filter((r) => isHarness(r.comm) && !tree.some((t) => t.pid === r.pid)).map((r) => ({ ...r, comm: short(r.comm), in: 'harness' }))];
  };
  tick();
  const timer = setInterval(tick, 500);
  return { stop: () => { clearInterval(timer); tick(); }, seen, largest: () => largest };
}
/** Processes this script saw in a run that are still alive with the same command: each is killed and named. */
async function reapOrphans(seen) {
  const rows = psRows();
  const left = [...seen.values()].filter((p) => p.pid !== process.pid && rows.some((r) => r.pid === p.pid && short(r.comm) === p.comm));
  for (const p of left) try { process.kill(p.pid, 'SIGTERM'); } catch {}
  if (left.length) await sleep(1500);
  for (const p of left) if (alive(p.pid)) try { process.kill(p.pid, 'SIGKILL'); } catch {}
  return left.map((p) => ({ pid: p.pid, pgid: p.pgid, comm: p.comm }));
}

/**
 * Starts one child detached (its own process group) with the given environment, stdin text or 'ignore', and a hard limit.
 * At the limit it signals -pid with SIGTERM, then SIGKILL 3 s later. Resolves with exit, output, timings and orphans.
 */
function runChild(cmd, args, { env, cwd, stdin, limitMs, onStart, termAtMs, stdoutFile } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try { child = spawn(cmd, args, { env, cwd, detached: true, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); }
    catch (err) { resolve({ exit: { error: String(err.code ?? err) }, stdout: '', stderr: '', ms: 0, orphans: [], lines: [] }); return; }
    const watch = child.pid ? watchTree(child.pid) : null;
    let stdout = '', stderr = '';
    const lines = []; // stdout lines with their arrival time, for gap measurement
    let pending = '';
    child.stdout.on('data', (d) => { const s = d.toString(); stdout += s; pending += s; let i; while ((i = pending.indexOf('\n')) >= 0) { lines.push({ t: Date.now() - t0, len: i }); pending = pending.slice(i + 1); } });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    if (stdin !== undefined && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
    let timedOut = false, termSent = null;
    const kill = (why) => { if (why === 'limit') timedOut = true; termSent = { why, at: Date.now() - t0 }; try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000).unref(); };
    const limit = setTimeout(() => kill('limit'), limitMs ?? 120_000);
    const term = termAtMs ? setTimeout(() => kill('termAt'), termAtMs) : null;
    if (onStart) onStart(child);
    child.on('error', (err) => { stderr += `\n[probe] spawn error ${err.code ?? err}\n`; });
    child.on('close', async (code, signal) => {
      clearTimeout(limit); if (term) clearTimeout(term);
      const ms = Date.now() - t0;
      watch?.stop();
      await sleep(termSent ? 3500 : 300);
      const orphans = watch ? await reapOrphans(watch.seen) : [];
      if (stdoutFile) writeFileSync(stdoutFile, stdout);
      resolve({ exit: { code, signal }, timedOut, termSent, stdout, stderr, ms, lines, orphans, processes: watch ? watch.largest() : [], seen: watch ? [...watch.seen.values()] : [] });
    });
  });
}

// ---------------------------------------------------------------- environment
const fakeToken = () => `orch-probe-token-${randomBytes(4).toString('hex')}`;
function childEnv(home, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USER: process.env.USER ?? 'probe',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    ...extra,
  };
}
const SHOWN_ENV = /^(ORCH_.*|PROBE_MARKER|HOME|AGY_.*)$/;
const shownEnv = (env) => Object.fromEntries(Object.keys(env).sort().map((k) => [k, SHOWN_ENV.test(k) ? env[k] : '<set>']));

// ---------------------------------------------------------------- scratch
const GIT_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.invalid', GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'author@example.invalid' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
const cleanups = [];
function cleanupAll() { for (const d of cleanups.splice(0)) { try { git(path.join(d, 'repo'), 'worktree', 'prune'); } catch {} try { rmSync(d, { recursive: true, force: true }); } catch {} } }
process.on('exit', cleanupAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanupAll(); process.exit(130); });
process.on('uncaughtException', (err) => { console.error(err); cleanupAll(); process.exit(1); });
function makeScratch() {
  const scratch = mkdtempSync(path.join(realpathSync(tmpdir()), 'agy-probe-'));
  cleanups.push(scratch);
  scratchRoots = [...new Set([scratch, scratch.replace(/^\/private/, ''), ...scratchRoots])].sort((a, b) => b.length - a.length);
  const repo = path.join(scratch, 'repo');
  mkdirSync(repo);
  mkdirSync(path.join(scratch, 'home'));
  mkdirSync(path.join(scratch, 'out'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture Author');
  git(repo, 'config', 'user.email', 'author@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, 'README.md'), '# probe repo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'initial');
  writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '.orchestrator/\n', { flag: 'a' });
  git(repo, 'worktree', 'add', '-q', '-b', 'task/PROBE/l1', path.join(scratch, 'wt'));
  return { scratch, repo, wt: path.join(scratch, 'wt'), home: path.join(scratch, 'home'), out: path.join(scratch, 'out') };
}
const gitFacts = (ctx) => ({
  porcelain: git(ctx.wt, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean),
  porcelainIgnored: git(ctx.wt, 'status', '--porcelain', '--ignored', '--untracked-files=all').split('\n').filter(Boolean),
  branchLog: git(ctx.wt, 'log', '--format=%h %s', 'main..task/PROBE/l1').split('\n').filter(Boolean),
  files: readdirSync(ctx.wt).filter((f) => f !== '.git'),
});

// ---------------------------------------------------------------- preflight
async function preflight({ prompt = true } = {}) {
  const lines = [];
  const facts = { bin: BIN_ARG };
  const bin = resolveBin(BIN_ARG);
  facts.path = bin;
  if (!bin) { lines.push(`missing: ${BIN_ARG} on PATH (or the path given with --bin)`); }
  else {
    lines.push(`ok: binary ${redactString(bin)}`);
    const env = childEnv(HOME);
    const v = await runChild(bin, ['--version'], { env, cwd: tmpdir(), limitMs: 30_000 });
    facts.versionRun = { exit: v.exit, stdout: v.stdout, stderr: v.stderr };
    facts.version = v.stdout.trim().split('\n')[0] || null;
    lines.push(v.exit.code === 0 && facts.version ? `ok: version ${facts.version}` : `missing: version (exit ${JSON.stringify(v.exit)})`);
    const h = await runChild(bin, ['acp', '--help'], { env, cwd: tmpdir(), limitMs: 30_000 });
    facts.acpHelp = { exit: h.exit, stdout: h.stdout, stderr: h.stderr };
    lines.push(h.exit.code === 0 ? `ok: agy acp --help (exit 0, ${(h.stdout + h.stderr).split('\n').filter(Boolean).length} lines on stdout and stderr)` : `missing: agy acp --help (exit ${JSON.stringify(h.exit)})`);
    const m = await runChild(bin, ['models'], { env, cwd: tmpdir(), limitMs: 60_000 });
    facts.models = { exit: m.exit, stdout: m.stdout, stderr: m.stderr };
    const n = m.stdout.split('\n').filter((l) => l.trim()).length;
    lines.push(m.exit.code === 0 && n ? `ok: agy models (${n} lines)` : `missing: agy models (exit ${JSON.stringify(m.exit)})`);
  }
  const model = MODEL_ARG ?? (/^Probe model:\s*([A-Za-z0-9][\w.:/-]*)\s*$/.exec(ISSUE_PROBE_MODEL_LINE)?.[1]);
  facts.model = model ?? null;
  lines.push(model ? `ok: Probe model ${model}` : 'missing: Probe model (the issue has no slug on its Probe model: line)');
  facts.apiKey = process.env.GEMINI_API_KEY ? 'set' : 'not set';
  lines.push(`ok: GEMINI_API_KEY ${facts.apiKey}`);
  if (bin && prompt) {
    const ctx = makeScratch();
    const args = ['-p', 'Reply with the single word ok.', '--print-timeout', '60s', ...(model ? ['--model', model] : [])];
    const r = await runChild(bin, args, { env: childEnv(HOME), cwd: ctx.wt, limitMs: 90_000 });
    facts.prompt = { args, exit: r.exit, timedOut: r.timedOut, stdout: r.stdout, stderr: r.stderr, ms: r.ms, orphans: r.orphans };
    lines.push(r.exit.code === 0 && /\bok\b/i.test(r.stdout) ? `ok: sign-in without a terminal (prompt answered in ${r.ms} ms)` : `missing: sign-in without a terminal (exit ${JSON.stringify(r.exit)}${r.timedOut ? ', time limit' : ''}: ${redactString((r.stderr || r.stdout).trim().split('\n').slice(-1)[0] ?? '').slice(0, 200)})`);
  }
  return { lines, facts };
}

// ---------------------------------------------------------------- runs
function listDir(root) {
  const out = [];
  const walk = (d, depth) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); out.push(redactString(p) + (e.isDirectory() ? '/' : '')); if (e.isDirectory() && depth < 5) walk(p, depth + 1); } };
  walk(root, 0);
  return out;
}
const BIN = resolveBin(BIN_ARG) ?? BIN_ARG;
const MODEL = MODEL_ARG ?? null;
/** The common headless flags of a model run. */
const HL = ['--model', MODEL, '--output-format', 'stream-json', '--print-timeout', '180s'];
if (argv[0] === '--run' && !MODEL) { console.error('--run needs --model <slug>'); process.exit(64); }
/** A run that was meant to call a model but stopped before one: flag parsing, the credential or the model name. */
const NO_MODEL = /flag needs an argument|flags provided but not defined|Authentication required|invalid model selection|Unknown model ID|unknown setting|empty prompt|failed to decode stream input/;
const ORCH = (tok) => ({ ORCH_LAUNCH_ID: 'probe-launch', ORCH_TOKEN: tok, ORCH_API: 'http://127.0.0.1:9' });
/** The recording shim as an agy mcp_config.json stdio entry (headless) or an ACP mcpServers entry. */
const shimEntry = (ctx, tok, o = {}) => ({ command: o.command ?? process.execPath, args: [SHIM, path.join(ctx.out, 'shim.jsonl'), '--block-sec', String(o.blockSec ?? 75)], env: { ...ORCH(tok), PROBE_MARKER: 'from-entry-env' }, ...(o.timeoutSeconds !== undefined ? { timeoutSeconds: o.timeoutSeconds } : {}) });
const acpShim = (ctx, tok, o = {}) => { const e = shimEntry(ctx, tok, o); return { name: 'orchestrator', command: e.command, args: e.args, env: Object.entries(e.env).map(([name, value]) => ({ name, value })) }; };
const writeJson = (f, o) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(o, null, 2) + '\n'); };

/** Data directories a run may use: the user's ~/.gemini, a scratch home's, or a --gemini-dir. */
function dataDirs(ctx, o) {
  const d = [];
  if (o.home === 'scratch') d.push(path.join(ctx.home, '.gemini'));
  else d.push(path.join(HOME, '.gemini'));
  if (o.geminiDir) d.push(o.geminiDir(ctx));
  return d;
}
function findToken(dirs, tok, extra = {}) {
  const hits = [];
  const walk = (d, depth) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) { if (depth < 8) walk(p, depth + 1); } else if (e.isFile()) { try { if (statSync(p).size < 64 * 1024 * 1024 && readFileSync(p).includes(tok)) hits.push(redactString(p)); } catch {} } } };
  for (const d of dirs) walk(d, 0);
  for (const [label, text] of Object.entries(extra)) if (text && text.includes(tok)) hits.push(label);
  return hits;
}
/** Log files under the data directories written during the run, redacted, the last 200 kB each. */
function newLogs(dirs, before) {
  const out = [];
  for (const d of dirs) {
    const walk = (x, depth) => { let es; try { es = readdirSync(x, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(x, e.name); if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); } else if (/\.log$/.test(e.name)) { try { const s = statSync(p); if (s.mtimeMs >= before) out.push(p); } catch {} } } };
    walk(d, 0);
  }
  return out.map((p) => { const t = readFileSync(p, 'utf8'); return { path: redactString(p), text: redactString(t.length > 200_000 ? t.slice(-200_000) : t) }; });
}
let modelRunsUsed = null;
function modelRunCount() {
  if (modelRunsUsed === null) modelRunsUsed = existsSync(RECORDS) ? readdirSync(RECORDS).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(RECORDS, f), 'utf8'))).filter((r) => r.modelCalls > 0).length : 0;
  return modelRunsUsed;
}

/** Writes one run's evidence and its record at once. */
function saveRun(id, kind, rec, files) {
  const evidence = {};
  for (const [label, { dir, name, text, jsonl }] of Object.entries(files)) {
    if (text === undefined || text === null) continue;
    const f = path.join(HERE, dir, name);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, jsonl ? redactJsonl(text) : redactString(text));
    evidence[label] = path.relative(HERE, f);
  }
  const record = redact({ id, kind, probedAt: now(), ...rec, evidence });
  writeJson(path.join(RECORDS, `${id}.json`), record);
  if (record.modelCalls > 0 && modelRunsUsed !== null) modelRunsUsed++;
  console.error(`[probe] ${id}: exit ${JSON.stringify(record.exit)} ${record.timedOut ? 'TIMED OUT ' : ''}modelCalls ${record.modelCalls} orphans ${JSON.stringify(record.orphans)} (${record.ms} ms)`);
  return record;
}
function shimRecords(ctx) {
  const f = path.join(ctx.out, 'shim.jsonl');
  if (!existsSync(f)) return undefined;
  return readFileSync(f, 'utf8').split('\n').map((l) => { if (!l.startsWith('{')) return l; const o = JSON.parse(l); if (Array.isArray(o.chain)) { const i = o.chain.findIndex((c) => c.pid === process.pid); o.chain = i >= 0 ? o.chain.slice(0, i + 1) : o.chain.slice(0, 4); } return JSON.stringify(o); }).join('\n');
}
const gaps = (lines) => { let max = 0; for (let i = 1; i < lines.length; i++) max = Math.max(max, lines[i].t - lines[i - 1].t); return { lines: lines.length, maxGapMs: max, firstMs: lines[0]?.t ?? null }; };

/**
 * One headless run: `agy <args>` in the scratch worktree. o.home 'user' | 'scratch'; o.setup(ctx, tok) writes files and may
 * return extra args or env; o.stdin text; o.model true when the run calls a model; o.after(ctx) adds fields.
 */
async function headless(id, o) {
  if (o.model && modelRunCount() >= MAX_MODEL_RUNS) { console.error(`[probe] ${id}: skipped, run cap`); return null; }
  const ctx = makeScratch();
  const tok = fakeToken();
  const set = (await o.setup?.(ctx, tok)) ?? {};
  const home = o.home === 'scratch' ? ctx.home : HOME;
  const env = childEnv(home, { ...ORCH(tok), PROBE_MARKER: 'from-agy-env', ...(set.env ?? {}) });
  const args = typeof o.args === 'function' ? o.args(ctx, tok) : o.args;
  const allArgs = [...args, ...(set.args ?? [])];
  const userBefore = hashUser(), listBefore = geminiListing(), t0 = Date.now();
  const r = await runChild(BIN, allArgs, { env, cwd: o.cwd?.(ctx) ?? ctx.wt, stdin: o.stdin?.(ctx), limitMs: o.limitMs ?? 240_000, termAtMs: o.termAtMs });
  const userAfter = hashUser(), listAfter = geminiListing();
  const dirs = dataDirs(ctx, { home: o.home, geminiDir: set.geminiDir ? () => set.geminiDir : undefined });
  const logs = newLogs(dirs, t0 - 1000);
  const shim = shimRecords(ctx);
  const rec = {
    command: [path.basename(BIN), ...allArgs], cwd: o.cwd ? 'custom' : '<scratch>/wt', home: o.home === 'scratch' ? '<scratch>/home' : '~', env: shownEnv(env),
    stdin: o.stdin ? `${o.stdin(ctx).length} bytes` : 'ignore', exit: r.exit, timedOut: r.timedOut, termSent: r.termSent, ms: r.ms,
    modelCalls: o.model && !NO_MODEL.test(r.stderr + r.stdout) ? 1 : 0, orphans: r.orphans, processes: r.processes, stdoutLines: gaps(r.lines),
    token: tok, tokenFoundIn: findToken(dirs, tok, { stdout: r.stdout, stderr: r.stderr }),
    git: gitFacts(ctx), userConfigChanged: Object.keys(userBefore).filter((k) => userBefore[k] !== userAfter[k]).map(redactString), geminiDirChanges: diffListing(listBefore, listAfter),
    logs: logs.map((l) => l.path), ...(set.note ? { note: set.note } : {}), ...((await o.after?.(ctx, r)) ?? {}),
  };
  const files = { stdout: { dir: 'headless', name: `${id}.stdout.txt`, text: r.stdout, jsonl: /json/.test(allArgs.join(' ')) }, stderr: { dir: 'headless', name: `${id}.stderr.txt`, text: r.stderr }, shim: { dir: 'shim', name: `${id}.jsonl`, text: shim, jsonl: true } };
  logs.forEach((l, i) => { files[`log${i}`] = { dir: 'headless', name: `${id}.log${i}.txt`, text: l.text }; });
  if (set.files) for (const [k, f] of Object.entries(set.files)) files[k] = { dir: 'headless', name: `${id}.${k}`, text: readFileSync(f, 'utf8') };
  return saveRun(id, 'headless', rec, files);
}

/** One ACP run: acp-client.mjs drives `agy acp <agentArgs>` in the scratch worktree. */
async function acp(id, o) {
  if (o.model && modelRunCount() >= MAX_MODEL_RUNS) { console.error(`[probe] ${id}: skipped, run cap`); return null; }
  const ctx = makeScratch();
  const tok = fakeToken();
  const set = (await o.setup?.(ctx, tok)) ?? {};
  const home = o.home === 'scratch' ? ctx.home : HOME;
  const frames = path.join(ctx.out, 'frames.jsonl');
  const cargs = [CLIENT, '--agent-json', JSON.stringify([BIN, 'acp', ...(o.agentArgs ?? []), ...(set.agentArgs ?? [])]), '--cwd', ctx.wt, '--frames', frames, '--turn-timeout-ms', String(o.turnTimeoutMs ?? 240_000), '--cancel-grace-ms', '5000'];
  if (o.mcp !== false) { writeJson(path.join(ctx.out, 'mcp.json'), o.mcp ? o.mcp(ctx, tok) : [acpShim(ctx, tok, o.shim)]); cargs.push('--mcp-json', path.join(ctx.out, 'mcp.json')); }
  if (o.prompt) { writeFileSync(path.join(ctx.out, 'prompt.txt'), o.prompt(ctx)); cargs.push('--prompt-file', path.join(ctx.out, 'prompt.txt')); }
  if (o.policy) { writeJson(path.join(ctx.out, 'policy.json'), o.policy); cargs.push('--policy', path.join(ctx.out, 'policy.json')); }
  if (o.noAnswer) cargs.push('--no-permission-answer');
  if (o.requests) { writeJson(path.join(ctx.out, 'requests.json'), o.requests); cargs.push('--requests-json', path.join(ctx.out, 'requests.json')); }
  const env = childEnv(home, { ...ORCH(tok), PROBE_MARKER: 'from-agent-env', ...(set.env ?? {}) });
  const userBefore = hashUser(), listBefore = geminiListing(), t0 = Date.now();
  const r = await runChild(process.execPath, cargs, { env, cwd: ctx.wt, limitMs: o.limitMs ?? 300_000, termAtMs: o.termAtMs });
  const userAfter = hashUser(), listAfter = geminiListing();
  const dirs = dataDirs(ctx, { home: o.home, geminiDir: set.geminiDir ? () => set.geminiDir : undefined });
  const logs = newLogs(dirs, t0 - 1000);
  const framesText = existsSync(frames) ? readFileSync(frames, 'utf8') : undefined;
  const fl = (framesText ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let maxGap = 0; for (let i = 1; i < fl.length; i++) maxGap = Math.max(maxGap, fl[i].t - fl[i - 1].t);
  const rec = {
    command: ['node', 'acp-client.mjs', ...cargs.slice(1).map((a) => redactString(a))], home: o.home === 'scratch' ? '<scratch>/home' : '~', env: shownEnv(env),
    exit: r.exit, timedOut: r.timedOut, termSent: r.termSent, ms: r.ms, modelCalls: o.model && /"stage":"session\/prompt"/.test(r.stdout) ? 1 : 0, orphans: r.orphans, processes: r.processes,
    frameStats: { frames: fl.length, maxGapMs: maxGap },
    token: tok, tokenFoundIn: findToken(dirs, tok, { clientStdout: r.stdout, agentStderr: r.stderr, frames: framesText }),
    git: gitFacts(ctx), userConfigChanged: Object.keys(userBefore).filter((k) => userBefore[k] !== userAfter[k]).map(redactString), geminiDirChanges: diffListing(listBefore, listAfter),
    logs: logs.map((l) => l.path), ...((await o.after?.(ctx, r)) ?? {}),
  };
  const files = { frames: { dir: 'acp', name: `${id}.frames.jsonl`, text: framesText, jsonl: true }, client: { dir: 'acp', name: `${id}.client.jsonl`, text: r.stdout, jsonl: true }, stderr: { dir: 'acp', name: `${id}.stderr.txt`, text: r.stderr }, shim: { dir: 'shim', name: `${id}.jsonl`, text: shimRecords(ctx), jsonl: true } };
  logs.forEach((l, i) => { files[`log${i}`] = { dir: 'acp', name: `${id}.log${i}.txt`, text: l.text }; });
  return saveRun(id, 'acp', rec, files);
}

// ---------------------------------------------------------------- results
function check() {
  let r;
  try { r = JSON.parse(readFileSync(RESULTS, 'utf8')); } catch (err) { console.log(`agy probe: results.json does not parse (${err.message})`); return 1; }
  const problems = [];
  const bad = new Set();
  const flag = (id, text) => { if (id) bad.add(id); problems.push(`${id ?? 'results.json'}: ${text}`); };
  for (const k of ['cli', 'bin', 'version', 'model', 'credential', 'probedAt', 'questions', 'runs', 'userConfig']) if (r[k] === undefined) flag(null, `lacks ${k}`);
  for (let n = 1; n <= 16; n++) {
    const id = `Q${n}`;
    const q = (r.questions ?? []).find((x) => x.id === id);
    if (!q) { flag(id, 'missing'); continue; }
    if (!['yes', 'no', 'partly', 'blocked'].includes(q.answer)) flag(id, `answer ${JSON.stringify(q.answer)}`);
    if (!q.summary) flag(id, 'no summary');
    if (!Array.isArray(q.commands) || !q.commands.length) flag(id, 'no commands');
    if (!Array.isArray(q.evidence) || !q.evidence.length) flag(id, 'no evidence');
    for (const e of q.evidence ?? []) if (!existsSync(path.join(HERE, e))) flag(id, `evidence file ${e} does not exist`);
    if (q.answer === 'blocked' && !q.reason) flag(id, 'blocked without a reason');
    if (id === 'Q1' && q.answer === 'blocked') flag(id, 'Q1 is blocked');
  }
  for (const f of USER_FILES.map(redactString)) if (!(r.userConfig ?? []).some((u) => u.path === f && u.sha256Before && u.sha256After)) flag(null, `userConfig lacks ${f}`);
  const modelRuns = (r.runs ?? []).filter((x) => x.modelCalls > 0).length;
  if (modelRuns > MAX_MODEL_RUNS) flag(null, `${modelRuns} runs called a model, more than ${MAX_MODEL_RUNS}`);
  for (const run of r.runs ?? []) {
    if (!Array.isArray(run.orphans)) flag(null, `run ${run.id} has no orphans list`);
    for (const f of Object.values(run.evidence ?? {})) if (!existsSync(path.join(HERE, f))) flag(null, `run ${run.id}: evidence ${f} does not exist`);
  }
  for (const p of problems) console.log(p);
  console.log(`agy probe: ${16 - [...bad].filter((id) => /^Q([1-9]|1[0-6])$/.test(id)).length} of 16 questions recorded`);
  return problems.length ? 1 : 0;
}

function assemble() {
  const runs = existsSync(RECORDS) ? readdirSync(RECORDS).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(path.join(RECORDS, f), 'utf8'))) : [];
  const prev = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {};
  const answers = JSON.parse(readFileSync(path.join(HERE, 'answers.json'), 'utf8'));
  const results = { ...answers.header, questions: answers.questions, userConfig: answers.userConfig, runs };
  const tmp = `${RESULTS}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(results, null, 2) + '\n');
  renameSync(tmp, RESULTS);
}

// ---------------------------------------------------------------- main
const RUNS = {};
export { RUNS };
if (argv[0] === '--check') process.exit(check());
// Applies the current redaction again to every evidence file (added after the runs for the user name and process listings).
if (argv[0] === '--scrub') {
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) { const t = readFileSync(p, 'utf8'); const n = /\.json$/.test(p) ? JSON.stringify(redact(JSON.parse(t)), null, 2) + '\n' : redactJsonl(t); if (n !== t) { writeFileSync(p, n); console.error(`[scrub] ${path.relative(HERE, p)}`); } } } };
  for (const d of ['headless', 'acp', 'shim', 'records']) walk(path.join(HERE, d));
  process.exit(0);
}
if (argv[0] === '--assemble') { assemble(); process.exit(check()); }
if (argv[0] === '--preflight') {
  const { lines, facts } = await preflight({ prompt: !argv.includes('--no-prompt') });
  for (const l of lines) console.log(l);
  const f = path.join(HERE, 'headless', 'preflight.json');
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(redact({ at: now(), lines, facts }), null, 2) + '\n');
  writeFileSync(path.join(HERE, 'headless', 'preflight.txt'), redactString(lines.join('\n') + '\n'));
  process.exit(0);
}
if (argv[0] !== '--run') { console.error('usage: node probe.mjs --preflight | --run R1,R2 | --assemble | --check'); process.exit(64); }

// ---------------------------------------------------------------- the runs of this probe
const P1 = 'Reply with the single word ok.';
const SHIM_PROMPT = 'Call the heartbeat tool of the orchestrator MCP server with progress "probe". Then reply with the exact names under which you see the tools of that server, one per line.';
const A1_PROMPT = 'Do these four steps in order. 1. Call the heartbeat tool of the orchestrator MCP server with progress "probe". 2. Run the shell command `git status --short` in the current directory. 3. Write a file named note.txt in the current directory containing the word hi. 4. Reply with the exact names under which you see the tools of the orchestrator server, and say which steps failed.';
const SET_MODEL = () => [{ when: 'afterSession', method: 'session/set_model', params: { sessionId: '{sessionId}', modelId: MODEL } }];
const fourSteps = (ctx) => `Do these four steps in order, and go on with the next step when one fails. 1. Run the shell command \`git status --short\` in the current directory. 2. Write a file named note.txt in the current directory containing the word hi. 3. Write a file at the absolute path ${ctx.scratch}/outside.txt containing the word hi. 4. Call the heartbeat tool of the orchestrator MCP server with progress "probe". Then reply with one line per step saying whether it worked and what you were told.`;
/** The shim registered from a per-launch directory outside the worktree (<scratch>/home/launch), added with --add-dir. */
function addDirShim(ctx, tok, o = {}) { const d = o.dir ?? path.join(ctx.home, 'launch'); const f = path.join(d, '.agents', 'mcp_config.json'); writeJson(f, { mcpServers: { orchestrator: shimEntry(ctx, tok, o) } }); return { args: ['--add-dir', d], files: { 'mcp_config.json': f } }; }
const outsideFile = (ctx) => ({ outsideFile: existsSync(path.join(ctx.scratch, 'outside.txt')), noteFile: existsSync(path.join(ctx.wt, 'note.txt')) });
const BLOCK_PROMPT = 'Call the block tool of the orchestrator MCP server with seq 1, kind needsDecision and message "probe question". Wait for its answer. Then reply with the answer you got, or with the exact error text if the call failed.';
const COMMIT_PROMPT = 'You work in a git worktree on the branch task/PROBE/l1. Create a file hello.txt containing the line hello from agy, then commit it with git: git add hello.txt && git commit -m "add hello". Reply with the output of git log --oneline -1.';
function bigPrompt() {
  const lines = [];
  for (let i = 1; lines.join('\n').length < 30_000; i++) lines.push(`Filler line ${i}: this text only makes the prompt about 30 KB long; ignore it.`);
  return `${lines.join('\n')}\nThe last filler line above has a number. Reply with exactly the word ready, a space, and that number.\n`;
}
Object.assign(RUNS, {
  // No model: help texts, an unknown flag, no credential.
  'N1-help': () => headless('N1-help', { args: ['--help'], limitMs: 30_000 }),
  'N1-acp-help': () => headless('N1-acp-help', { args: ['acp', '--help'], limitMs: 30_000 }),
  'N1-models': () => headless('N1-models', { args: ['models'], limitMs: 60_000 }),
  'N2-badflag': () => headless('N2-badflag', { args: ['-p', P1, '--no-such-flag'], limitMs: 30_000 }),
  'N3-noauth-json': () => headless('N3-noauth-json', { args: ['-p', P1, '--output-format', 'json', '--print-timeout', '10s'], limitMs: 60_000 }),
  'N4-mcp-help': () => headless('N4-mcp-help', { args: ['mcp', '--help'], limitMs: 30_000 }),
  'N4-mcp-list-wt': () => headless('N4-mcp-list-wt', { args: ['mcp', 'list'], limitMs: 30_000, setup: (ctx, tok) => { const f = path.join(ctx.wt, '.agents', 'mcp_config.json'); writeJson(f, { mcpServers: { orchestrator: shimEntry(ctx, tok) } }); return { files: { 'mcp_config.json': f } }; } }),
  'N4-mcp-list-home': () => headless('N4-mcp-list-home', { home: 'scratch', args: ['mcp', 'list'], limitMs: 30_000, setup: (ctx, tok) => { const f = path.join(ctx.home, '.gemini', 'config', 'mcp_config.json'); writeJson(f, { mcpServers: { orchestrator: shimEntry(ctx, tok) } }); return { files: { 'mcp_config.json': f } }; } }),
  'N4-mcp-list-settings': () => headless('N4-mcp-list-settings', { args: ['mcp', 'list', '--settings', '{"mcpServers":{"viasettings":{"command":"true"}}}'], limitMs: 30_000 }),
  'N5-settings-bad': () => headless('N5-settings-bad', { args: ['-p', P1, '--print-timeout', '10s', '--settings', '{not json'], limitMs: 15_000 }),
  'N5-settings-unknown': () => headless('N5-settings-unknown', { args: ['-p', P1, '--print-timeout', '10s', '--settings', '{"noSuchKey":1,"permissions":{"allow":["command(git)","mcp(orchestrator/*)"]}}'], limitMs: 15_000 }),
  'A0-gemdir': () => acp('A0-gemdir', { limitMs: 60_000, setup: (ctx) => { const g = path.join(ctx.home, 'gem'); return { agentArgs: ['--gemini-dir', g], geminiDir: g }; }, after: (ctx) => ({ geminiDirListing: listDir(path.join(ctx.home, 'gem')) }) }),
  'A0-home': () => acp('A0-home', { home: 'scratch', limitMs: 60_000, after: (ctx) => ({ homeListing: listDir(ctx.home) }) }),
  'A0-auth-key': () => acp('A0-auth-key', { limitMs: 60_000, requests: [{ when: 'beforeSession', method: 'authenticate', params: { methodId: 'gemini-api-key' } }] }),
  'N5-settings-mcp': () => headless('N5-settings-mcp', { args: ['-p', P1, '--print-timeout', '1s', '--settings', '{"mcpServers":{}}'], limitMs: 30_000 }),
  'N6-gemdir-p': () => headless('N6-gemdir-p', { args: ['-p', P1, '--print-timeout', '1s', '--gemini-dir', '/nonexistent-probe-dir'], limitMs: 30_000 }),
  'A0-session': () => acp('A0-session', { limitMs: 60_000, requests: [{ when: 'afterSession', method: 'session/set_config_option', params: { sessionId: '{sessionId}', configId: 'model', value: 'no-such-model' } }, { when: 'afterSession', method: 'session/set_model', params: { sessionId: '{sessionId}', modelId: 'no-such-model' } }] }),
  // Model runs.
  'H2-stdin': () => headless('H2-stdin', { model: true, args: ['--model', MODEL, '--output-format', 'stream-json', '--print-timeout', '180s', '-p', ''], stdin: () => bigPrompt(), limitMs: 240_000 }),
  'H3-home': () => headless('H3-home', { model: true, home: 'scratch', args: ['-p', P1, '--model', MODEL, '--output-format', 'json', '--print-timeout', '180s'], limitMs: 100_000, after: (ctx) => ({ homeListing: listDir(ctx.home) }) }),
  'H4a-wt': () => headless('H4a-wt', { model: true, args: ['-p', SHIM_PROMPT, '--model', MODEL, '--output-format', 'stream-json', '--print-timeout', '180s', '--dangerously-skip-permissions'], limitMs: 240_000,
    setup: (ctx, tok) => { const f = path.join(ctx.wt, '.agents', 'mcp_config.json'); writeJson(f, { mcpServers: { orchestrator: shimEntry(ctx, tok) } }); return { files: { 'mcp_config.json': f } }; } }),
  'H2-stdin-json': () => headless('H2-stdin-json', { model: true, args: ['--model', MODEL, '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '180s'], limitMs: 240_000,
    // The input shape is not documented; H2-stdin-json-try1 (headless/attempts/) learned that `message` is an object.
    stdin: () => JSON.stringify({ event: 'user', message: { role: 'user', content: bigPrompt() } }) + '\n' }),
  'H4a-wt': () => headless('H4a-wt', { model: true, args: ['-p', SHIM_PROMPT, '--model', MODEL, '--output-format', 'stream-json', '--print-timeout', '180s', '--dangerously-skip-permissions'], limitMs: 240_000,
    setup: (ctx, tok) => { const f = path.join(ctx.wt, '.agents', 'mcp_config.json'); writeJson(f, { mcpServers: { orchestrator: shimEntry(ctx, tok) } }); return { files: { 'mcp_config.json': f } }; } }),
  // A per-launch directory outside the worktree, added with --add-dir, holding .agents/mcp_config.json.
  'H4b-adddir': () => headless('H4b-adddir', { model: true, args: ['-p', SHIM_PROMPT, '--model', MODEL, '--output-format', 'stream-json', '--print-timeout', '180s', '--dangerously-skip-permissions'], limitMs: 240_000,
    setup: (ctx, tok) => { const d = path.join(ctx.home, 'launch'); const f = path.join(d, '.agents', 'mcp_config.json'); writeJson(f, { mcpServers: { orchestrator: shimEntry(ctx, tok) } }); return { args: ['--add-dir', d], files: { 'mcp_config.json': f } }; } }),
  'A1-shim': () => acp('A1-shim', { model: true, prompt: () => A1_PROMPT, policy: { default: 'allow', reject: [{ title: '*git*' }, { command: '*git*' }] }, requests: SET_MODEL(), limitMs: 300_000 }),
  'H9-norule': () => headless('H9-norule', { model: true, args: (ctx) => ['-p', fourSteps(ctx), ...HL], limitMs: 240_000, setup: addDirShim, after: outsideFile }),
  'H10a-skip': () => headless('H10a-skip', { model: true, args: (ctx) => ['-p', fourSteps(ctx), ...HL, '--dangerously-skip-permissions'], limitMs: 240_000, setup: addDirShim, after: outsideFile }),
  'H10b-rules': () => headless('H10b-rules', { model: true, args: (ctx) => ['-p', fourSteps(ctx), ...HL, '--settings', JSON.stringify({ permissions: { allow: ['command(git)', `write_file(${ctx.scratch}/)`, 'mcp(orchestrator/*)'] } })], limitMs: 240_000, setup: addDirShim, after: outsideFile }),
  'H7-badshim': () => headless('H7-badshim', { model: true, args: ['-p', SHIM_PROMPT, ...HL, '--dangerously-skip-permissions'], limitMs: 240_000, setup: (ctx, tok) => addDirShim(ctx, tok, { command: path.join(ctx.scratch, 'no-such-shim') }) }),
  'A7-badshim': () => acp('A7-badshim', { model: true, prompt: () => SHIM_PROMPT, mcp: (ctx, tok) => [acpShim(ctx, tok, { command: path.join(ctx.scratch, 'no-such-shim') })], policy: { default: 'allow' }, requests: SET_MODEL(), limitMs: 300_000 }),
  'A11-noanswer': () => acp('A11-noanswer', { model: true, prompt: () => 'Run the shell command `git status --short` in the current directory and reply with its output.', noAnswer: true, requests: SET_MODEL(), termAtMs: 130_000, limitMs: 200_000 }),
  // Started together: two headless runs (default limit, timeoutSeconds 300) and one ACP run, each with a 200 s block answer.
  'H8-trio': () => Promise.all([
    headless('H8a-block-default', { model: true, args: ['-p', BLOCK_PROMPT, '--model', MODEL, '--output-format', 'stream-json', '--print-timeout', '400s', '--dangerously-skip-permissions'], limitMs: 420_000, setup: (ctx, tok) => addDirShim(ctx, tok, { blockSec: 200 }) }),
    headless('H8b-block-300', { model: true, args: ['-p', BLOCK_PROMPT, '--model', MODEL, '--output-format', 'stream-json', '--print-timeout', '400s', '--dangerously-skip-permissions'], limitMs: 420_000, setup: (ctx, tok) => addDirShim(ctx, tok, { blockSec: 200, timeoutSeconds: 300 }) }),
    acp('A8-block', { model: true, prompt: () => BLOCK_PROMPT, shim: { blockSec: 200 }, policy: { default: 'allow' }, requests: SET_MODEL(), turnTimeoutMs: 400_000, limitMs: 420_000 }),
  ]),
  'H12a-commit': () => headless('H12a-commit', { model: true, args: ['-p', COMMIT_PROMPT, ...HL, '--dangerously-skip-permissions'], limitMs: 240_000 }),
  'H12b-commit-sandbox': () => headless('H12b-commit-sandbox', { model: true, args: ['-p', COMMIT_PROMPT, ...HL, '--dangerously-skip-permissions', '--sandbox'], limitMs: 240_000 }),
  'H13-effort': () => headless('H13-effort', { model: true, args: ['-p', P1, '--model', 'gemini-3.8-flash', '--effort', 'low', '--output-format', 'stream-json', '--print-timeout', '180s'], limitMs: 240_000 }),
  'H15-timeout': () => headless('H15-timeout', { model: true, args: ['-p', 'Run the shell command `sleep 60` in the current directory, wait for it, and then reply with the word done.', '--model', MODEL, '--output-format', 'json', '--print-timeout', '10s', '--dangerously-skip-permissions'], limitMs: 120_000 }),
  // As H9, with the per-launch directory at <scratch>/zz-launch, which sorts after <scratch>/wt (H9 ran its commands in <scratch>/home/launch).
  'H9b-norule-order': () => headless('H9b-norule-order', { model: true, args: (ctx) => ['-p', fourSteps(ctx), ...HL], limitMs: 240_000, setup: (ctx, tok) => addDirShim(ctx, tok, { dir: path.join(ctx.scratch, 'zz-launch') }), after: outsideFile }),
  // The last model run of the cap: A8 again, with timeoutSeconds both as a field of the ACP stdio entry and under its _meta.
  'A8b-block-meta': () => acp('A8b-block-meta', { model: true, prompt: () => BLOCK_PROMPT, mcp: (ctx, tok) => [{ ...acpShim(ctx, tok, { blockSec: 200 }), timeoutSeconds: 300, _meta: { timeoutSeconds: 300 } }], policy: { default: 'allow' }, requests: SET_MODEL(), turnTimeoutMs: 400_000, limitMs: 420_000 }),
  'A0-init': () => acp('A0-init', { limitMs: 60_000 }),
});

if (argv[0] === '--run') {
  const ids = (argv[1] ?? '').split(',').filter(Boolean);
  for (const id of ids) if (!RUNS[id]) { console.error(`unknown run ${id}`); process.exit(64); }
  for (const id of ids) await RUNS[id]();
  process.exit(0);
}
