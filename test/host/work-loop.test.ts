import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { composeOpenCodeCommand, OpenCodeRunner, openCodePermission, type OpenCodeSettings } from '../../src/runner/opencode.js';
import { DEFAULT_OPENCODE_COMMAND } from '../../src/runner/command.js';
import type { Launch } from '../../src/state/store.js';
import { makeSlice, type SliceHarness, tsxLoader } from '../slice/harness.js';
// @ts-expect-error a plain .mjs host script without type declarations
import { packageModules, parseWorkArgs, stopVerdict, workerPreamble } from '../../hosts/codex/bin/work.mjs';

/**
 * The work loop by runner kind (hosts/codex/bin/work.mjs) with `--runner opencode` against a
 * pull-mode opencode run, with a fake `opencode` first on PATH. The fake records its argv, its
 * environment and its stdin, runs the scripted behaviour through the HTTP API (it is not a model),
 * and prints the recorded JSONL of test/fixtures/opencode/events/H1.jsonl; with `opencodeMode: locked`
 * in the task payload it prints the recorded `database is locked` startup failure (K2.err) instead.
 * See specs/host-integration "Work loop by runner kind".
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const workMjs = path.resolve(here, '../../hosts/codex/bin/work.mjs');
const scripted = path.resolve(here, '../agents/scripted.ts');
const events = path.resolve(here, '../fixtures/opencode/events');
const execFileP = promisify(execFile);

let h: SliceHarness | undefined;
let child: ChildProcess | undefined;
afterEach(async () => {
  child?.kill('SIGKILL');
  child = undefined;
  await h?.cleanup();
  h = undefined;
});

const FAKE = `import { mkdirSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const stdin = readFileSync(0, 'utf8');
const orchDir = path.join(process.cwd(), '.orchestrator');
mkdirSync(orchDir, { recursive: true });
const keys = ['OPENCODE_CONFIG_CONTENT', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'ORCH_API', 'ORCH_LAUNCH_ID', 'ORCH_TOKEN', 'ORCH_RETRY_WINDOW_MS', 'ORCH_COMMIT_POLICY', 'ORCH_URL'];
const env = Object.fromEntries(keys.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
const briefPath = path.join(orchDir, 'brief.json');
const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
const read = (f) => { try { return readFileSync(path.join(orchDir, f), 'utf8'); } catch { return undefined; } };
// Outside the worktree, which is removed once the task is done.
writeFileSync(path.join(process.env.FAKE_OPENCODE_CAPTURE, process.env.ORCH_LAUNCH_ID + '.json'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env, stdin, brief: read('brief.md'), prompt: read('opencode-work-prompt.md'), configFile: read('opencode.json'), configMode: statSync(path.join(orchDir, 'opencode.json')).mode & 0o777 }, null, 2));
if (brief.task.opencodeMode === 'locked') {
  process.stderr.write(readFileSync(${JSON.stringify(path.join(events, 'K2.err'))}, 'utf8'));
  process.exit(1);
}
const lines = readFileSync(${JSON.stringify(path.join(events, 'H1.jsonl'))}, 'utf8').trimEnd().split('\\n');
writeSync(1, lines[0] + '\\n');
process.argv = [process.argv[0], ${JSON.stringify(scripted)}, briefPath];
const { finished } = await import(pathToFileURL(${JSON.stringify(scripted)}).href);
await finished;
for (const l of lines.slice(1)) writeSync(1, l + '\\n');
`;

/** A bin directory whose `opencode` is the fake. */
function binDir(h: SliceHarness): string {
  const dir = path.join(h.dir, 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'fake-opencode.mjs'), FAKE);
  writeFileSync(path.join(dir, 'opencode'), `#!/bin/sh\nexec node --import ${tsxLoader} ${path.join(dir, 'fake-opencode.mjs')} "$@"\n`, { mode: 0o755 });
  return dir;
}

function captureDir(h: SliceHarness): string {
  const dir = path.join(h.dir, 'captures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function startLoop(h: SliceHarness, bin: string, args: string[]): { done: Promise<{ code: number | null; stdout: string; stderr: string }> } {
  let stdout = '';
  let stderr = '';
  child = spawn(process.execPath, ['--import', tsxLoader, workMjs, '--url', h.orch.apiBaseUrl, '--poll-ms', '300', ...args], {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, FAKE_OPENCODE_CAPTURE: captureDir(h) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
  const c = child;
  return { done: new Promise((resolve) => c.on('close', (code) => resolve({ code, stdout, stderr }))) };
}

interface Capture {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  brief?: string;
  prompt?: string;
  configFile?: string;
  configMode: number;
}

const one = (extra = '') => `nodes:\n  - { id: T1, title: One, description: d, acceptanceCriteria: [a], deps: [], behavior: commitAndSubmit${extra} }`;
const opencodePull = { runner: { mode: 'pull' as const, kind: 'opencode' as const } };

describe('work loop --runner opencode (work.mjs, fake opencode on PATH)', () => {
  it('a claimed opencode launch runs the composed opencode run with the per-launch config, and its usage is posted with source worker', async () => {
    h = await makeSlice({ graph: one(), config: opencodePull });
    await h.waitFor(() => h!.store.listLaunches({ status: 'claimable' }).length === 1);
    const loop = startLoop(h, binDir(h), ['--runner', 'opencode', '--workers', '1', '--run-tag', 'oc', '--idle-exit-ms', '20000']);
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 60_000);
    const timer = setInterval(() => void h?.orch.tick(), 100);
    const out = await loop.done.finally(() => clearInterval(timer));
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toMatch(/stops: (the run is finished|nothing is claimable for opencode and the run waits on a human)/);

    const [l] = h.store.listLaunches();
    expect(l!.runner).toBe('opencode');
    expect(l!.worker?.id).toBe('oc-1');
    expect(l!.pid).toBeUndefined();
    // H1.jsonl: one step_finish with input 14534, output 11, reasoning 19.
    expect(l!.usageSource).toBe('worker');
    expect(l!.tokens?.input).toBe(14534);
    expect(l!.tokens?.output).toBeGreaterThanOrEqual(11);
    const usage = h.store.listEvents({ kind: 'operator.usage' }).map((e) => e.payload as { workerId?: string });
    expect(usage.map((p) => p.workerId)).toEqual(['oc-1']);
    const claims = h.store.listEvents({ kind: 'operator.claim' }).map((e) => e.payload as { runner?: unknown });
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((p) => p.runner === 'opencode')).toBe(true);

    // The command: the default template, -m with the launch's model, stdin from the loop's prompt file.
    const cap = JSON.parse(readFileSync(path.join(captureDir(h), `${l!.launchId}.json`), 'utf8')) as Capture;
    expect(cap.cwd.endsWith(path.join('worktrees', path.basename(l!.worktree)))).toBe(true);
    expect(cap.argv.slice(0, 3)).toEqual(['run', '--format', 'json']);
    expect(cap.argv).toContain('--pure');
    expect(cap.argv[cap.argv.indexOf('-m') + 1]).toBe(l!.model);
    expect(cap.stdin.startsWith('You are an OpenCode worker')).toBe(true);
    expect(cap.stdin).toContain('orchestrator_report');
    expect(cap.stdin).toContain(`claimed launch ${l!.launchId}`);
    expect(cap.brief).toBeTruthy();
    expect(cap.stdin.endsWith(cap.brief!)).toBe(true);
    // Stdin is redirected from the loop's prompt file (the preamble, then the brief).
    expect(cap.stdin).toBe(cap.prompt);
    // The shim's identity comes from the environment the MCP child inherits.
    expect(cap.env['ORCH_LAUNCH_ID']).toBe(l!.launchId);
    expect(cap.env['ORCH_TOKEN']).toBe(l!.token);
    expect(cap.env['ORCH_API']).toBe(h.orch.apiBaseUrl);
    expect(cap.env['ORCH_URL']).toBeUndefined();
    // dataDir shared and ignoreUserConfig false by default: no XDG overrides.
    expect(cap.env['XDG_DATA_HOME']).toBeUndefined();
    expect(cap.env['XDG_CONFIG_HOME']).toBeUndefined();

    const config = JSON.parse(cap.env['OPENCODE_CONFIG_CONTENT']!) as { mcp: Record<string, { command: string[]; timeout: number }>; permission: unknown; snapshots?: boolean };
    const shim = config.mcp['orchestrator']!;
    expect(shim.command[0]).toBe('node');
    expect(shim.command.at(-1)).toMatch(/agent[/\\]mcp-shim\.(ts|js)$/);
    expect(shim.timeout).toBe(h.config.maxWaitMs + 60_000);
    expect(config.snapshots).toBe(false);
    // The ruleset is the one the runner derives from the rules the claim carries.
    const allowedTools = h.orch.openCodeAllowedTools();
    expect(config.permission).toEqual(openCodePermission('derived', allowedTools, h.config.checkCommand));
    expect(JSON.parse(cap.configFile!)).toEqual(config);
    expect(cap.configMode).toBe(0o600);
  }, 90_000);

  it('an opencode claim carries the runner.opencode settings, the allowedTools, the long-poll ceiling, and the agent environment', async () => {
    h = await makeSlice({ graph: one(), config: { runner: { mode: 'pull', kind: 'opencode', opencode: { permission: 'allow', dataDir: 'launch' } } } });
    await h.waitFor(() => h!.store.listLaunches({ status: 'claimable' }).length === 1);
    const res = await fetch(`${h.orch.apiBaseUrl}/v1/claims`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workerId: 'w', runner: 'opencode' }) });
    const body = (await res.json()) as {
      token: string;
      runner: string;
      commitPolicy: string;
      codex?: unknown;
      opencode: { settings: OpenCodeSettings; allowedTools: string[]; maxWaitMs: number; retryWindowMs: number; env: Record<string, string> };
    };
    expect(res.status).toBe(200);
    expect(body.runner).toBe('opencode');
    expect(body.commitPolicy).toBe('agent');
    expect(body.codex).toBeUndefined();
    expect(body.opencode.settings.permission).toBe('allow');
    expect(body.opencode.settings.dataDir).toBe('launch');
    expect(body.opencode.allowedTools).toEqual(h.orch.openCodeAllowedTools());
    expect(body.opencode.maxWaitMs).toBe(h.config.maxWaitMs);
    expect(body.opencode.retryWindowMs).toBe(h.config.retryWindowMs);
    expect(body.opencode.env['ORCH_TOKEN']).toBe(body.token);
    expect(body.opencode.env['ORCH_API']).toBe(h.orch.apiBaseUrl);
  });

  it('a recorded `database is locked` start is named startupContended and released with keep for a relaunch, not failed', async () => {
    h = await makeSlice({ graph: one(', opencodeMode: locked'), config: opencodePull });
    await h.waitFor(() => h!.store.listLaunches({ status: 'claimable' }).length === 1);
    const loop = startLoop(h, binDir(h), ['--runner', 'opencode', '--workers', '1', '--run-tag', 'lk', '--max-failures', '2']);
    const timer = setInterval(() => void h?.orch.tick(), 100);
    const out = await loop.done.finally(() => clearInterval(timer));
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toMatch(/opencode exited \(code 1\) startupContended/);
    expect(out.stderr).toMatch(/2 launches in a row ended without opencode running or reporting/);
    const releases = h.store.listEvents({ kind: 'operator.release' }).map((e) => e.payload as { keep?: boolean; reason?: string });
    expect(releases.length).toBe(2);
    expect(releases.every((r) => r.keep === true && /opencode failed to start: startupContended/.test(String(r.reason)))).toBe(true);
    // Nothing ran, so each release returned the task to unstarted at no cost: no attempt was charged.
    const claimed = h.store.listLaunches().filter((l) => l.worker);
    expect(claimed.length).toBe(2);
    expect(claimed.every((l) => l.worker?.id === 'lk-1' && l.pid === undefined && l.status === 'ended')).toBe(true);
    const entry = h.orch.entry('T1');
    expect(['unstarted', 'running']).toContain(entry.status.kind);
    expect(entry.attempts ?? 0).toBe(0);
    const result = JSON.parse(out.stdout.trim().split('\n').pop()!) as { runner: string; outcomes: Array<{ result: string }> };
    expect(result.runner).toBe('opencode');
    expect(result.outcomes.map((o) => o.result)).toEqual(['contended', 'contended']);
  }, 90_000);

  it('against a daemon with no opencode launches, --runner opencode exits by the idle rule naming opencode', async () => {
    h = await makeSlice({ graph: one(), config: { runner: { mode: 'pull', kind: 'codex' } } });
    await h.waitFor(() => h!.store.listLaunches({ status: 'claimable' }).length === 1);
    const loop = startLoop(h, binDir(h), ['--runner', 'opencode', '--idle-exit-ms', '500']);
    const out = await loop.done;
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toMatch(/stops: nothing claimable for opencode for 500ms/);
    // The codex launch was left alone.
    expect(h.store.listLaunches({ status: 'claimable' }).length).toBe(1);
  }, 30_000);
});

describe('composeOpenCodeCommand in the loop', () => {
  const settings: OpenCodeSettings = { permission: 'derived', dataDir: 'shared', ignoreUserConfig: false, pure: true, snapshots: false };
  const launch = { worktree: '/tmp/wt', launchId: 'L1', taskId: 'T1', model: 'opencode/big-pickle', effort: 'high' } as Pick<Launch, 'worktree' | 'launchId' | 'taskId' | 'model' | 'effort'>;

  it('is the command the OpenCode runner spawns, with the brief swapped for the loop prompt', () => {
    const cmd = composeOpenCodeCommand(launch, { settings });
    expect(cmd.endsWith('< /tmp/wt/.orchestrator/brief.md')).toBe(true);
    const swapped = composeOpenCodeCommand(launch, { settings, brief: '/tmp/wt/.orchestrator/opencode-work-prompt.md' });
    expect(swapped).toBe(cmd.replace('/tmp/wt/.orchestrator/brief.md', '/tmp/wt/.orchestrator/opencode-work-prompt.md'));
    const runner = new OpenCodeRunner({ command: DEFAULT_OPENCODE_COMMAND, settings: () => settings, maxWaitMs: 60_000, retryWindowMs: 1000, logDir: '/tmp' });
    expect((runner as unknown as { opts: { compose: (l: unknown) => string } }).opts.compose(launch)).toBe(cmd);
  });
});

describe('work.mjs by kind', () => {
  it('--runner defaults to codex and accepts opencode; another kind is refused', () => {
    expect(parseWorkArgs([]).runner).toBe('codex');
    expect(parseWorkArgs(['--runner', 'opencode']).runner).toBe('opencode');
    expect(parseWorkArgs(['--runner', 'opencode']).runTag).toMatch(/^opencode-/);
    expect(() => parseWorkArgs(['--runner', 'claude-code'])).toThrow(/codex, opencode/);
  });

  it('--help names --runner <codex|opencode> with codex as the default', async () => {
    const { stdout } = await execFileP(process.execPath, [workMjs, '--help']);
    expect(stdout).toContain('--runner <codex|opencode>');
    expect(stdout).toMatch(/--runner codex \(the default\)/);
  });

  it('the stop rule reads the chosen kind', () => {
    const base = { finished: false, stalled: false, paused: false, claimableByKind: { 'claude-code': 0, codex: 2, opencode: 0 }, liveLaunches: [], openQuestions: [], awaitingReview: [] };
    expect(stopVerdict(base, 0, 1000, 1000, 'opencode')).toEqual({ stop: true, why: 'nothing claimable for opencode for 1000ms' });
    expect(stopVerdict(base, 0, 1000, 1000).stop).toBe(false);
    expect(stopVerdict({ ...base, liveLaunches: [{ runner: 'opencode' }] }, 0, 5000, 1000, 'opencode').stop).toBe(false);
    expect(stopVerdict({ ...base, openQuestions: ['T1'] }, undefined, 0, 1000, 'opencode').why).toMatch(/for opencode and the run waits on a human/);
  });

  it('the opencode preamble names the orchestrator_<tool> names and keeps the 401 and fallback-file rules', () => {
    const p = workerPreamble({ launchId: 'L1', taskId: 'T1', worktree: '/wt' }, 'oc-1', 'opencode') as string;
    expect(p).toContain('OpenCode worker');
    for (const t of ['heartbeat', 'report', 'block', 'inbox', 'log']) expect(p).toContain(`orchestrator_${t}`);
    expect(p).toContain('401');
    expect(p).toContain('Never write a fallback report file');
    expect(workerPreamble({ launchId: 'L1', taskId: 'T1', worktree: '/wt' }, 'cx-1')).toContain('Codex worker');
  });

  it('packageModules resolves the kind module', () => {
    const oc = packageModules('opencode') as { runner?: string; codex?: string; reexec?: string[] };
    if (oc.reexec) return; // not under tsx and no dist: the loop re-runs itself
    expect(oc.runner).toMatch(/runner[/\\]opencode\.(ts|js)$/);
    expect(oc.codex).toBeUndefined();
    expect((packageModules() as { codex: string }).codex).toMatch(/runner[/\\]codex\.(ts|js)$/);
  });
});
