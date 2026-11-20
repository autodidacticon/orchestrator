/**
 * Opt-in end to end of the ACP probe client against a real `opencode acp` (GH-197):
 *   ORCH_E2E_ACP_OPENCODE=1 npm test -- test/e2e/acp-opencode
 * Runs on the free model `opencode/big-pickle` (opencode 1.18.30 when written): no login, no key. The client
 * (test/fixtures/acp/acp-client.mjs) is started as a subprocess leading its own process group, in a scratch linked
 * worktree, with the recording shim (test/fixtures/acp/recording-shim.mjs) passed in `session/new.mcpServers`, a short
 * environment built here and every XDG directory under the scratch directory.
 * It asserts what the client guarantees whatever OpenCode does (a `result` line within five minutes, a frames file that
 * parses, no process left), and pins what does not depend on the model's turn: the `protocolVersion` of the `initialize`
 * answer, the environment variable names the recording shim was started with (test/fixtures/acp/opencode/shim/S0-good-logs.jsonl,
 * the probe run with the same agent flags),
 * and how the agent ends once its stdin is closed. See test/fixtures/acp/README.md.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env['ORCH_E2E_ACP_OPENCODE'] === '1';
const MODEL = 'opencode/big-pickle';
const acp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/acp');
const CLIENT = path.join(acp, 'acp-client.mjs');
const SHIM = path.join(acp, 'recording-shim.mjs');

function opencodeOnPath(): boolean {
  try {
    execFileSync('opencode', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return false;
  }
}

const hasOpencode = enabled && opencodeOnPath();
if (enabled && !hasOpencode) console.warn('opencode CLI not on PATH; ACP e2e skipped (install `opencode` 1.18.30 or later)');

type Line = Record<string, unknown> & { type?: string };
interface ClientRun {
  code: number | null;
  ms: number;
  lines: Line[];
  frames: Array<Record<string, unknown>>;
  shim: Array<Record<string, unknown>>;
  pgid: number;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.invalid', GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'author@example.invalid' } });

/** The pids of every process whose process group is `pgid`. */
function groupMembers(pgid: number): number[] {
  return execFileSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([pid, g]) => g === pgid && pid !== undefined)
    .map(([pid]) => pid as number);
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

describe.skipIf(!hasOpencode)('e2e: the ACP probe client against opencode acp', () => {
  let scratch: string;
  let wt: string;
  let n = 0;

  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-acp-e2e-')));
    const repo = path.join(scratch, 'repo');
    mkdirSync(repo);
    mkdirSync(path.join(scratch, 'home'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Fixture Author');
    git(repo, 'config', 'user.email', 'author@example.invalid');
    writeFileSync(path.join(repo, 'README.md'), '# e2e\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'initial');
    writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '.orchestrator/\n', { flag: 'a' });
    wt = path.join(scratch, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'task/PROBE/l1', wt);
  });
  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  /** One client run, detached so that it leads its own group; killed as a group at `limitMs`. */
  async function runClient(prompt: string | undefined, limitMs: number): Promise<ClientRun> {
    const id = `run${++n}`;
    const dir = path.join(scratch, id);
    const xdg = path.join(scratch, 'xdg', id);
    for (const d of ['data', 'config', 'state', 'cache']) mkdirSync(path.join(xdg, d), { recursive: true });
    const files = { frames: path.join(dir, 'frames.jsonl'), shim: path.join(dir, 'shim.jsonl'), mcp: path.join(dir, 'mcp.json'), prompt: path.join(dir, 'prompt.txt') };
    mkdirSync(dir);
    writeFileSync(files.mcp, JSON.stringify([{ name: 'orchestrator', command: process.execPath, args: [SHIM, files.shim, '--block-sec', '75'], env: [{ name: 'ORCH_LAUNCH_ID', value: 'probe-launch' }, { name: 'ORCH_TOKEN', value: 'orch-probe-token-0e2e0e2e' }, { name: 'ORCH_API', value: 'http://127.0.0.1:9' }, { name: 'PROBE_FROM_SESSION', value: '1' }] }]));
    if (prompt) writeFileSync(files.prompt, prompt);
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? '',
      HOME: path.join(scratch, 'home'),
      USER: process.env['USER'] ?? 'probe',
      LANG: process.env['LANG'] ?? 'en_US.UTF-8',
      TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
      XDG_DATA_HOME: path.join(xdg, 'data'),
      XDG_CONFIG_HOME: path.join(xdg, 'config'),
      XDG_STATE_HOME: path.join(xdg, 'state'),
      XDG_CACHE_HOME: path.join(xdg, 'cache'),
      ORCH_LAUNCH_ID: 'probe-launch',
      ORCH_TOKEN: 'orch-probe-token-0e2e0e2e',
      ORCH_API: 'http://127.0.0.1:9',
      PROBE_MARKER: 'from-client-env',
      PWD: wt,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: MODEL, share: 'disabled', permission: { '*': 'deny', read: 'allow', bash: { '*': 'deny', 'git *': 'allow' }, 'orchestrator_*': 'allow' } }),
    };
    const args = [CLIENT, '--agent-json', JSON.stringify(['opencode', 'acp', '--pure', '--print-logs', '--log-level', 'WARN']), '--cwd', wt, '--mcp-json', files.mcp, '--frames', files.frames, '--turn-timeout-ms', String(limitMs - 30_000), '--cancel-grace-ms', '10000', ...(prompt ? ['--prompt-file', files.prompt] : [])];
    const t0 = Date.now();
    const child = spawn(process.execPath, args, { cwd: wt, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, limitMs);
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    clearTimeout(timer);
    const parse = (text: string) => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code, ms: Date.now() - t0, lines: parse(stdout) as Line[], frames: existsSync(files.frames) ? parse(readFileSync(files.frames, 'utf8')) : [], shim: existsSync(files.shim) ? parse(readFileSync(files.shim, 'utf8')) : [], pgid: child.pid! };
  }

  async function expectNothingLeft(r: ClientRun): Promise<void> {
    await new Promise((res) => setTimeout(res, 1000));
    expect(groupMembers(r.pgid), 'processes left in the client group').toEqual([]);
    for (const s of r.shim.filter((x) => x['event'] === 'start')) expect(alive(s['pid'] as number), `shim ${String(s['pid'])} left`).toBe(false);
  }

  it('no prompt: initialize answers protocolVersion 1, the shim starts with the pinned variable names, and the agent ends once stdin is closed', async () => {
    const r = await runClient(undefined, 120_000);
    const result = r.lines.find((l) => l.type === 'result') as Line & { agentExit?: { code: number | null; how: string } };
    expect(result, JSON.stringify(r.lines)).toBeDefined();
    expect(r.code).toBe(0);
    const init = r.frames.find((f) => f['dir'] === 'recv' && (f['msg'] as { id?: number })?.id === 0) as { msg: { result: { protocolVersion: number } } };
    expect(init.msg.result.protocolVersion).toBe(1);
    // OpenCode passes its own environment plus the session's `env` entries to the MCP server (probe question 4); --print-logs and
    // --log-level add OPENCODE_PRINT_LOGS and OPENCODE_LOG_LEVEL, so the probe run with the same flags is the reference.
    const recorded = readFileSync(path.join(acp, 'opencode', 'shim', 'S0-good-logs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; envNames: string[] });
    const platform = (names: string[]) => names.filter((k) => !k.startsWith('__CF_'));
    const start = r.shim.find((s) => s['event'] === 'start') as { envNames: string[] } | undefined;
    expect(start, 'the recording shim started').toBeDefined();
    expect(platform(start!.envNames)).toEqual(platform(recorded.find((s) => s.event === 'start')!.envNames));
    expect(result.agentExit).toMatchObject({ code: 0, how: 'stdinClosed' });
    await expectNothingLeft(r);
  }, 150_000);

  it('one turn: a result line within five minutes, a frames file that parses, no process left', async () => {
    const r = await runClient('Call the orchestrator_heartbeat tool once with progress "e2e". Then reply DONE.', 300_000);
    expect(r.ms).toBeLessThan(300_000);
    expect(r.lines.some((l) => l.type === 'result'), JSON.stringify(r.lines.slice(-3))).toBe(true);
    expect(r.frames.length).toBeGreaterThan(0);
    const methods = r.frames.filter((f) => f['dir'] === 'send').map((f) => (f['msg'] as { method?: string }).method);
    expect(methods.slice(0, 3)).toEqual(['initialize', 'session/new', 'session/prompt']);
    await expectNothingLeft(r);
  }, 330_000);
});
