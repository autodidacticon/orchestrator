/**
 * The OpenCode host: hosts/opencode's launcher, pinned package.json, MCP registration snippet,
 * skill edition, and session plugin. See specs/host-integration "OpenCode host".
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { WAIT_CAP_MS } from '../../src/operator/mcp-server.js';
import { listRuns, stopDaemon } from '../../src/runs/lifecycle.js';
import { gitIn, makeRepo, scriptedAgent, tsxLoader } from '../slice/harness.js';

const execFileP = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const host = path.join(root, 'hosts/opencode');
const launcher = path.join(host, 'bin/orchestrator.mjs');
const pkgJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string; version: string };
const hostPkg = JSON.parse(readFileSync(path.join(host, 'package.json'), 'utf8')) as { name: string; private?: boolean; dependencies: Record<string, string> };
const claudePkg = JSON.parse(readFileSync(path.join(root, 'hosts/claude-code/package.json'), 'utf8')) as { dependencies: Record<string, string> };
const snippetText = readFileSync(path.join(host, 'opencode.json'), 'utf8');

const dryRun = async (dir: string, entry: string) => {
  const { stdout } = await execFileP('node', [path.join(dir, 'bin/orchestrator.mjs'), entry], { env: { ...process.env, ORCH_LAUNCHER_DRY_RUN: '1' } });
  return JSON.parse(stdout) as { source: string; command: string; args: string[] };
};

/**
 * The OpenCode edition of a skill is the Codex edition with these substitutions, plus the
 * host-specific blocks in EDITION_BLOCKS. Everything else must match, so the two cannot drift.
 */
const SUBSTITUTIONS: Array<[string, string]> = [
  ['mcp__orchestrator_operator__', 'orchestrator_operator_'],
  ['from a Codex session', 'from an OpenCode session'],
  ['(Codex host)', '(OpenCode host)'],
  ['hosts/codex/README.md', 'hosts/opencode/README.md'],
];

/**
 * The blocks allowed to differ, each named by a phrase only the OpenCode block holds:
 * permissions instead of Codex approvals, the OpenCode tracker tool names, the opencode
 * toolchain line and kind lists, the per-server `timeout`, and the pull-mode offer (the work
 * loop with `--runner opencode`). The Codex edition does not name the opencode kind yet.
 * Each anchor maps to the first 16 hex digits of the sha256 of its whole block (as `blocks` normalises
 * it), so a change anywhere in a rewritten block fails until the hash here is updated.
 */
const EDITION_BLOCKS: Record<string, Record<string, string>> = {
  import: {
    'which in OpenCode is an `mcp.linear` or `mcp.atlassian` entry in `opencode.json`': 'fd9e1e3e865adb31',
    'for an `opencode` run also the permission and the commit policy': 'e7d53877b792523e',
    '`runner:<kind>` (`claude-code`, `codex`, or `opencode`)': '65ad61fb7c4633d1',
  },
  run: {
    'OpenCode runs the operator tools without asking unless the `permission` block': '8be101265e0b3cbb',
    "`spawn` is the OpenCode host's default. In pull mode the work loop (`orchestrator-work --runner opencode`": '24ddb5d0b33a95db',
    'When the run holds `opencode` launches, also offer the work loop the `modeNote` names': '5ef6baa4c8cdd998',
    'work.mjs --runner opencode --workers <n>': 'f43ddb954e8c1d06',
    '(`--runner codex`, the default, for `codex` launches;': '8a61030e5bda8f22',
    '`codex`, or `opencode`. All three kinds run headless under `spawn`': '35aaf4b54dbca71a',
    'For an `opencode` run name the permission and the commit policy': 'd16a063501b6d383',
    '`runner.opencode.*` (`model` as a `provider/model` id': '9ed9fdfeccffe3b7',
    '`permission` and `dataDir` (the opencode leaves)': 'ba90099048fa2fec',
    "below the server's `timeout` in `opencode.json`": '799349ea4bcdcf5f',
    'for an `opencode` launch, whose `permission: derived` rejects': '3d450fb87ad5a46a',
  },
  review: { "when this session's `permission` rejects the command": 'ae86c3f9912bcb88' },
};

const blockHash = (block: string) => createHash('sha256').update(block).digest('hex').slice(0, 16);

/** A skill split at blank lines, list items, and headings; whitespace inside a block is normalised. */
function blocks(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || /^(- |#)/.test(line)) {
      if (cur.length) out.push(cur.join(' ').replace(/\s+/g, ' ').trim());
      cur = line === '' ? [] : [line];
    } else cur.push(line);
  }
  if (cur.length) out.push(cur.join(' ').replace(/\s+/g, ' ').trim());
  return out;
}

/** A fixture ORCH_HOME with one run whose daemon exited idle with two launches parked. */
function attentionHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'orch-oc-home-'));
  const dir = path.join(home, 'runs', 'r1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'repo'), '/tmp/fixture-repo\n');
  writeFileSync(path.join(dir, 'daemon.pid'), '999999\n');
  writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ pid: 999_999, url: 'http://127.0.0.1:1', port: 1, startedAt: 1, exit: { reason: 'idle', at: Date.now() - 120_000, digest: { claimable: 2 } } }));
  return home;
}

const startLine = (home: string) => execFileSync('node', [path.join(host, 'hooks/session-start.mjs')], { env: { ...process.env, ORCH_HOME: home } }).toString().trim();

type Hooks = {
  event: (a: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void>;
  'chat.message': (input: { sessionID: string }, output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> }) => Promise<void>;
};
const loadPlugin = async () => (await import(pathToFileURL(path.join(host, 'plugins/orchestrator.js')).href)) as Record<string, unknown>;

/** Drives the plugin's hooks for one session: created, then two user messages. */
async function driveSession(home: string, info: Record<string, unknown> = { id: 's1' }) {
  const toasts: unknown[] = [];
  const client = { tui: { showToast: async (a: unknown) => void toasts.push(a) } };
  const mod = await loadPlugin();
  const before = process.env['ORCH_HOME'];
  process.env['ORCH_HOME'] = home;
  try {
    const hooks = (await (mod['OrchestratorPlugin'] as (a: unknown) => Promise<Hooks>)({ client })) as Hooks;
    await hooks.event({ event: { type: 'session.created', properties: { info } } });
    const first = { message: { sessionID: info['id'] }, parts: [{ type: 'text', text: 'hello' }] };
    const second = { message: { sessionID: info['id'] }, parts: [{ type: 'text', text: 'again' }] };
    await hooks['chat.message']({ sessionID: String(info['id']) }, first);
    await hooks['chat.message']({ sessionID: String(info['id']) }, second);
    return { toasts, first, second };
  } finally {
    if (before === undefined) delete process.env['ORCH_HOME'];
    else process.env['ORCH_HOME'] = before;
  }
}

/** The JSONL events of `opencode run --format json`; other lines are skipped. */
function ocEvents(text: string): Array<{ type?: string; part?: { tool?: string; text?: string; state?: { status?: string; output?: string } } }> {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // not an event
    }
  }
  return out;
}

/** The last text part with any reasoning before `</think>` removed. */
const finalText = (events: ReturnType<typeof ocEvents>) => (events.filter((e) => e.type === 'text').at(-1)?.part?.text ?? '').split('</think>').at(-1)!.trim();

// The checks that run the installed opencode CLI are opt-in, so the unit suite never depends on it.
const OPENCODE_HOST = process.env['ORCH_E2E_OPENCODE_HOST'] === '1';
const MODEL = process.env['ORCH_E2E_OPENCODE_MODEL'] ?? 'opencode/big-pickle';

function opencodeOnPath(): boolean {
  try {
    execFileSync('opencode', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    console.warn('opencode CLI not installed; OpenCode host check skipped');
    return false;
  }
}

/** A headless `opencode run`; stdin is closed, or opencode waits for it. */
const opencodeRun = (message: string, cwd: string, env: Record<string, string | undefined>) =>
  new Promise<ReturnType<typeof ocEvents>>((resolve, reject) => {
    const child = spawn('opencode', ['run', '--format', 'json', '-m', MODEL, message], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(ocEvents(out));
      else reject(new Error(`opencode run exited ${code}: ${err.slice(-2000)}`));
    });
  });

describe('opencode host', () => {
  const snippet = JSON.parse(snippetText) as { mcp: Record<string, Record<string, unknown>> };

  it('the opencode.json snippet registers the operator server through the launcher with a timeout above the wait cap and no mcp.timeout', () => {
    const server = snippet.mcp['orchestrator_operator'];
    expect(server).toEqual({ type: 'local', command: ['node', '<hosts/opencode>/bin/orchestrator.mjs', 'mcp'], timeout: 180_000 });
    expect(server!['timeout']).toBeGreaterThan(WAIT_CAP_MS + 30_000);
    expect(snippet.mcp['timeout']).toBeUndefined();
    expect(Object.keys(snippet.mcp)).toEqual(['orchestrator_operator']);
  });

  it('package.json pins the published package at the Claude Code plugin\'s version, and the launcher reads it', async () => {
    expect(hostPkg.private).toBe(true);
    expect(hostPkg.name).not.toBe(pkgJson.name);
    expect(Object.keys(hostPkg.dependencies)).toEqual([pkgJson.name]);
    expect(hostPkg.dependencies[pkgJson.name]).toBe(claudePkg.dependencies[pkgJson.name]);
    expect(hostPkg.dependencies[pkgJson.name]).toBe(pkgJson.version);
    expect(/PACKAGE_NAME = '([^']+)'/.exec(readFileSync(launcher, 'utf8'))?.[1]).toBe(pkgJson.name);
    // node_modules/ in the root .gitignore covers hosts/opencode/node_modules.
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n')).toContain('node_modules/');

    const fromCheckout = await dryRun(host, 'mcp');
    expect(fromCheckout.source).toBe('checkout');
    expect(fromCheckout.args.at(-1)).toMatch(/src\/operator\/mcp\.(js|ts)$/);
    const copy = mkdtempSync(path.join(tmpdir(), 'orch-opencode-copy-'));
    try {
      cpSync(host, path.join(copy, 'opencode'), { recursive: true });
      const npx = await dryRun(path.join(copy, 'opencode'), 'mcp');
      expect(npx.source).toBe('npx');
      expect(npx.args).toEqual(['--yes', `--package=${pkgJson.name}@${hostPkg.dependencies[pkgJson.name]}`, 'orchestrator-mcp']);
      const local = path.join(copy, 'opencode', 'node_modules', ...pkgJson.name.split('/'));
      mkdirSync(path.join(local, 'dist/src/operator'), { recursive: true });
      writeFileSync(path.join(local, 'package.json'), JSON.stringify({ name: pkgJson.name, engines: { node: '>=22.13.0' } }));
      writeFileSync(path.join(local, 'dist/src/operator/mcp.js'), '');
      const fromLocal = await dryRun(path.join(copy, 'opencode'), 'mcp');
      expect(fromLocal.source).toBe('plugin');
      expect(fromLocal.args[0]).toBe(path.join(realpathSync(local), 'dist/src/operator/mcp.js'));
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it('the launcher is the Claude Code and Codex launchers but for its version source', () => {
    const strip = (text: string) => text.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    const opencode = strip(readFileSync(launcher, 'utf8'));
    const codex = strip(readFileSync(path.join(root, 'hosts/codex/bin/orchestrator.mjs'), 'utf8'));
    const claude = strip(readFileSync(path.join(root, 'hosts/claude-code/bin/orchestrator.mjs'), 'utf8'));
    const differing = (a: string, b: string) => a.split('\n').filter((l) => !b.split('\n').includes(l));
    expect(opencode).toBe(codex);
    expect(differing(opencode, claude)).toEqual([expect.stringContaining("readJson(path.join(pluginDir, 'package.json'))?.dependencies?.[PACKAGE_NAME]")]);
    expect(differing(claude, opencode).join('\n')).toContain('.claude-plugin');
  });

  it('the hook scripts are the Claude Code plugin\'s, byte for byte', () => {
    for (const name of ['session-start.mjs', 'session-end.mjs']) {
      expect(readFileSync(path.join(host, 'hooks', name)).equals(readFileSync(path.join(root, 'hosts/claude-code/hooks', name))), name).toBe(true);
    }
  });

  // See specs/host-integration "OpenCode host" and "Skills".
  it('each skill is the Codex edition but for the tool-name substitution and the enumerated host blocks', () => {
    const skills = readdirSync(path.join(host, 'skills')).sort();
    expect(skills).toEqual(['import', 'review', 'run']);
    expect(Object.keys(EDITION_BLOCKS).sort()).toEqual(skills);
    for (const name of skills) {
      let codex = readFileSync(path.join(root, 'hosts/codex/skills', name, 'SKILL.md'), 'utf8');
      for (const [from, to] of SUBSTITUTIONS) codex = codex.replaceAll(from, to);
      const opencode = readFileSync(path.join(host, 'skills', name, 'SKILL.md'), 'utf8');
      const a = blocks(codex);
      const b = blocks(opencode);
      expect(b.length, name).toBe(a.length);
      const differ = b.filter((block, i) => block !== a[i]);
      const pinned = EDITION_BLOCKS[name]!;
      const anchors = Object.keys(pinned);
      // Every differing block holds exactly one anchor and has that anchor's pinned hash, and every anchor names a differing block.
      for (const block of differ) {
        const held = anchors.filter((x) => block.includes(x));
        expect(held, `${name}: ${block.slice(0, 120)}`).toHaveLength(1);
        expect(blockHash(block), `${name}: the block anchored by ${held[0]} changed; if intended, pin its new hash. Block: ${block}`).toBe(pinned[held[0]!]);
      }
      for (const anchor of anchors) expect(differ.some((block) => block.includes(anchor)), `${name}: ${anchor}`).toBe(true);
      expect(opencode, name).not.toContain('mcp__orchestrator_operator__');
      expect(opencode, name).toContain('orchestrator_operator_');
    }
  });

  it('the skill edition is OpenCode-specific: no plugin root, no workflow or subagents, no Claude model names, AGENTS.md first', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else files.push(path.join(dir, e.name));
      }
    };
    walk(host);
    for (const file of files) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.includes('CLAUDE.md')) expect(line, path.relative(root, file)).toContain('AGENTS.md');
      }
    }
    for (const name of ['import', 'review', 'run']) {
      const text = readFileSync(path.join(host, 'skills', name, 'SKILL.md'), 'utf8');
      expect(text, name).toMatch(new RegExp(`^---\\nname: orchestrator-${name}\\ndescription: .+ from an OpenCode session\\b.*\\n---\\n`));
      expect(text, name).not.toContain('${CLAUDE_PLUGIN_ROOT}');
      expect(text, name).not.toMatch(/Workflow|subagents? (work|run)|work\.js|claimModel|session subagents/);
      // A Claude Code model id; opencode's own default, anthropic/claude-opus-5-5, is a provider/model id.
      expect(text, name).not.toMatch(/(?<!anthropic\/)claude-(opus|sonnet|haiku)-/);
      expect(text, name).not.toMatch(/tool_timeout_sec|approval_policy|config\.toml|mcp__linear__/);
    }
    const run = readFileSync(path.join(host, 'skills/run/SKILL.md'), 'utf8');
    const opencodeLine = 'detected: npm test on main; workers opencode anthropic/claude-opus-5-5 at medium (default); permission derived, agent commits';
    for (const word of ['mode: "spawn"', 'modeNote', 'needsConfig', 'AGENTS.md', 'needsAccess', 'permission: "allow"', opencodeLine, 'runner.opencode.*', '"orchestrator_operator_*"', 'opencode.json']) expect(run, word).toContain(word);
    const imp = readFileSync(path.join(host, 'skills/import/SKILL.md'), 'utf8');
    for (const word of ['linear_<tool>', 'atlassian_<tool>', 'gh auth status', 'AGENTS.md', 'runner:<kind>', 'mode: "spawn"']) expect(imp, word).toContain(word);
    expect(imp.replace(/\s+/g, ' ')).toContain(opencodeLine);
  });

  it('the README covers registration, skills install, the plugin, the start-mode rule, and the stdio-close release', () => {
    const readme = readFileSync(path.join(host, 'README.md'), 'utf8');
    for (const word of ['"orchestrator_operator"', '"timeout": 180000', 'mcp.timeout.execution', 'opencode mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=', 'opencode mcp list', 'OPENCODE_CONFIG=',
      '~/.agents/skills/orchestrator-run', '.opencode/skills/', '~/.config/opencode/plugins', 'ORCH_OPENCODE_HOST', 'session.created', 'chat.message', '--pure',
      'mode: "spawn"', 'runner.mode', 'stdio', '`sessionEnded`', 'ORCH_E2E_OPENCODE_HOST=1']) expect(readme, word).toContain(word);
  });

  describe('session plugin', () => {
    it('exports exactly one function, since OpenCode calls every exported function as a plugin', async () => {
      const mod = await loadPlugin();
      expect(Object.keys(mod)).toEqual(['OrchestratorPlugin']);
      expect(typeof mod['OrchestratorPlugin']).toBe('function');
    });

    it('appends the start line to the first user message once, and shows it as a toast', async () => {
      const home = attentionHome();
      try {
        const line = startLine(home);
        expect(line).toMatch(/^orchestrator: 1 run under .* need attention: \/tmp\/fixture-repo \(daemon exited idle 2 min ago: 2 launches parked\)/);
        const { toasts, first, second } = await driveSession(home);
        expect(first.parts).toEqual([{ type: 'text', text: `hello\n\n${line}` }]);
        expect(second.parts).toEqual([{ type: 'text', text: 'again' }]);
        expect(toasts).toEqual([{ body: { title: 'orchestrator', message: line, variant: 'info' } }]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('leaves the message untouched and shows no toast when nothing needs attention', async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'orch-oc-empty-'));
      try {
        expect(startLine(home)).toBe('');
        const { toasts, first } = await driveSession(home);
        expect(first.parts).toEqual([{ type: 'text', text: 'hello' }]);
        expect(toasts).toEqual([]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('skips a subagent session and survives a client without a TUI', async () => {
      const home = attentionHome();
      try {
        const child = await driveSession(home, { id: 's2', parentID: 's1' });
        expect(child.first.parts).toEqual([{ type: 'text', text: 'hello' }]);
        expect(child.toasts).toEqual([]);
        const mod = await loadPlugin();
        const before = process.env['ORCH_HOME'];
        process.env['ORCH_HOME'] = home;
        try {
          const hooks = (await (mod['OrchestratorPlugin'] as (a: unknown) => Promise<Hooks>)({ client: { tui: { showToast: async () => { throw new Error('no tui'); } } } })) as Hooks;
          await hooks.event({ event: { type: 'session.created', properties: { info: { id: 's3' } } } });
          const out = { message: {}, parts: [{ type: 'text', text: 'hi' }] };
          await hooks['chat.message']({ sessionID: 's3' }, out);
          expect(out.parts[0]!.text).toContain('orchestrator: 1 run');
        } finally {
          if (before === undefined) delete process.env['ORCH_HOME'];
          else process.env['ORCH_HOME'] = before;
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe.skipIf(!OPENCODE_HOST)('with the installed opencode (ORCH_E2E_OPENCODE_HOST=1)', () => {
    const filled = () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'orch-oc-cfg-'));
      writeFileSync(path.join(dir, 'opencode.json'), snippetText.replaceAll('<hosts/opencode>', host));
      mkdirSync(path.join(dir, 'xdg'));
      return dir;
    };

    it('opencode mcp list reports the snippet\'s server connected', async () => {
      if (!opencodeOnPath()) return;
      const dir = filled();
      try {
        const { stdout } = await execFileP('opencode', ['mcp', 'list'], { env: { ...process.env, OPENCODE_CONFIG: path.join(dir, 'opencode.json'), XDG_CONFIG_HOME: path.join(dir, 'xdg') }, timeout: 120_000 });
        // eslint-disable-next-line no-control-regex
        const plain = stdout.replace(/\x1b\[[0-9;]*m/g, '');
        expect(plain, plain).toMatch(/orchestrator_operator\s+connected/);
        expect(plain).toContain(launcher);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 150_000);

    it('opencode run with the snippet calls orchestrator_operator_start and reads mode in the result', async () => {
      if (!opencodeOnPath()) return;
      const dir = filled();
      const home = mkdtempSync(path.join(tmpdir(), 'orch-oc-op-home-'));
      const base = mkdtempSync(path.join(tmpdir(), 'orch-oc-op-repo-'));
      const repo = realpathSync(makeRepo(base));
      writeFileSync(path.join(repo, 'orchestrator.yaml'), [`runnerCommand: "node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`, 'checkCommand: "true"', 'capacity: 1'].join('\n'));
      gitIn(repo, 'add', 'orchestrator.yaml');
      gitIn(repo, 'commit', '-m', 'orchestrator config');
      // The MCP child inherits OpenCode's whole environment.
      const env = { ORCH_HOME: home, ORCH_REPO: repo, OPENCODE_CONFIG: path.join(dir, 'opencode.json'), XDG_CONFIG_HOME: path.join(dir, 'xdg') };
      try {
        const events = await opencodeRun('Call the orchestrator_operator_start tool once with mode "spawn" and no other arguments. Then reply with only the value of the "mode" field of its result.', repo, env);
        const calls = events.filter((e) => e.type === 'tool_use' && e.part?.tool === 'orchestrator_operator_start');
        const diag = JSON.stringify(events.slice(-10));
        expect(calls.length, diag).toBeGreaterThan(0);
        expect(calls[0]!.part!.state!.status, diag).toBe('completed');
        expect(JSON.parse(calls[0]!.part!.state!.output!), diag).toMatchObject({ mode: 'spawn' });
        const reply = finalText(events);
        expect(reply, diag).toMatch(/spawn\s*$/);
      } finally {
        const lifecycleEnv = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
        for (const r of await listRuns(lifecycleEnv)) if (r.alive && r.repo) await stopDaemon({ repo: r.repo, env: lifecycleEnv, reap: true });
        rmSync(home, { recursive: true, force: true });
        rmSync(base, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    }, 360_000);

    it('the linked plugin loads under a scratch XDG_CONFIG_HOME and the model repeats the start line verbatim; with an empty ORCH_HOME there is none', async () => {
      if (!opencodeOnPath()) return;
      const dir = filled();
      const home = attentionHome();
      const empty = mkdtempSync(path.join(tmpdir(), 'orch-oc-empty-'));
      try {
        const plugins = path.join(dir, 'xdg', 'opencode', 'plugins');
        mkdirSync(plugins, { recursive: true });
        symlinkSync(path.join(host, 'plugins/orchestrator.js'), path.join(plugins, 'orchestrator.js'));
        const ask = 'Reply with only the exact text of any line in this message that starts with "orchestrator:", or NONE if there is none.';
        const line = startLine(home);
        const withNotice = await opencodeRun(ask, empty, { ORCH_HOME: home, XDG_CONFIG_HOME: path.join(dir, 'xdg') });
        const reply = finalText(withNotice);
        expect(reply, JSON.stringify(withNotice.slice(-5))).toContain(line);
        const without = await opencodeRun(ask, empty, { ORCH_HOME: empty, XDG_CONFIG_HOME: path.join(dir, 'xdg') });
        const none = finalText(without);
        expect(none, JSON.stringify(without.slice(-5))).not.toContain('orchestrator: ');
        expect(none).toMatch(/NONE\s*$/);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(empty, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    }, 660_000);
  });
});
