#!/usr/bin/env node
// Probe (GH-199): Hermes Agent (`hermes`) as a worker harness, headless (`hermes -z`, `hermes chat -q`) and over ACP
// (`hermes acp`, driven by ../acp/acp-client.mjs with ../acp/recording-shim.mjs as the shim).
//
//   node probe.mjs --preflight [--bin <path>] [--provider <p> --model <m>]
//                                  one line per prerequisite, `ok: <what> <detail>` or `missing: <what>`; writes
//                                  headless/preflight.txt
//   node probe.mjs --run <ids>     runs those scenarios (comma separated), each in a fresh scratch directory, and writes their
//                                  evidence and records/<run>.json as soon as each ends, then rebuilds results.json
//   node probe.mjs --assemble      rebuilds results.json from records/ and answers.json (no model, no hermes)
//   node probe.mjs --check         checks results.json and every evidence file it names, and scans every evidence file for
//                                  host data (the user name, a temporary root, Hermes' host reports, an environment listing)
//   node probe.mjs --scrub         rewrites every evidence file with the current redaction (no model, no hermes)
//
// Every CLI runs here as a detached child that leads its own process group, under a hard time limit; at the limit the script
// signals that group (-pid) and nothing else. Children get a short environment built here (PATH, HOME, USER, LANG, TMPDIR,
// HERMES_HOME under the scratch directory, the variables a scenario names, the three fake ORCH_* values and the marker), never
// the caller's. The scratch directory lives under the real path of os.tmpdir(), outside this repository, and is removed in an
// exit handler that also runs when the script fails. Evidence is redacted: the scratch directory becomes <scratch>, the home
// directory ~, every git identity Fixture Author <author@example.invalid>; before an evidence file is written it is checked
// for every value of the copied credential files.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACP = path.join(path.dirname(HERE), 'acp');
const CLIENT = path.join(HERE, 'acp-client.local.mjs'); // ../acp/acp-client.mjs plus --keep-descendants
const SHIM = path.join(ACP, 'recording-shim.mjs');
const RESULTS = path.join(HERE, 'results.json');
const ANSWERS = path.join(HERE, 'answers.json');
const RECORDS = path.join(HERE, 'records');
const HOME = homedir();
const USER_HOME = path.join(HOME, '.hermes');
const REPO = path.resolve(HERE, '..', '..', '..');
const PROMPT_OK = 'Reply with the single word ok.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const o = { bin: 'hermes' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${a} needs a value`); return x; };
    if (a === '--preflight') o.mode = 'preflight';
    else if (a === '--check') o.mode = 'check';
    else if (a === '--scrub') o.mode = 'scrub';
    else if (a === '--assemble') o.mode = 'assemble';
    else if (a === '--run') { o.mode = 'run'; o.runs = v().split(',').filter(Boolean); }
    else if (a === '--bin') o.bin = v();
    else if (a === '--provider') o.provider = v();
    else if (a === '--model') o.model = v();
    else if (a === '--brief') o.brief = v();
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

// ---------------------------------------------------------------- redaction and the credential guard
let scratchRoots = [];
const TMP_ROOTS = [...new Set([realpathSync(tmpdir()), realpathSync(tmpdir()).replace(/^\/private/, '')])].map((t) => t.replace(/\/$/, '')).sort((a, b) => b.length - a.length);
let secretValues = []; // values of the copied credential files: never written to evidence
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IDENTITY = /^(\s*(?:Author|Commit|Committer|Signed-off-by|Co-Authored-By):\s*)[^<\n]*?(\s*<|$)/gim;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
// Hermes' own host reports: the SIGTERM diagnostics (ps of the whole host, pstree, load, dmesg) and the start-up security audit.
const DIAG_REMOVED = '=== shutdown diagnostic removed: it listed every process of the host ===';
const DIAG_SECTION = /(==> logs\/gateway-shutdown-diag\.log <==\n)[\s\S]*?(?=\n==> |$)/g;
const DIAG_BLOCK = /=== shutdown diagnostic @[^\n]*===[\s\S]*?(?:=== end ===|(?=\n==> )|$)/g;
const AUDIT_LINE = /^.*hermes\.security_audit.*(?:\r?\n|$)/gm;
const dropHostReports = (s) => s.replace(DIAG_SECTION, `$1${DIAG_REMOVED}\n`).replace(DIAG_BLOCK, DIAG_REMOVED).replace(AUDIT_LINE, '');
function redactString(s) {
  let out = dropHostReports(s.replace(ANSI, ''));
  for (const root of scratchRoots) out = out.split(root).join('<scratch>');
  out = out.split(REPO).join('<repo>');
  for (const t of TMP_ROOTS) out = out.split(t).join('<tmpdir>');
  out = out.split(HOME).join('~');
  out = out.replace(IDENTITY, (_, a, b) => `${a}Fixture Author${b}`).replace(EMAIL, 'author@example.invalid');
  for (const v of secretValues) out = out.split(v).join('<credential>');
  return redactHost(out);
}
function redact(v) {
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactString(k), redact(x)]));
  return v;
}
const redactJsonl = (text) => text.split('\n').map((l) => { if (!l.trim()) return l; try { return JSON.stringify(redact(JSON.parse(l))); } catch { return redactString(l); } }).join('\n');

// ---------------------------------------------------------------- host data (GH-208)
// The same rules in the three probes (acp/opencode, agy, hermes), each with its own copy; none imports from src/. redactString
// applies them when evidence is written, --scrub applies them again to every evidence file, and --check scans every evidence
// file and fails, naming the file with counts only, when one still holds host data.
const HOST_USER = (() => { try { return userInfo().username; } catch { return ''; } })();
const HOST_USER_WORD = HOST_USER.length > 1 ? new RegExp(`(?<![A-Za-z0-9_])${HOST_USER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g') : null;
/** The temporary root (the real path of os.tmpdir()), with and without /private, longest first. */
const HOST_TMP = (() => { let t = tmpdir(); try { t = realpathSync(t); } catch {} t = t.replace(/\/+$/, ''); return [...new Set([t, t.replace(/^\/private(?=\/)/, '')])].filter((x) => x.length > 1).sort((a, b) => b.length - a.length); })();
const ENV_KEEP = /^(?:ORCH_\w*|PROBE_MARKER|HOME|PWD|LANG|TERM|SHLVL)$/;
const ENV_SEP = /(\r?\n|(?:\\+r)?\\+n)/; // a line break, plain or escaped once or more
const ENV_HEAD = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const ENV_QUOTED = /^(.*?(\\*["']))([A-Za-z_][A-Za-z0-9_]*)=/s; // a listing that starts inside a (JSON) string
const ENV_PLACEHOLDER = /^<(?:value|project)>$/; // a value this rule already wrote
const PS_ROW = /\s\d+\s+\d+[.,]\d+\s+\d+[.,]\d+\s+\d+\s+\d+\s+(?:\?\??|s\d+|ttys?\d+|pts\/\d+)\s/g;
const PS_REMOVED = '<removed: a process listing>';
// A shell PATH list, also without its name (a cut output): four or more absolute directories joined by `:`, one of them a
// system bin directory. Words after a space that do not start with `/` belong to a directory (`Application Support`).
const PATH_LIST = /[~/][^\s:"'\\]*(?: [^\s:"'\\/~][^\s:"'\\]*)*(?::[~/][^\s:"'\\]*(?: [^\s:"'\\/~][^\s:"'\\]*)*){3,}/g;
const redactPathList = (s) => s.replace(PATH_LIST, (m) => (m.split(':').some((d) => /^\/(?:usr\/)?s?bin\/?$/.test(d)) ? '<PATH>' : m));
/**
 * An environment listing: three or more NAME=value lines in a row in one string, with plain or escaped line breaks. Each
 * value outside ENV_KEEP becomes valueFor(name) (`<value>`); a value this rule already wrote stays. A listing that
 * starts inside a quoted string ends its last value at the matching quote.
 */
function redactEnvListing(s, valueFor = () => '<value>') {
  if (typeof s !== 'string' || !s.includes('=')) return s;
  const parts = s.split(ENV_SEP); // even indices: lines; odd: the breaks
  const lines = [];
  let quote = null;
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i];
    let m = ENV_HEAD.exec(seg), e = null;
    if (m) e = { i, pre: '', name: m[1], rest: seg.slice(m[0].length) };
    else if ((m = ENV_QUOTED.exec(seg))) { quote = m[2]; e = { i, pre: m[1], name: m[3], rest: seg.slice(m[0].length) }; }
    else quote = null;
    if (e) {
      const k = quote ? e.rest.indexOf(quote) : -1;
      e.value = k >= 0 ? e.rest.slice(0, k) : e.rest;
      e.post = k >= 0 ? e.rest.slice(k) : '';
      if (k >= 0) quote = null;
    }
    lines.push(e);
  }
  let run = [];
  const flush = () => {
    if (run.length >= 3) for (const e of run) if (!ENV_KEEP.test(e.name) && !ENV_PLACEHOLDER.test(e.value)) parts[e.i] = `${e.pre}${e.name}=${valueFor(e.name)}${e.post}`;
    run = [];
  };
  for (const e of lines) { if (!e) { flush(); continue; } run.push(e); if (e.post) flush(); }
  flush();
  return parts.join('');
}
/** The host rules, applied after the scratch, checkout and home paths are rewritten. */
function redactHost(s, { envValue } = {}) {
  let out = s;
  for (const t of HOST_TMP) out = out.split(t).join('<tmpdir>');
  if (HOST_USER_WORD) out = out.replace(HOST_USER_WORD, '<user>');
  out = redactPathList(redactEnvListing(out, envValue));
  if ((out.match(PS_ROW) ?? []).length >= 3) out = PS_REMOVED;
  return out;
}
/** Every evidence file under root: every file but the scripts and the README. */
function evidenceFiles(root) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() && !/\.m?js$/.test(e.name) && e.name !== 'README.md') out.push(p); } };
  walk(root);
  return out.sort();
}
const isJsonLine = (l) => { if (!/^\s*[[{]/.test(l)) return false; try { JSON.parse(l); return true; } catch { return false; } };
/** How the probe writes a file: a .json file whole, a JSON-lines file line by line, anything else as one string. */
function evidenceKind(p, text) {
  if (/\.json$/.test(p)) { try { return { kind: 'json', value: JSON.parse(text) }; } catch {} }
  const lines = text.split('\n').filter((l) => l.trim());
  return { kind: lines.length && (/\.jsonl$/.test(p) || lines.every(isJsonLine)) ? 'jsonl' : 'text' };
}
function evidenceStrings(p, text) {
  const k = evidenceKind(p, text);
  if (k.kind === 'text') return [text];
  const out = [];
  const walk = (v) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [key, x] of Object.entries(v)) { out.push(key); walk(x); } };
  if (k.kind === 'json') walk(k.value);
  else for (const l of text.split('\n')) { if (!l.trim()) continue; try { walk(JSON.parse(l)); } catch { out.push(l); } }
  return out;
}
const countOf = (s, needle) => s.split(needle).length - 1;
const HOST_CHECKS = [
  ['user name', (s) => (HOST_USER_WORD ? (s.match(HOST_USER_WORD) ?? []).length : 0)],
  ['temporary root', (s) => countOf(s, HOST_TMP[HOST_TMP.length - 1])],
  ['hermes.security_audit', (s) => countOf(s, 'hermes.security_audit')],
  ['shutdown diagnostic', (s) => countOf(s, '=== shutdown diagnostic @')],
  ['environment listing', (s) => (redactEnvListing(s) !== s ? 1 : 0)],
  ['PATH list', (s) => (redactPathList(s) !== s ? 1 : 0)],
];
/** One problem per evidence file under root that holds host data: its name and the counts, never the text. */
function scanHost(root) {
  const problems = [];
  for (const p of evidenceFiles(root)) {
    const counts = {};
    for (const s of evidenceStrings(p, readFileSync(p, 'utf8'))) for (const [label, f] of HOST_CHECKS) { const n = f(s); if (n) counts[label] = (counts[label] ?? 0) + n; }
    const found = Object.entries(counts);
    if (found.length) problems.push(`${path.relative(root, p)}: host data (${found.map(([k, n]) => `${k} ${n}`).join(', ')})`);
  }
  return problems;
}
/** Rewrites every evidence file under root with the current redaction; a line or file whose value does not change is kept. */
function scrubEvidence(root, before) {
  const files = evidenceFiles(root);
  if (before) before(files);
  let changed = 0;
  for (const p of files) {
    const t = readFileSync(p, 'utf8');
    const k = evidenceKind(p, t);
    let out = t;
    if (k.kind === 'json') { const r = redact(k.value); if (JSON.stringify(r) !== JSON.stringify(k.value)) out = JSON.stringify(r, null, 2) + '\n'; }
    else if (k.kind === 'jsonl') out = t.split('\n').map((l) => { if (!l.trim()) return l; try { const v = JSON.parse(l); const r = redact(v); return JSON.stringify(r) === JSON.stringify(v) ? l : JSON.stringify(r); } catch { return redactString(l); } }).join('\n');
    else out = redactString(t);
    if (out !== t) { writeFileSync(p, out); changed++; console.error(`[scrub] ${path.relative(root, p)}`); }
  }
  console.error(`[scrub] ${changed} of ${files.length} evidence files rewritten`);
  return changed;
}

/** Credential-shaped values of a copied file, for the guard: in a .env the values of *KEY*, *TOKEN*, *SECRET* and
 *PASSWORD* names; in a JSON file the string leaves under such keys (and access/refresh token fields). 12 characters or more. */
function credentialValues(file) {
  const out = [];
  const NAME = /key|token|secret|password|credential|auth/i;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return out; }
  try {
    const walk = (v, k = '') => { if (typeof v === 'string') { if (v.length >= 12 && NAME.test(k)) out.push(v); } else if (v && typeof v === 'object') for (const [kk, x] of Object.entries(v)) walk(x, NAME.test(k) ? k : kk); };
    walk(JSON.parse(text));
  } catch {
    for (const line of text.split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m && NAME.test(m[1])) { const val = m[2].trim().replace(/^['"]|['"]$/g, ''); if (val.length >= 12) out.push(val); }
    }
  }
  return out;
}
/** Writes an evidence file under this directory, redacted, after checking it holds no copied credential value. */
function writeEvidence(rel, text) {
  const file = path.join(HERE, rel);
  const body = rel.endsWith('.jsonl') ? redactJsonl(text) : rel.endsWith('.json') ? JSON.stringify(redact(JSON.parse(text)), null, 2) + '\n' : redactString(text);
  for (const v of secretValues) if (body.includes(v)) throw new Error(`refusing to write ${rel}: it holds a value of a copied credential file`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return rel;
}

// ---------------------------------------------------------------- scratch
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.invalid', GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'author@example.invalid' };
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...GIT_ENV } });
}
const scratchDirs = [];
function cleanup() { for (const d of scratchDirs.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

function makeScratch({ withRepo = true } = {}) {
  const scratch = mkdtempSync(path.join(realpathSync(tmpdir()), 'hermes-probe-'));
  scratchDirs.push(scratch);
  scratchRoots = [...new Set([scratch, scratch.replace(/^\/private/, ''), ...scratchRoots])].sort((a, b) => b.length - a.length);
  const ctx = { scratch, home: path.join(scratch, 'home'), hermesHome: path.join(scratch, 'home', '.hermes'), repo: path.join(scratch, 'repo'), wt: path.join(scratch, 'wt') };
  mkdirSync(ctx.hermesHome, { recursive: true });
  if (withRepo) {
    mkdirSync(ctx.repo);
    git(ctx.repo, 'init', '-q', '-b', 'main');
    git(ctx.repo, 'config', 'user.name', 'Fixture Author');
    git(ctx.repo, 'config', 'user.email', 'author@example.invalid');
    git(ctx.repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(ctx.repo, 'README.md'), '# probe repo\n');
    git(ctx.repo, 'add', '.');
    git(ctx.repo, 'commit', '-q', '-m', 'initial');
    writeFileSync(path.join(ctx.repo, '.git', 'info', 'exclude'), '.orchestrator/\n', { flag: 'a' });
    git(ctx.repo, 'worktree', 'add', '-q', '-b', 'task/PROBE/l1', ctx.wt);
  }
  return ctx;
}

/** Copies the credential files of the user's Hermes home into a scratch home, never reading them into output. */
function copyCredentials(hermesHome) {
  const copied = [];
  for (const name of ['.env', 'auth.json']) {
    const src = path.join(USER_HOME, name);
    if (!existsSync(src)) continue;
    copyFileSync(src, path.join(hermesHome, name));
    secretValues.push(...credentialValues(src));
    copied.push(name);
  }
  secretValues = [...new Set(secretValues)].sort((a, b) => b.length - a.length);
  return copied;
}

// ---------------------------------------------------------------- processes
function resolveBin(bin) {
  if (bin.includes('/')) return existsSync(bin) ? path.resolve(bin) : null;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = path.join(dir, bin);
    try { if (statSync(p).isFile()) return p; } catch {}
  }
  return null;
}
/** ps rows (pid, ppid, pgid, comm), each marked `hermes` when its command line runs the hermes install. */
function psRows() {
  try {
    const hermesPids = new Set(execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
      .filter((m) => /hermes_cli|hermes-agent|\/bin\/hermes(\s|$)/.test(m[2])).map((m) => Number(m[1])));
    return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').map((l) => l.trim().split(/\s+/)).filter((r) => r.length >= 4)
      .map(([pid, ppid, pgid, ...c]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), comm: c.join(' '), hermes: hermesPids.has(Number(pid)) }));
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
const isHermes = (comm) => /(^|\/)hermes(-agent)?$/.test(comm) || /hermes-agent/.test(comm);

/**
 * A listing cut to the rows of this script's own process tree (`in: tree`) and the rows whose command is the harness
 * binary or runs from its install (`in: hermes`).
 */
function cutListing(rows, ownPids) {
  const mine = subtree(rows, process.pid);
  const keep = new Map();
  for (const r of mine) keep.set(r.pid, { ...r, in: 'tree' });
  for (const r of rows) if (!keep.has(r.pid) && (r.hermes || isHermes(r.comm) || ownPids.has(r.pid))) keep.set(r.pid, { ...r, in: ownPids.has(r.pid) ? 'started' : 'hermes' });
  return [...keep.values()];
}

/**
 * Starts argv detached under a hard limit, with the given environment and directory. Samples ps every second (cut as
 * above), remembers every pid seen under the child, and at the limit signals -pid only. Returns stdout, stderr, the exit,
 * the samples before/during/after and the pids of the child's tree that were still alive afterwards (reaped by pgid or
 * recorded ancestry, never by name).
 */
async function runChild(argv, { env, cwd, limitMs = 300_000, stdin, onStdout, onTick } = {}) {
  const before = cutListing(psRows(), new Set());
  const t0 = Date.now();
  const child = spawn(argv[0], argv.slice(1), { env, cwd, detached: true, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  const started = await new Promise((res) => { child.once('spawn', () => res(true)); child.once('error', (e) => res(e)); });
  if (started !== true) return { error: String(started.message), code: started.code, stdout, stderr, ms: 0, before, samples: [], after: [], seen: [], orphans: [] };
  if (stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
  const lineTimes = [];
  child.stdout.on('data', (d) => { const s = String(d); stdout += s; for (const ch of s) if (ch === '\n') lineTimes.push(Date.now() - t0); onStdout?.(s, Date.now() - t0); });
  child.stderr.on('data', (d) => { stderr += d; });
  const seen = new Map();
  const samples = [];
  const own = new Set([child.pid]);
  const seenArgs = {};
  const tick = () => {
    const rows = psRows();
    for (const r of subtree(rows, child.pid)) { if (!seen.has(r.pid)) seen.set(r.pid, { ...r, firstMs: Date.now() - t0 }); own.add(r.pid); }
    for (const r of rows) if (r.pgid === child.pid && !seen.has(r.pid)) { seen.set(r.pid, { ...r, firstMs: Date.now() - t0, byPgid: true }); own.add(r.pid); }
    samples.push({ ms: Date.now() - t0, rows: cutListing(rows, own) });
    const fresh = [...seen.keys()].filter((p) => !(p in seenArgs));
    Object.assign(seenArgs, argsOf(fresh));
    for (const p of fresh) if (!(p in seenArgs)) seenArgs[p] = null;
    onTick?.(seen, Date.now() - t0, child.pid);
  };
  tick();
  const timer = setInterval(tick, 1000);
  let timedOut = false;
  const limit = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000); }, limitMs);
  const exit = await new Promise((res) => child.once('close', (code, signal) => res({ code, signal })));
  clearTimeout(limit);
  clearInterval(timer);
  const ms = Date.now() - t0;
  await sleep(1500);
  const afterRows = psRows();
  const after = cutListing(afterRows, own);
  // Left behind: a process seen in the child's tree or group that is still alive with the same command.
  const left = [...seen.values()].filter((p) => p.pid !== child.pid && afterRows.some((r) => r.pid === p.pid && r.comm === p.comm));
  return { exit, timedOut, ms, stdout, stderr, before, samples, after, seen: [...seen.values()], seenArgs, left, pid: child.pid, lineTimes };
}
/** Ends what a run left behind (descendants of its child, or the pid a scratch home records), and names each. */
async function reap(left) {
  for (const p of left) try { process.kill(p.pid, 'SIGTERM'); } catch {}
  if (left.length) await sleep(2000);
  for (const p of left) if (alive(p.pid)) try { process.kill(p.pid, 'SIGKILL'); } catch {}
  return left.map((p) => ({ pid: p.pid, ppid: p.ppid, pgid: p.pgid, comm: p.comm.split('/').pop() }));
}
/** Pids recorded in a scratch home (gateway.pid and similar files), with whether they are alive. */
function homePids(hermesHome) {
  const out = [];
  const walk = (d, depth) => {
    let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && /\.pid$|pid\.json$/i.test(e.name)) {
        let text = ''; try { text = readFileSync(p, 'utf8'); } catch {}
        const m = /"pid"\s*:\s*(\d+)/.exec(text) ?? /^\s*(\d+)\s*$/m.exec(text);
        if (m) out.push({ file: path.relative(hermesHome, p), pid: Number(m[1]), alive: alive(Number(m[1])) });
      }
    }
  };
  walk(hermesHome, 0);
  return out;
}

// ---------------------------------------------------------------- environment
const FAKE = () => ({ ORCH_LAUNCH_ID: 'probe-launch', ORCH_TOKEN: `orch-probe-token-${randomBytes(4).toString('hex')}`, ORCH_API: 'http://127.0.0.1:9', PROBE_MARKER: 'from-client-env' });
const KEY_NAMES = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'NOUS_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY'];
/** Provider keys the owner exported for the worker: forwarded to the children and guarded like copied files. */
function exportedKeys() {
  const keys = Object.fromEntries(KEY_NAMES.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  for (const v of Object.values(keys)) if (!secretValues.includes(v)) secretValues.push(v);
  return keys;
}
function childEnv(ctx, extra = {}) {
  return { ...exportedKeys(), PATH: process.env.PATH, HOME: ctx.home, USER: process.env.USER ?? 'probe', LANG: 'en_US.UTF-8', TMPDIR: realpathSync(tmpdir()) + '/', HERMES_HOME: ctx.hermesHome, ...FAKE(), ...extra };
}
/** The environment as a record shows it: values for the probe's own variables, names only for the rest. */
function envForRecord(env) {
  const shown = new Set(['HOME', 'HERMES_HOME', 'LANG', 'TMPDIR', 'ORCH_LAUNCH_ID', 'ORCH_TOKEN', 'ORCH_API', 'PROBE_MARKER', 'HERMES_YOLO_MODE', 'HERMES_IGNORE_USER_CONFIG', 'HERMES_IGNORE_RULES', 'HERMES_SAFE_MODE', 'HERMES_MAX_ITERATIONS', 'HERMES_INFERENCE_MODEL']);
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, shown.has(k) ? v : '<set>']));
}

// ---------------------------------------------------------------- user configuration
function userConfigState() {
  const cfg = path.join(USER_HOME, 'config.yaml');
  const env = path.join(USER_HOME, '.env');
  return {
    home: existsSync(USER_HOME) ? 'present' : 'absent',
    config: existsSync(cfg) ? sha256(readFileSync(cfg)) : 'absent',
    env: existsSync(env) ? sha256(readFileSync(env)) : 'absent',
  };
}

// ---------------------------------------------------------------- preflight
function readProbeLine(briefPath) {
  const candidates = [briefPath, path.join(REPO, '.orchestrator', 'brief.md')].filter(Boolean);
  for (const f of candidates) {
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const m = /^\s*Probe provider and model:\s*(.*)$/m.exec(text);
    if (!m) continue;
    const words = m[1].trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2 && !/^\(/.test(words[0])) return { provider: words[0], model: words[1], line: m[1].trim(), from: f };
    return { line: m[1].trim(), from: f };
  }
  return null;
}

async function preflight(o) {
  const lines = [];
  const ok = (what, detail) => lines.push(`ok: ${what}${detail ? ` ${detail}` : ''}`);
  const missing = (what, detail) => lines.push(`missing: ${what}${detail ? ` (${detail})` : ''}`);
  const bin = resolveBin(o.bin);
  const facts = { bin, at: now() };
  if (!bin) missing(`hermes binary`, `${o.bin} not found on PATH`);
  else ok('hermes binary', bin);
  const ctx = makeScratch({ withRepo: false });
  if (bin) {
    const v = await runChild([bin, '--version'], { env: childEnv(ctx), cwd: ctx.scratch, limitMs: 60_000 });
    const first = (v.stdout || v.stderr).split('\n').find((l) => l.trim()) ?? '';
    facts.version = first.trim();
    facts.versionExit = v.exit;
    if (v.exit?.code === 0 && first) ok('version', first.trim()); else missing('version', `exit ${v.exit?.code} ${first.trim()}`);
    const c = await runChild([bin, 'acp', '--check'], { env: childEnv(ctx), cwd: ctx.scratch, limitMs: 120_000 });
    facts.acpCheck = { exit: c.exit, stdout: c.stdout, stderr: c.stderr };
    const tail = (c.stdout + c.stderr).trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
    if (c.exit?.code === 0) ok('hermes acp --check', `exit 0 ${tail}`.trim()); else missing('hermes acp --check', `exit ${c.exit?.code}: ${tail}`);
  } else { missing('version', 'no binary'); missing('hermes acp --check', 'no binary'); }
  const user = existsSync(USER_HOME);
  if (user) ok('user Hermes home', '~/.hermes'); else missing('user Hermes home', '~/.hermes does not exist');
  const keyInEnv = Object.keys(exportedKeys());
  const probeLine = readProbeLine(o.brief);
  const provider = o.provider ?? probeLine?.provider;
  const model = o.model ?? probeLine?.model;
  if (provider && model) ok('probe provider and model', `${provider} ${model}${o.provider ? ' (from --provider/--model)' : ''}`);
  else missing('probe provider and model', `the issue line reads "Probe provider and model: ${probeLine?.line ?? '(no line)'}"`);
  facts.provider = provider ?? null; facts.model = model ?? null;
  // The credential, under a scratch HERMES_HOME holding the copied files (or a provider key exported for the worker).
  const copied = user ? copyCredentials(ctx.hermesHome) : [];
  facts.copied = copied; facts.keyInEnv = keyInEnv;
  if (!bin) missing('credential works under a scratch HERMES_HOME', 'no binary');
  else if (!copied.length && !keyInEnv.length) missing('credential works under a scratch HERMES_HOME', 'no credential file in ~/.hermes and no provider key exported');
  else {
    const extra = {};
    const args = [bin, '-z', PROMPT_OK, ...(provider ? ['--provider', provider] : []), ...(model ? ['-m', model] : []), '--usage-file', path.join(ctx.scratch, 'usage.json')];
    const r = await runChild(args, { env: childEnv(ctx, extra), cwd: ctx.scratch, limitMs: 300_000 });
    facts.okRun = { exit: r.exit, stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(-800) };
    if (r.exit?.code === 0 && /\bok\b/i.test(r.stdout)) ok('credential works under a scratch HERMES_HOME', `exit 0, reply "${r.stdout.trim().slice(0, 40)}" (copied ${copied.join(', ') || 'nothing'}${keyInEnv.length ? `, key from ${keyInEnv.join(',')}` : ''})`);
    else missing('credential works under a scratch HERMES_HOME', `exit ${r.exit?.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-1)[0]?.slice(0, 200) ?? ''}`);
    const orphans = await reap(r.left ?? []);
    facts.okRun.orphans = orphans;
    // The preflight prompt calls a model: it is a run of its own, counted against the cap.
    const env = childEnv(ctx, extra);
    const rec = { id: 'P0-preflight', kind: 'headless', questions: ['Q1'], at: now(), command: args, cwd: ctx.scratch, env: envForRecord(env), exit: r.exit, timedOut: r.timedOut, ms: r.ms, modelCalls: 1, plannedModelCalls: 1, orphans, homeFiles: homeListing(ctx), usage: readUsage(path.join(ctx.scratch, 'usage.json')), evidence: [] };
    rec.evidence.push(writeEvidence('headless/P0-preflight.out', r.stdout), writeEvidence('headless/P0-preflight.err', r.stderr));
    if (rec.usage) rec.evidence.push(writeEvidence('headless/P0-preflight.usage.json', JSON.stringify(rec.usage)));
    mkdirSync(RECORDS, { recursive: true });
    writeEvidence('records/P0-preflight.json', JSON.stringify(rec));
    appendSpend({ id: rec.id, at: rec.at, modelCalls: 1, exit: r.exit, ms: r.ms });
  }
  facts.lines = lines;
  facts.homePids = homePids(ctx.hermesHome);
  return { lines, facts };
}

// ---------------------------------------------------------------- main
const o = (() => { try { return parseArgs(process.argv.slice(2)); } catch (err) { process.stderr.write(`probe: ${err.message}\n`); process.exit(64); } })();
async function main() {
  if (o.mode === 'preflight') {
    const { lines, facts } = await preflight(o);
    for (const l of lines) console.log(redactString(l));
    writeEvidence('headless/preflight.txt', lines.join('\n') + '\n');
    writeEvidence('headless/preflight.json', JSON.stringify(facts));
    return 0;
  }
  if (o.mode === 'check') return check();
  // Applies the current redaction again to every evidence file (GH-208), as the agy probe's --scrub does.
  if (o.mode === 'scrub') { scrubEvidence(HERE); return 0; }
  if (o.mode === 'assemble') { assemble(); return 0; }
  if (o.mode === 'run') return runScenarios(o.runs);
  process.stderr.write('usage: probe.mjs --preflight | --run <ids> | --assemble | --check | --scrub\n');
  return 64;
}

// ---------------------------------------------------------------- scenario helpers
const SETTINGS = { provider: null, model: null, bin: null };
function settings() {
  if (SETTINGS.bin) return SETTINGS;
  SETTINGS.bin = resolveBin(o.bin);
  const line = readProbeLine(o.brief);
  SETTINGS.provider = o.provider ?? line?.provider ?? null;
  SETTINGS.model = o.model ?? line?.model ?? null;
  return SETTINGS;
}
const modelArgs = () => [...(SETTINGS.provider ? ['--provider', SETTINGS.provider] : []), ...(SETTINGS.model ? ['-m', SETTINGS.model] : [])];
/** config.yaml as JSON, which is YAML too. */
function writeConfig(ctx, cfg) { writeFileSync(path.join(ctx.hermesHome, 'config.yaml'), JSON.stringify(cfg, null, 2) + '\n'); }
function shimEntry(ctx, id, { blockSec = 200, env = true, envFile = false, bad = false, timeout, trust } = {}) {
  const calls = path.join(ctx.scratch, `shim-${id}.jsonl`);
  const fake = ctx.fake;
  const args = [SHIM, calls, '--block-sec', String(blockSec)];
  if (envFile) {
    const f = path.join(ctx.home, 'orch.env');
    writeFileSync(f, `ORCH_LAUNCH_ID=${fake.ORCH_LAUNCH_ID}\nORCH_TOKEN=${fake.ORCH_TOKEN}\nORCH_API=${fake.ORCH_API}\n`, { mode: 0o600 });
    args.push('--orch-env-file', f);
  }
  if (bad) args.push('--orch-env-file', path.join(ctx.home, 'missing.env'));
  const entry = { command: process.execPath, args, ...(env ? { env: { ORCH_LAUNCH_ID: fake.ORCH_LAUNCH_ID, ORCH_TOKEN: fake.ORCH_TOKEN, ORCH_API: fake.ORCH_API, PROBE_MARKER: 'from-mcp-entry' } } : {}), ...(timeout ? { timeout } : {}), ...(trust ? { trust } : {}) };
  ctx.calls = calls;
  return entry;
}
/** The ACP form of a shim entry (session/new mcpServers). */
const acpServer = (e) => ({ name: 'orchestrator', command: e.command, args: e.args, env: Object.entries(e.env ?? {}).map(([name, value]) => ({ name, value })) });
function filesUnder(root) {
  const out = [];
  const walk = (d) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'lazy-packages' && e.name !== '.git') walk(p); } else out.push(p); } };
  walk(root);
  return out;
}
/** The scratch home's files; the bundled skills tree a gateway seeds is counted, not listed. */
function homeListing(ctx) {
  const all = filesUnder(ctx.hermesHome).map((p) => path.relative(ctx.hermesHome, p)).sort();
  const skills = all.filter((f) => f.startsWith('skills/'));
  return [...all.filter((f) => !f.startsWith('skills/')), ...(skills.length ? [`skills/ (${skills.length} files)`] : [])];
}
function tokenFoundIn(ctx) {
  const t = ctx.fake.ORCH_TOKEN;
  const hits = [];
  for (const p of [...filesUnder(ctx.hermesHome), ...filesUnder(ctx.wt)]) { try { if (readFileSync(p).includes(t)) hits.push(path.relative(ctx.scratch, p)); } catch {} }
  return hits;
}
function argsOf(pids) {
  if (!pids.length) return {};
  try {
    return Object.fromEntries(execFileSync('ps', ['-o', 'pid=,args=', '-p', pids.join(',')], { encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => { const m = /^\s*(\d+)\s+(.*)$/.exec(l); return [m[1], redactString(m[2]).slice(0, 400)]; }));
  } catch { return {}; }
}
/** The samples whose set of pids changed, plus the first and the last. */
function compactSamples(samples) {
  const out = [];
  let prev = '';
  samples.forEach((s, i) => { const key = s.rows.map((r) => r.pid).sort().join(','); if (key !== prev || i === samples.length - 1) out.push(s); prev = key; });
  return out;
}
const shortRows = (rows) => rows.map((r) => ({ pid: r.pid, ppid: r.ppid, pgid: r.pgid, comm: r.comm.split('/').pop(), hermes: r.hermes || undefined, in: r.in }));
function gitFacts(ctx) {
  try {
    return { branch: git(ctx.wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), log: git(ctx.wt, 'log', '--format=%h %s', '-5').trim().split('\n'), status: git(ctx.wt, 'status', '--porcelain', '--untracked-files=all').trim().split('\n').filter(Boolean), mainLog: git(ctx.repo, 'log', 'main', '--format=%h %s', '-3').trim().split('\n') };
  } catch (e) { return { error: String(e.message).slice(0, 200) }; }
}
function homeLogs(ctx) {
  const parts = [];
  for (const p of filesUnder(path.join(ctx.hermesHome, 'logs'))) {
    // Hermes writes gateway-shutdown-diag.log on SIGTERM: ps of the whole host, pstree, the load and dmesg. Never copied.
    if (path.basename(p) === 'gateway-shutdown-diag.log') continue;
    let t = '';
    try { t = readFileSync(p, 'utf8'); } catch {}
    // The gateway's start-up audit reports findings about the host's configuration: every hermes.security_audit line is dropped.
    t = t.split('\n').filter((l) => !l.includes('hermes.security_audit')).join('\n');
    parts.push(`==> ${path.relative(ctx.hermesHome, p)} <==\n${t.length > 60000 ? t.slice(-60000) : t}`);
  }
  return parts.join('\n');
}
/** The shim's parent chain cut at this probe's own process: nothing above it is kept. */
function cutChains(text) {
  return text.split('\n').map((l) => { if (!l.trim()) return l; try { const x = JSON.parse(l); if (Array.isArray(x.chain)) { const i = x.chain.findIndex((c) => c.pid === process.pid); if (i >= 0) x.chain = [...x.chain.slice(0, i), { pid: process.pid, comm: 'probe.mjs (chain cut here)' }]; } return JSON.stringify(x); } catch { return l; } }).join('\n');
}
/** Append-only: every run, reruns included, so that a rerun cannot hide spend. */
function appendSpend(entry) { writeFileSync(path.join(HERE, 'spend.jsonl'), JSON.stringify(entry) + '\n', { flag: 'a' }); }
function readUsage(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

/**
 * One run: starts argv detached, then writes the evidence and records/<id>.json at once. kind 'headless' or 'acp'.
 * `killWhen(seen, ms)` returning a signal name sends it to the child's group once.
 */
async function oneRun(id, ctx, argv, { kind = 'headless', questions = [], planned = 0, limitMs = 300_000, envExtra = {}, stdin, killWhen, usageFile, note, cwd, keepLeft = false } = {}) {
  const env = childEnv(ctx, envExtra);
  for (const [k, v] of Object.entries(ctx.fake)) env[k] = v;
  const userBefore = userConfigState();
  let killed = null;
  const r = await runChild(argv, { env, cwd: cwd ?? ctx.wt, limitMs, stdin, onTick: killWhen ? (seen, ms, pid) => { if (killed) return; const sig = killWhen(seen, ms); if (sig) { killed = { signal: sig, ms }; try { process.kill(-pid, sig); } catch {} } } : undefined });
  const gwPids = homePids(ctx.hermesHome);
  const leftPids = new Set((r.left ?? []).map((p) => p.pid));
  const gwArgs = argsOf(gwPids.filter((g) => g.alive).map((g) => g.pid));
  const fromHome = gwPids.filter((g) => g.alive && !leftPids.has(g.pid) && /hermes_cli\.main .*gateway run/.test(gwArgs[g.pid] ?? '')).map((g) => ({ pid: g.pid, ppid: 0, pgid: 0, comm: `recorded in ${g.file}` }));
  const carried = (ctx.carried ?? []).filter((p) => alive(p.pid) && !leftPids.has(p.pid));
  ctx.carried = [];
  const toEnd = [...(r.left ?? []), ...fromHome.filter((g) => !carried.some((c) => c.pid === g.pid)), ...carried];
  const leftArgs = argsOf(toEnd.map((p) => p.pid));
  let orphans = [];
  let carriedToNextRun = [];
  if (keepLeft) { ctx.carried = toEnd; carriedToNextRun = toEnd.map((p) => ({ pid: p.pid, comm: p.comm.split('/').pop(), args: leftArgs[p.pid] })); }
  else orphans = await reap(toEnd);
  for (const x of orphans) x.args = leftArgs[x.pid];
  const dir = kind === 'acp' ? 'acp' : 'headless';
  const ev = [];
  const seenArgs = r.seenArgs ?? {};
  ev.push(writeEvidence(`${dir}/${id}.ps.json`, JSON.stringify({ note: 'rows of the probe\'s own tree (in: tree), of the started child\'s tree or group (in: started) and whose command is the hermes install (in: hermes); nothing else', before: shortRows(r.before ?? []), during: compactSamples(r.samples ?? []).map((s) => ({ ms: s.ms, rows: shortRows(s.rows) })), after: shortRows(r.after ?? []), seen: (r.seen ?? []).map((p) => ({ pid: p.pid, ppid: p.ppid, pgid: p.pgid, comm: p.comm.split('/').pop(), firstMs: p.firstMs, args: seenArgs[p.pid] })), leftAfterExit: (r.left ?? []).map((p) => ({ pid: p.pid, ppid: p.ppid, pgid: p.pgid, comm: p.comm.split('/').pop(), args: leftArgs[p.pid] })), homePids: gwPids })));
  if (kind === 'acp') {
    ev.push(writeEvidence(`acp/${id}.client.jsonl`, r.stdout));
    ev.push(writeEvidence(`acp/${id}.stderr.txt`, r.stderr));
    if (ctx.frames && existsSync(ctx.frames)) ev.push(writeEvidence(`acp/${id}.frames.jsonl`, readFileSync(ctx.frames, 'utf8')));
  } else {
    ev.push(writeEvidence(`headless/${id}.out`, r.stdout));
    ev.push(writeEvidence(`headless/${id}.err`, r.stderr));
  }
  if (ctx.calls && existsSync(ctx.calls)) ev.push(writeEvidence(`shim/${id}.jsonl`, cutChains(readFileSync(ctx.calls, 'utf8'))));
  const usage = usageFile ? readUsage(usageFile) : null;
  if (usage) ev.push(writeEvidence(`headless/${id}.usage.json`, JSON.stringify(usage)));
  const logs = homeLogs(ctx);
  if (logs) ev.push(writeEvidence(`${dir}/${id}.logs.txt`, logs));
  const resultLine = kind === 'acp' ? r.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x?.type === 'result').pop() : r.stdout.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x?.type === 'result').pop();
  const observedCalls = usage?.api_calls ?? (resultLine?.usage || resultLine?.tokens ? 1 : 0);
  const userAfter = userConfigState();
  const rec = {
    id, kind, questions, note, at: now(), command: argv.map((a) => (a.length > 400 ? `${a.slice(0, 60)}...(${a.length} chars)` : a)), cwd: cwd ?? ctx.wt, env: envForRecord(env),
    exit: r.exit, timedOut: r.timedOut, ms: r.ms, killed, error: r.error,
    modelCalls: planned, observedApiCalls: Number(observedCalls) || 0,
    plannedModelCalls: planned, apiCalls: usage?.api_calls ?? null,
    orphans, carriedToNextRun, carriedFromPreviousRun: carried.map((p) => p.pid), homeFiles: homeListing(ctx), homeConfig: (() => { try { return readFileSync(path.join(ctx.hermesHome, 'config.yaml'), 'utf8'); } catch { return null; } })(),
    tokenFoundIn: tokenFoundIn(ctx), git: ctx.wt && existsSync(ctx.wt) ? gitFacts(ctx) : null,
    userConfig: { before: userBefore, after: userAfter, changed: JSON.stringify(userBefore) !== JSON.stringify(userAfter) },
    result: resultLine ?? null, evidence: ev,
    stdoutLines: (() => { const t = r.lineTimes ?? []; let max = t.length ? t[0] : 0; let at = 0; for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > max) { max = t[i] - t[i - 1]; at = i; } return { count: t.length, firstMs: t[0] ?? null, maxGapMs: t.length ? max : null, maxGapBeforeLine: t.length ? at + 1 : null, times: t }; })(),
  };
  mkdirSync(RECORDS, { recursive: true });
  writeEvidence(`records/${id}.json`, JSON.stringify(rec));
  appendSpend({ id, at: rec.at, modelCalls: planned, exit: r.exit, ms: r.ms });
  console.log(`${id}: exit ${JSON.stringify(r.exit)} ${r.ms} ms, orphans ${orphans.length}, evidence ${ev.length}`);
  return rec;
}
function newCtx(withRepo = true) {
  const ctx = makeScratch({ withRepo });
  ctx.fake = FAKE();
  ctx.frames = path.join(ctx.scratch, 'frames.jsonl');
  return ctx;
}
const acpArgv = (ctx, { mcp, prompt, policy, requests, noAnswer, turnTimeoutMs } = {}) => {
  const a = [process.execPath, CLIENT, '--agent-json', JSON.stringify([SETTINGS.bin, 'acp']), '--cwd', ctx.wt, '--frames', ctx.frames, '--keep-descendants'];
  if (mcp) { const f = path.join(ctx.scratch, 'mcp.json'); writeFileSync(f, JSON.stringify(mcp)); a.push('--mcp-json', f); }
  if (prompt) { const f = path.join(ctx.scratch, 'prompt.txt'); writeFileSync(f, prompt); a.push('--prompt-file', f); }
  if (policy) { const f = path.join(ctx.scratch, 'policy.json'); writeFileSync(f, JSON.stringify(policy)); a.push('--policy', f); }
  if (requests) { const f = path.join(ctx.scratch, 'requests.json'); writeFileSync(f, JSON.stringify(requests)); a.push('--requests-json', f); }
  if (noAnswer) a.push('--no-permission-answer');
  if (turnTimeoutMs) a.push('--turn-timeout-ms', String(turnTimeoutMs));
  return a;
};
const PLACEHOLDER = { default: 'probe/placeholder-model', provider: 'openrouter' };
const PLACEHOLDER_ARGS = ['--provider', 'openrouter', '-m', 'probe/placeholder-model'];
/** The scratch config: the probe's model, or (no-model runs before a provider was named) a placeholder model with no key. */
const baseConfig = (extra = {}, { placeholder = false } = {}) => ({ ...(SETTINGS.model ? { model: { default: SETTINGS.model, ...(SETTINGS.provider ? { provider: SETTINGS.provider } : {}) } } : placeholder ? { model: PLACEHOLDER } : {}), ...extra });
function withCreds(ctx) { ctx.copied = existsSync(USER_HOME) ? copyCredentials(ctx.hermesHome) : []; return ctx; }
const PROMPT_Q2 = 'Call the orchestrator heartbeat tool once with progress "probe". Then run this exact shell command in the terminal: sleep 15 && pwd. Then reply with the single word done.';
const PROMPT_KILL = 'Run this exact shell command in the terminal: sleep 120. Then reply with the single word done.';

// The first form ended the command with " ." before "Then", and the model ran `rm -r ./probe-rm-target .` (H9a, H9b, which
// keep it so that their records reproduce). Runs from H10a on use the backquoted form.
const PROMPT_RM_V1 = 'Run this exact shell command in the terminal from the current directory: rm -r ./probe-rm-target . Then reply with the single word done.';
const PROMPT_RM = 'Run this exact shell command in the terminal from the current directory: `rm -r ./probe-rm-target` and then reply with the single word done.';
const BLOCK_SEC = 310; // later than the 300 s default tool timeout found in N-source and the 200 s floor of the brief
const sleepSeen = (seen) => ([...seen.values()].some((p) => /(^|\/)sleep$/.test(p.comm)) ? 'SIGTERM' : null);
const promptRmAbs = (ctx) => `Run this exact shell command in the terminal: \`rm -r ${path.join(ctx.wt, 'probe-rm-target')}\` and then reply with the single word done.`;
function rmTarget(ctx) { mkdirSync(path.join(ctx.wt, 'probe-rm-target', 'sub'), { recursive: true }); writeFileSync(path.join(ctx.wt, 'probe-rm-target', 'sub', 'f.txt'), 'x\n'); }
function withRm(ctx, r, extra = {}) {
  r.rmTargetAfter = existsSync(path.join(ctx.wt, 'probe-rm-target')) ? 'present' : 'removed';
  Object.assign(r, extra);
  writeEvidence(`records/${r.id}.json`, JSON.stringify(r));
  return r;
}
/** A brief of about 30 KB: the task, then a long background section that asks nothing. */
function briefText() {
  const head = [
    '# Task PROBE-1: add a greeting file',
    '',
    'You are working in a git worktree on branch task/PROBE/l1. Do exactly this:',
    '1. Call the orchestrator heartbeat tool with progress "starting".',
    '2. Create the file greeting.txt in the current directory holding exactly one line: hello from hermes',
    '3. Run in the terminal: git add greeting.txt && git commit -m "probe: greeting"',
    '4. Call the orchestrator report tool with seq 1, kind "submit" and summary "greeting committed".',
    '5. Reply with the single word done.',
    'Do not push, do not create branches, do not touch any other file.',
    '',
    '## Background (for reference only; it asks nothing of you)',
    '',
  ].join('\n');
  const lines = [];
  for (let i = 1; lines.join('\n').length < 30_000 - head.length; i++) lines.push(`- Note ${i}: this paragraph is padding that makes the brief about thirty kilobytes long, as an orchestrator brief can be; ignore it.`);
  return `${head}${lines.join('\n')}\n`;
}
async function blockRun(id, entryExtra) {
  const ctx = withCreds(newCtx());
  writeConfig(ctx, baseConfig({ mcp_servers: { orchestrator: shimEntry(ctx, id, { blockSec: BLOCK_SEC, ...entryExtra }) } }));
  return oneRun(id, ctx, [SETTINGS.bin, 'chat', '-q', PROMPT_BLOCK, '--oneshot', '--format', 'stream-json', '--max-turns', '12', ...modelArgs()], { questions: ['Q8'], planned: 1, limitMs: (BLOCK_SEC + 300) * 1000, note: `block answered after ${BLOCK_SEC} s; entry ${JSON.stringify(entryExtra)}` });
}
async function blockRunAcp(id, cfgExtra) {
  const ctx = withCreds(newCtx());
  writeConfig(ctx, baseConfig(cfgExtra));
  const e = shimEntry(ctx, id, { blockSec: BLOCK_SEC });
  return oneRun(id, ctx, acpArgv(ctx, { mcp: [acpServer(e)], prompt: PROMPT_BLOCK, policy: { default: 'allow' }, turnTimeoutMs: (BLOCK_SEC + 200) * 1000 }), { kind: 'acp', questions: ['Q8'], planned: 1, limitMs: (BLOCK_SEC + 300) * 1000, note: `block answered after ${BLOCK_SEC} s; config ${JSON.stringify(cfgExtra)}` });
}
const PROMPT_BLOCK = 'Call the orchestrator block tool once with seq 2, kind "needsDecision" and message "Which file name should I use?". Wait for its answer. Then reply with the exact text of the answer, or with the error you got.';

// ---------------------------------------------------------------- scenarios
// Each returns a list of records. `planned` is the number of runs of it that call a model.
const SCENARIOS = {
  // No model: help texts of the installed version (flags of questions 3, 10, 13).
  async N0() {
    const out = [];
    for (const [id, args] of [['N0-help', ['--help']], ['N0-chat-help', ['chat', '--help']], ['N0-acp-help', ['acp', '--help']], ['N0-mcp-help', ['mcp', '--help']]]) {
      const ctx = newCtx(false); ctx.wt = undefined;
      out.push(await oneRun(id, ctx, [SETTINGS.bin, ...args], { questions: ['Q3', 'Q10', 'Q13'], limitMs: 60_000, cwd: ctx.scratch }));
    }
    return out;
  },
  // No model: `hermes mcp test orchestrator` with the shim in a scratch config (good, through --orch-env-file, bad command).
  async N1() {
    const out = [];
    for (const [id, opts] of [['N1-mcp-test', {}], ['N1-mcp-test-envfile', { env: false, envFile: true }], ['N1-mcp-test-bad', { bad: true }]]) {
      const ctx = newCtx();
      writeConfig(ctx, baseConfig({ mcp_servers: { orchestrator: shimEntry(ctx, id, opts) } }));
      out.push(await oneRun(id, ctx, [SETTINGS.bin, 'mcp', 'test', 'orchestrator'], { questions: ['Q4', 'Q6', 'Q7'], limitMs: 120_000 }));
    }
    return out;
  },
  // No model: ACP initialize and session/new with the shim; two clients one after the other on one home, then the extras.
  async A0() {
    const out = [];
    const ctx = withCreds(newCtx());
    writeConfig(ctx, baseConfig({}, { placeholder: true }));
    const e = shimEntry(ctx, 'A0-1');
    const calls1 = ctx.calls;
    const eSecond = shimEntry(ctx, 'A0-1-second');
    ctx.calls = calls1;
    const reqs = [
      { when: 'afterSession', method: 'session/new', params: { cwd: ctx.wt, mcpServers: [acpServer(eSecond)] } },
      { when: 'afterSession', method: 'session/set_model', params: { sessionId: '{sessionId}', modelId: 'probe/no-such-model-9' } },
      { when: 'afterSession', method: 'session/set_config_option', params: { sessionId: '{sessionId}', configId: 'model', value: 'probe/no-such-model-9' } },
      { when: 'afterSession', method: 'session/set_config_option', params: { sessionId: '{sessionId}', configId: 'effort', value: 'low' } },
    ];
    out.push(await oneRun('A0-1', ctx, acpArgv(ctx, { mcp: [acpServer(e)], requests: reqs }), { kind: 'acp', questions: ['Q2', 'Q5', 'Q6', 'Q13'], limitMs: 180_000, keepLeft: true }));
    // The second client on the same home, with a shim of its own.
    const e2 = shimEntry(ctx, 'A0-2');
    out.push(await oneRun('A0-2', ctx, acpArgv(ctx, { mcp: [acpServer(e2)] }), { kind: 'acp', questions: ['Q2', 'Q5'], limitMs: 180_000 }));
    // The first client's second session/new wrote its own shim file.
    const second = path.join(ctx.scratch, 'shim-A0-1-second.jsonl');
    if (existsSync(second)) writeEvidence('shim/A0-1-second.jsonl', cutChains(readFileSync(second, 'utf8')));
    // A shim command that exits 1.
    const ctx3 = withCreds(newCtx());
    writeConfig(ctx3, baseConfig({}, { placeholder: true }));
    const e3 = shimEntry(ctx3, 'A0-bad', { bad: true });
    out.push(await oneRun('A0-bad', ctx3, acpArgv(ctx3, { mcp: [acpServer(e3)] }), { kind: 'acp', questions: ['Q7', 'Q15'], limitMs: 180_000 }));
    return out;
  },
  // No credential at all (a scratch home with nothing copied): -z, chat -q and an ACP prompt.
  async C0() {
    const out = [];
    let ctx = newCtx();
    const uf = path.join(ctx.scratch, 'usage.json');
    out.push(await oneRun('C0-z', ctx, [SETTINGS.bin, '-z', PROMPT_OK, ...modelArgs(), '--usage-file', uf], { questions: ['Q15', 'Q14', 'Q16'], usageFile: uf, limitMs: 180_000 }));
    ctx = newCtx();
    out.push(await oneRun('C0-chat', ctx, [SETTINGS.bin, 'chat', '-q', PROMPT_OK, '--oneshot', '--format', 'stream-json', '--max-turns', '12', ...modelArgs()], { questions: ['Q15', 'Q14'], limitMs: 180_000 }));
    ctx = newCtx();
    out.push(await oneRun('C0-acp-nomodel', ctx, acpArgv(ctx, {}), { kind: 'acp', questions: ['Q15', 'Q5'], limitMs: 180_000, note: 'no model in the scratch config and no credential: session/new only' }));
    ctx = newCtx();
    writeConfig(ctx, baseConfig({}, { placeholder: true }));
    out.push(await oneRun('C0-acp', ctx, acpArgv(ctx, { prompt: PROMPT_OK, turnTimeoutMs: 120_000 }), { kind: 'acp', questions: ['Q15', 'Q5'], limitMs: 180_000 }));
    return out;
  },
  // ---------------------------------------------------------------- no-key turns (no model call: the placeholder model has no key)
  // These start a real turn up to the provider call, which fails for want of a key, so they show the processes of a turn.
  async D2() {
    const ctx = newCtx();
    writeConfig(ctx, { model: PLACEHOLDER, mcp_servers: { orchestrator: shimEntry(ctx, 'D2') } });
    const uf = path.join(ctx.scratch, 'usage.json');
    return [await oneRun('D2', ctx, [SETTINGS.bin, '-z', PROMPT_Q2, ...PLACEHOLDER_ARGS, '--usage-file', uf], { questions: ['Q2', 'Q6', 'Q14', 'Q15', 'Q16'], usageFile: uf, envExtra: { HERMES_MAX_ITERATIONS: '12' }, note: 'placeholder model, no key: the turn stops at the provider call' })];
  },
  // SIGTERM to the started group once the shim is seen (the turn is still waiting for the provider then).
  async D2k() {
    const ctx = newCtx();
    writeConfig(ctx, { model: PLACEHOLDER, mcp_servers: { orchestrator: shimEntry(ctx, 'D2k') } });
    const uf = path.join(ctx.scratch, 'usage.json');
    const shimSeen = (seen) => ([...seen.values()].some((p) => /(^|\/)node$/.test(p.comm)) ? 'SIGTERM' : null);
    return [await oneRun('D2k', ctx, [SETTINGS.bin, '-z', PROMPT_Q2, ...PLACEHOLDER_ARGS, '--usage-file', uf], { questions: ['Q16', 'Q2'], usageFile: uf, envExtra: { HERMES_MAX_ITERATIONS: '12' }, killWhen: shimSeen, note: 'placeholder model, no key; SIGTERM to the started group (-pid) at the first sample that shows the shim' })];
  },
  async D3() {
    const ctx = newCtx();
    writeConfig(ctx, { model: PLACEHOLDER, mcp_servers: { orchestrator: shimEntry(ctx, 'D3') } });
    const brief = path.join(ctx.home, 'brief.md');
    writeFileSync(brief, briefText());
    return [await oneRun('D3', ctx, [SETTINGS.bin, 'chat', '--query-file', brief, '--oneshot', '--format', 'stream-json', '--max-turns', '12', ...PLACEHOLDER_ARGS], { questions: ['Q3', 'Q2', 'Q14', 'Q16'], note: `placeholder model, no key; brief ${statSync(brief).size} bytes from --query-file` })];
  },
  async D7() {
    const ctx = newCtx();
    writeConfig(ctx, { model: PLACEHOLDER, mcp_servers: { orchestrator: shimEntry(ctx, 'D7', { bad: true }) } });
    return [await oneRun('D7', ctx, [SETTINGS.bin, 'chat', '-q', PROMPT_OK, '--oneshot', '--format', 'stream-json', '--max-turns', '12', ...PLACEHOLDER_ARGS], { questions: ['Q7', 'Q15'], note: 'placeholder model, no key, a shim command that exits 1' })];
  },
  async D16() {
    const ctx = newCtx();
    writeConfig(ctx, { model: PLACEHOLDER, mcp_servers: { orchestrator: shimEntry(ctx, 'D16-1') } });
    const ctx2 = { ...ctx, carried: [] };
    shimEntry(ctx2, 'D16-2'); // a calls path of its own for the record; the config names D16-1's file, which both runs share
    ctx2.calls = undefined;
    const a = oneRun('D16-1', ctx, [SETTINGS.bin, 'chat', '-q', PROMPT_OK, '--oneshot', '--format', 'stream-json', '--max-turns', '12', ...PLACEHOLDER_ARGS], { questions: ['Q16', 'Q2'], keepLeft: true, note: 'two runs at once on one scratch home, placeholder model, no key' });
    await sleep(300);
    const b = oneRun('D16-2', ctx2, [SETTINGS.bin, 'chat', '-q', PROMPT_OK, '--oneshot', '--format', 'stream-json', '--max-turns', '12', ...PLACEHOLDER_ARGS], { questions: ['Q16', 'Q2'], keepLeft: true, note: 'two runs at once on one scratch home, placeholder model, no key' });
    const recs = await Promise.all([a, b]);
    const left = [...(ctx.carried ?? []), ...(ctx2.carried ?? [])].filter((p, i, all) => all.findIndex((q) => q.pid === p.pid) === i);
    const ended = await reap(left);
    recs[1].orphans = ended; recs[1].note += '; the processes both runs left were ended once, after both, and are named here';
    writeEvidence('records/D16-2.json', JSON.stringify(recs[1]));
    return recs;
  },
  // ---------------------------------------------------------------- model runs (each `planned: 1`)
  // Q2, Q4, Q6, Q9, Q14 headless: -z with the shim in the scratch config; ps every second.
  async H2() {
    const ctx = withCreds(newCtx());
    writeConfig(ctx, baseConfig({ mcp_servers: { orchestrator: shimEntry(ctx, 'H2') } }));
    const uf = path.join(ctx.scratch, 'usage.json');
    return [await oneRun('H2', ctx, [SETTINGS.bin, '-z', PROMPT_Q2, ...modelArgs(), '--usage-file', uf], { questions: ['Q2', 'Q4', 'Q6', 'Q9', 'Q14'], planned: 1, usageFile: uf, envExtra: { HERMES_MAX_ITERATIONS: '12' } })];
  },
  // Q2, Q16: -z with `sleep 120`, SIGTERM to the started group once a sleep process is seen.
  async H2k() {
    const ctx = withCreds(newCtx());
    writeConfig(ctx, baseConfig({ mcp_servers: { orchestrator: shimEntry(ctx, 'H2k') } }));
    const uf = path.join(ctx.scratch, 'usage.json');
    return [await oneRun('H2k', ctx, [SETTINGS.bin, '-z', PROMPT_KILL, ...modelArgs(), '--usage-file', uf], { questions: ['Q2', 'Q16'], planned: 1, usageFile: uf, envExtra: { HERMES_MAX_ITERATIONS: '12' }, killWhen: sleepSeen, limitMs: 240_000 })];
  },
  // Q2, Q5, Q6 over ACP: the shim on session/new, the same prompt.
  async A2() {
    const ctx = withCreds(newCtx());
    writeConfig(ctx, baseConfig());
    const e = shimEntry(ctx, 'A2');
    return [await oneRun('A2', ctx, acpArgv(ctx, { mcp: [acpServer(e)], prompt: PROMPT_Q2, policy: { default: 'allow' }, turnTimeoutMs: 240_000 }), { kind: 'acp', questions: ['Q2', 'Q5', 'Q6', 'Q14'], planned: 1 })];
  },
  // Q2, Q16 over ACP: `sleep 120`, SIGTERM to the client's group once a sleep process is seen.
  async A2k() {
    const ctx = withCreds(newCtx());
    writeConfig(ctx, baseConfig());
    const e = shimEntry(ctx, 'A2k');
    return [await oneRun('A2k', ctx, acpArgv(ctx, { mcp: [acpServer(e)], prompt: PROMPT_KILL, policy: { default: 'allow' }, turnTimeoutMs: 240_000 }), { kind: 'acp', questions: ['Q2', 'Q16'], planned: 1, killWhen: sleepSeen, limitMs: 240_000 })];
  },
  // Q3, Q12, Q14, Q16: a 30 KB brief from --query-file, stream-json, commit on the launch branch.
  async H3() {
    const ctx = withCreds(newCtx());
    writeConfig(ctx, baseConfig({ mcp_servers: { orchestrator: shimEntry(ctx, 'H3') } }));
    const brief = path.join(ctx.home, 'brief.md');
    writeFileSync(brief, briefText());
    return [await oneRun('H3', ctx, [SETTINGS.bin, 'chat', '--query-file', brief, '--oneshot', '--format', 'stream-json', '--max-turns', '12', ...modelArgs()], { questions: ['Q3', 'Q12', 'Q14', 'Q16'], planned: 1, note: `brief ${statSync(brief).size} bytes` })];
  },
  // Q3, Q15: the iteration limit (--max-turns 1) on a task that needs several tool calls.
  async H3b() {
    const ctx = withCreds(newCtx());
    writeConfig(ctx, baseConfig());
    return [await oneRun('H3b', ctx, [SETTINGS.bin, 'chat', '-q', 'Run these three shell commands one at a time, each as its own terminal call: pwd, then ls, then date. Then reply with the single word done.', '--oneshot', '--format', 'stream-json', '--max-turns', '1', ...modelArgs()], { questions: ['Q3', 'Q15'], planned: 1 })];
  },
  // Q8 headless: block answered after BLOCK_SEC with no timeout on the entry, and with timeout on the entry.
  async H8a() { return [await blockRun('H8a', {})]; },
  async H8b() { return [await blockRun('H8b', { timeout: BLOCK_SEC + 120 })]; },
  // The last run under the cap answers two questions at once (Q8 lift and Q10 approvals off): `timeout` on the entry above the
  // 310 s block, and approvals.mode off with rm -r of an absolute path in the worktree, under chat -q.
  async H8x() {
    const ctx = withCreds(newCtx());
    writeConfig(ctx, baseConfig({ approvals: { mode: 'off' }, mcp_servers: { orchestrator: shimEntry(ctx, 'H8x', { blockSec: BLOCK_SEC, timeout: BLOCK_SEC + 120 }) } }));
    rmTarget(ctx);
    const before = sha256(readFileSync(path.join(ctx.hermesHome, 'config.yaml')));
    const prompt = `Do these two steps in order. Step 1: run this exact shell command in the terminal: \`rm -r ${path.join(ctx.wt, 'probe-rm-target')}\` . Step 2: call the orchestrator block tool once with seq 2, kind "needsDecision" and message "Which file name should I use?", and wait for its answer. Then reply with the exact text of the answer, or with the error you got.`;
    const r = await oneRun('H8x', ctx, [SETTINGS.bin, 'chat', '-q', prompt, '--oneshot', '--format', 'stream-json', '--max-turns', '12', ...modelArgs()], { questions: ['Q8', 'Q10', 'Q9'], planned: 1, limitMs: (BLOCK_SEC + 300) * 1000, note: `entry timeout ${BLOCK_SEC + 120} s, block answered after ${BLOCK_SEC} s; approvals.mode off; rm -r of an absolute path` });
    return [withRm(ctx, r, { scratchConfigSha256Before: before, scratchConfigSha256After: sha256(readFileSync(path.join(ctx.hermesHome, 'config.yaml'))) })];
  },
  // Q8 over ACP: the same through session/new, with the default and with timeouts.mcp.tool_call in the scratch config.
  async A8a() { return [await blockRunAcp('A8a', {})]; },
  async A8b() { return [await blockRunAcp('A8b', { timeouts: { mcp: { tool_call: BLOCK_SEC + 120 } } })]; },
  // Q9: a dangerous command (rm -r of a directory in the worktree) under chat -q (default approvals) and under -z.
  async H9a() {
    const ctx = withCreds(newCtx()); writeConfig(ctx, baseConfig()); rmTarget(ctx);
    return [await oneRun('H9a', ctx, [SETTINGS.bin, 'chat', '-q', PROMPT_RM_V1, '--oneshot', '--format', 'stream-json', '--max-turns', '12', ...modelArgs()], { questions: ['Q9', 'Q15'], planned: 1, note: 'rm target exists after: see rmTargetAfter' }).then((r) => withRm(ctx, r))];
  },
  // H9a again with an absolute path: a relative rm argument is resolved by the guard against the gateway's cwd, which is in
  // the hermes virtualenv, so `rm -r ./probe-rm-target` is hardline-blocked before any approval (H9a, H9b, H10a, A11a, A11b).
  async H9c() {
    const ctx = withCreds(newCtx()); writeConfig(ctx, baseConfig()); rmTarget(ctx);
    return [await oneRun('H9c', ctx, [SETTINGS.bin, 'chat', '-q', promptRmAbs(ctx), '--oneshot', '--format', 'stream-json', '--max-turns', '12', ...modelArgs()], { questions: ['Q9', 'Q15'], planned: 1, note: 'chat -q, default approvals, rm -r of an absolute path in the worktree; rm target after: see rmTargetAfter' }).then((r) => withRm(ctx, r))];
  },
  async H9b() {
    const ctx = withCreds(newCtx()); writeConfig(ctx, baseConfig()); rmTarget(ctx);
    const uf = path.join(ctx.scratch, 'usage.json');
    return [await oneRun('H9b', ctx, [SETTINGS.bin, '-z', PROMPT_RM_V1, ...modelArgs(), '--usage-file', uf], { questions: ['Q9'], planned: 1, usageFile: uf, envExtra: { HERMES_MAX_ITERATIONS: '12' } }).then((r) => withRm(ctx, r))];
  },
  // Q10: approvals.mode off in the scratch config (no --yolo), the same rm -r; the config hash before and after.
  async H10a() {
    const ctx = withCreds(newCtx()); writeConfig(ctx, baseConfig({ approvals: { mode: 'off' } })); rmTarget(ctx);
    const before = sha256(readFileSync(path.join(ctx.hermesHome, 'config.yaml')));
    const r = await oneRun('H10a', ctx, [SETTINGS.bin, 'chat', '-q', PROMPT_RM, '--oneshot', '--format', 'stream-json', '--max-turns', '12', ...modelArgs()], { questions: ['Q10'], planned: 1 });
    return [withRm(ctx, r, { scratchConfigSha256Before: before, scratchConfigSha256After: sha256(readFileSync(path.join(ctx.hermesHome, 'config.yaml'))) })];
  },
  // Q10 again with an absolute path (see H9c): approvals.mode off in the scratch config, chat -q, no --yolo.
  async H10c() {
    const ctx = withCreds(newCtx()); writeConfig(ctx, baseConfig({ approvals: { mode: 'off' } })); rmTarget(ctx);
    const before = sha256(readFileSync(path.join(ctx.hermesHome, 'config.yaml')));
    const r = await oneRun('H10c', ctx, [SETTINGS.bin, 'chat', '-q', promptRmAbs(ctx), '--oneshot', '--format', 'stream-json', '--max-turns', '12', ...modelArgs()], { questions: ['Q10', 'Q9'], planned: 1, note: 'approvals.mode off, rm -r of an absolute path in the worktree' });
    return [withRm(ctx, r, { scratchConfigSha256Before: before, scratchConfigSha256After: sha256(readFileSync(path.join(ctx.hermesHome, 'config.yaml'))) })];
  },
  // Q10: a per-launch ruleset: --toolsets file,mcp-orchestrator and tools.include without `log`; ask for log and a shell command.
  async H10b() {
    const ctx = withCreds(newCtx());
    const e = shimEntry(ctx, 'H10b');
    e.tools = { include: ['heartbeat', 'report', 'block', 'inbox'] };
    writeConfig(ctx, baseConfig({ mcp_servers: { orchestrator: e } }));
    return [await oneRun('H10b', ctx, [SETTINGS.bin, 'chat', '-q', 'Call the orchestrator log tool with text "probe". Then run the shell command uname -s in the terminal. Then reply with the single word done.', '--oneshot', '--format', 'stream-json', '--max-turns', '12', '--toolsets', 'file,mcp-orchestrator', ...modelArgs()], { questions: ['Q10'], planned: 1 })];
  },
  // Q11 over ACP: the rm -r with a reject policy, and with no answer and approvals.timeout 30 in the scratch config.
  async A11a() {
    const ctx = withCreds(newCtx()); writeConfig(ctx, baseConfig()); rmTarget(ctx);
    return [await oneRun('A11a', ctx, acpArgv(ctx, { prompt: PROMPT_RM, policy: { default: 'reject' }, turnTimeoutMs: 240_000 }), { kind: 'acp', questions: ['Q11'], planned: 1 }).then((r) => withRm(ctx, r))];
  },
  async A11b() {
    const ctx = withCreds(newCtx()); writeConfig(ctx, baseConfig({ approvals: { timeout: 30 } })); rmTarget(ctx);
    return [await oneRun('A11b', ctx, acpArgv(ctx, { prompt: PROMPT_RM, noAnswer: true, turnTimeoutMs: 200_000 }), { kind: 'acp', questions: ['Q11'], planned: 1 }).then((r) => withRm(ctx, r))];
  },
  // Q11 again with an absolute path (see H9c): a reject, then no answer with approvals.timeout 30.
  async A11c() {
    const ctx = withCreds(newCtx()); writeConfig(ctx, baseConfig()); rmTarget(ctx);
    return [await oneRun('A11c', ctx, acpArgv(ctx, { prompt: promptRmAbs(ctx), policy: { default: 'reject' }, turnTimeoutMs: 240_000 }), { kind: 'acp', questions: ['Q11'], planned: 1, note: 'reject policy, rm -r of an absolute path in the worktree' }).then((r) => withRm(ctx, r))];
  },
  async A11d() {
    const ctx = withCreds(newCtx()); writeConfig(ctx, baseConfig({ approvals: { timeout: 30 } })); rmTarget(ctx);
    return [await oneRun('A11d', ctx, acpArgv(ctx, { prompt: promptRmAbs(ctx), noAnswer: true, turnTimeoutMs: 200_000 }), { kind: 'acp', questions: ['Q11'], planned: 1, note: 'no permission answer, approvals.timeout 30, rm -r of an absolute path in the worktree' }).then((r) => withRm(ctx, r))];
  },
  // Q13, Q15: an unknown model on -z.
  async H13() {
    const ctx = withCreds(newCtx()); writeConfig(ctx, baseConfig());
    const uf = path.join(ctx.scratch, 'usage.json');
    return [await oneRun('H13', ctx, [SETTINGS.bin, '-z', PROMPT_OK, ...(SETTINGS.provider ? ['--provider', SETTINGS.provider] : []), '-m', 'probe-no-such-model-9', '--usage-file', uf], { questions: ['Q13', 'Q15'], planned: 1, usageFile: uf, envExtra: { HERMES_MAX_ITERATIONS: '12' } })];
  },
  // Q7, Q15 headless: the shim command exits 1; a one-line prompt.
  async H7() {
    const ctx = withCreds(newCtx());
    writeConfig(ctx, baseConfig({ mcp_servers: { orchestrator: shimEntry(ctx, 'H7', { bad: true }) } }));
    return [await oneRun('H7', ctx, [SETTINGS.bin, 'chat', '-q', 'Call the orchestrator heartbeat tool with progress "probe" if you have it. Then reply with the single word done.', '--oneshot', '--format', 'stream-json', '--max-turns', '12', ...modelArgs()], { questions: ['Q7', 'Q15'], planned: 1 })];
  },
  // Q16: two runs at once on one scratch home.
  async H16() {
    const ctx = withCreds(newCtx()); writeConfig(ctx, baseConfig());
    // Both keep what they leave, so that neither ends the other's gateway; one run of the probe ends it afterwards.
    const ctx2 = { ...ctx, calls: undefined, carried: [] };
    const a = oneRun('H16-1', ctx, [SETTINGS.bin, 'chat', '-q', PROMPT_OK, '--oneshot', '--format', 'stream-json', '--max-turns', '12', ...modelArgs()], { questions: ['Q16'], planned: 1, keepLeft: true });
    await sleep(300);
    const b = oneRun('H16-2', ctx2, [SETTINGS.bin, 'chat', '-q', PROMPT_OK, '--oneshot', '--format', 'stream-json', '--max-turns', '12', ...modelArgs()], { questions: ['Q16'], planned: 1, keepLeft: true });
    const recs = await Promise.all([a, b]);
    const left = [...(ctx.carried ?? []), ...(ctx2.carried ?? [])].filter((p, i, all) => all.findIndex((q) => q.pid === p.pid) === i);
    const ended = await reap(left);
    recs[1].orphans = ended; recs[1].note = 'the processes both runs left were ended once, after both, and are named here';
    writeEvidence('records/H16-2.json', JSON.stringify(recs[1]));
    return recs;
  },
};

// ---------------------------------------------------------------- assemble and check
const QIDS = Array.from({ length: 16 }, (_, i) => `Q${i + 1}`);
function loadRecords() {
  if (!existsSync(RECORDS)) return [];
  return readdirSync(RECORDS).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(path.join(RECORDS, f), 'utf8')));
}
/** ~/.hermes/config.yaml and .env across every run, from the records (in time order): absent, or the hashes and who changed them. */
function userConfigFromRecords() {
  const recs = loadRecords().filter((r) => r.userConfig).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const one = (key) => {
    const states = recs.flatMap((r) => [r.userConfig.before[key], r.userConfig.after[key]]);
    if (!states.length || states.every((x) => x === 'absent')) return 'absent';
    const changedBy = recs.filter((r) => r.userConfig.before[key] !== r.userConfig.after[key]).map((r) => r.id);
    // A change between two runs (after one run's `after`, before the next run's `before`) was made by no probe run.
    const changedBetweenRuns = recs.slice(1).map((r, i) => [recs[i], r]).filter(([a, b]) => a.userConfig.after[key] !== b.userConfig.before[key]).map(([a, b]) => ({ afterRun: a.id, beforeRun: b.id }));
    const first = recs[0].userConfig.before[key];
    const last = recs[recs.length - 1].userConfig.after[key];
    return key === 'config' ? { sha256Before: first, sha256After: last, changedBy, changedBetweenRuns } : { changed: first !== last || changedBy.length > 0, before: first === 'absent' ? 'absent' : 'present', after: last === 'absent' ? 'absent' : 'present', changedBy, changedBetweenRuns };
  };
  return { '~/.hermes/config.yaml': one('config'), '~/.hermes/.env': one('env'), '~/.hermes': recs.every((r) => r.userConfig.before.home === 'absent' && r.userConfig.after.home === 'absent') ? 'absent before and after every run' : 'present' };
}
function assemble() {
  const answers = JSON.parse(readFileSync(ANSWERS, 'utf8'));
  const pre = existsSync(path.join(HERE, 'headless', 'preflight.json')) ? JSON.parse(readFileSync(path.join(HERE, 'headless', 'preflight.json'), 'utf8')) : {};
  const runs = loadRecords().map((r) => ({ id: r.id, kind: r.kind, questions: r.questions, command: r.command, env: r.env, exit: r.exit, timedOut: r.timedOut, ms: r.ms, killed: r.killed, modelCalls: r.modelCalls, apiCalls: r.apiCalls, orphans: r.orphans, tokenFoundIn: r.tokenFoundIn, userConfigChanged: r.userConfig?.changed ?? false, record: `records/${r.id}.json`, evidence: r.evidence }));
  const results = {
    cli: 'hermes', bin: answers.meta.bin ?? pre.bin ?? null, version: answers.meta.version ?? pre.version ?? null, provider: answers.meta.provider ?? null, model: answers.meta.model ?? null,
    probedAt: answers.meta.probedAt, preflight: pre.lines ?? [], questions: answers.questions, userConfig: userConfigFromRecords(), runs,
  };
  writeFileSync(RESULTS, JSON.stringify(results, null, 2) + '\n');
  console.log(`results.json: ${Object.keys(results.questions).length} questions, ${runs.length} runs`);
}
function check() {
  const problems = [];
  let res;
  try { res = JSON.parse(readFileSync(RESULTS, 'utf8')); } catch (e) { console.log(`hermes probe: results.json does not parse: ${e.message}`); return 1; }
  for (const k of ['cli', 'bin', 'version', 'provider', 'model', 'probedAt', 'questions', 'runs', 'userConfig']) if (!(k in res)) problems.push(`results.json has no ${k}`);
  let recorded = 0;
  for (const q of QIDS) {
    const a = res.questions?.[q];
    if (!a) { problems.push(`${q}: missing`); continue; }
    const bad = [];
    if (!['yes', 'no', 'partly', 'blocked'].includes(a.answer)) bad.push('answer');
    if (typeof a.summary !== 'string' || !a.summary) bad.push('summary');
    if (!Array.isArray(a.commands) || !a.commands.length) bad.push('commands');
    if (!Array.isArray(a.evidence) || !a.evidence.length) bad.push('evidence');
    for (const e of a.evidence ?? []) if (!existsSync(path.join(HERE, e))) bad.push(`evidence file ${e}`);
    if (a.answer === 'blocked' && !a.reason) bad.push('reason');
    if (q === 'Q1' && a.answer === 'blocked') bad.push('Q1 may not be blocked');
    if (bad.length) problems.push(`${q}: ${bad.join(', ')}`); else recorded++;
  }
  const modelRuns = (res.runs ?? []).filter((r) => r.modelCalls > 0).length;
  if (modelRuns > 20) problems.push(`${modelRuns} runs call a model, more than 20`);
  for (const r of res.runs ?? []) {
    if (!Array.isArray(r.orphans)) problems.push(`run ${r.id}: no orphans list`);
    if (!String(r.env?.HERMES_HOME ?? '').startsWith('<scratch>') && !r.userHomeFor) problems.push(`run ${r.id}: HERMES_HOME not under <scratch>`);
    for (const e of r.evidence ?? []) if (!existsSync(path.join(HERE, e))) problems.push(`run ${r.id}: evidence ${e} missing`);
  }
  const uc = res.userConfig ?? {};
  const cfg = uc['~/.hermes/config.yaml'];
  const env = uc['~/.hermes/.env'];
  if (!(cfg === 'absent' || (cfg && 'sha256Before' in cfg && 'sha256After' in cfg))) problems.push('userConfig: ~/.hermes/config.yaml needs sha256Before and sha256After, or absent');
  if (!(env === 'absent' || (env && typeof env.changed === 'boolean'))) problems.push('userConfig: ~/.hermes/.env needs changed, or absent');
  for (const p of scanHost(HERE)) problems.push(p);
  for (const p of problems) console.log(`problem: ${p}`);
  console.log(`hermes probe: ${recorded} of ${QIDS.length} questions recorded`);
  return problems.length ? 1 : 0;
}
async function runScenarios(ids) {
  settings();
  if (!SETTINGS.bin) { console.log('hermes not found'); return 1; }
  for (const id of ids) {
    const f = SCENARIOS[id];
    if (!f) { console.log(`unknown scenario ${id}`); return 64; }
    await f();
    cleanup();
  }
  if (existsSync(ANSWERS)) assemble();
  return 0;
}


main().then((code) => { cleanup(); process.exit(code); }, (err) => { process.stderr.write(`probe: ${err.stack ?? err}\n`); cleanup(); process.exit(1); });
