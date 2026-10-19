import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_OPENCODE_COMMAND } from '../../src/runner/command.js';
import { bashPatterns, checkCommandPatterns, classifyOpenCodeFailure, composeOpenCodeCommand, openCodeConfig, OpenCodeRunner, type OpenCodeSettings } from '../../src/runner/opencode.js';
import { logPath } from '../../src/runner/subprocess.js';
import type { Launch } from '../../src/state/store.js';

const TOKEN = 'tok-opencode-secret';
const SHIM = { command: 'node', args: ['/opt/orch/dist/agent/mcp-shim.js'] };
const MAX_WAIT_MS = 60 * 60_000;
const defaults: OpenCodeSettings = { permission: 'derived', dataDir: 'shared', ignoreUserConfig: false, pure: true, snapshots: false };
const RULES = ['Bash(git:*)', 'mcp__orchestrator__heartbeat', 'Bash(npm test:*)', 'Bash(git status)'];

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function launchIn(worktree: string, over: Partial<Launch> = {}): Launch {
  return { launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'launching', token: TOKEN, branch: 'task/T1/l1', worktree, baseSha: 'b', graphRev: 'r', createdAt: 1, runner: 'opencode', model: 'opencode/big-pickle', effort: 'high', ...over } as Launch;
}

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (!existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
  return readFileSync(file, 'utf8');
}

// See specs/worker-runners "OpenCode runner command composition".
describe('OpenCode runner command', () => {
  it('composes the template with the brief on stdin, the model, and the variant', () => {
    const cmd = composeOpenCodeCommand(launchIn('/wt'), { settings: defaults });
    expect(cmd).toBe('opencode run --format json --pure --print-logs --log-level WARN -m opencode/big-pickle --variant high < /wt/.orchestrator/brief.md');
    expect(cmd).not.toContain(TOKEN);
    expect(cmd).not.toContain('ORCH_TOKEN');
    expect(cmd).not.toContain('opencode.json');
    expect(cmd).not.toContain('OPENCODE_CONFIG');
    expect(cmd).not.toMatch(/\{\w+\}/);
  });

  it('drops --pure under pure: false and --variant when effort is unset', () => {
    const plain = composeOpenCodeCommand(launchIn('/wt'), { settings: { pure: false } });
    expect(plain).not.toContain('--pure');
    expect(plain).toContain('--variant high');
    const noEffort = composeOpenCodeCommand(launchIn('/wt', { effort: undefined }), { settings: defaults });
    expect(noEffort).not.toContain('--variant');
    expect(noEffort).toContain('--pure');
    expect(composeOpenCodeCommand(launchIn('/wt'), { settings: defaults, brief: '/tmp/pre.md' }).endsWith('< /tmp/pre.md')).toBe(true);
  });

  it('the shell hands -m one word and the brief to stdin', () => {
    const dir = tmp('orch-opencode-sh-');
    const brief = path.join(dir, '.orchestrator', 'brief.md');
    mkdirSync(path.dirname(brief), { recursive: true });
    writeFileSync(brief, 'the brief');
    const cmd = composeOpenCodeCommand(launchIn(dir), { settings: defaults });
    const out = execFileSync('/bin/sh', ['-c', `opencode() { printf '%s\\n' "$@"; printf 'stdin=%s\\n' "$(cat)"; }\n${cmd}`], { encoding: 'utf8' });
    const argv = out.trimEnd().split('\n');
    expect(argv).toEqual(['run', '--format', 'json', '--pure', '--print-logs', '--log-level', 'WARN', '-m', 'opencode/big-pickle', '--variant', 'high', 'stdin=the brief']);
    expect(argv[argv.indexOf('-m') + 1]).toBe('opencode/big-pickle');
  });
});

describe('OpenCode per-launch config', () => {
  it('maps derived rules to bash patterns', () => {
    expect(bashPatterns(RULES)).toEqual(['git *', 'npm test *', 'git status']);
  });

  // test/fixtures/opencode/events/X-*.jsonl: 1.18.30 matches each command of an `&&`, `;` or `|` chain on its own.
  it('splits a check command into one exact pattern per command of the chain', () => {
    expect(checkCommandPatterns(undefined)).toEqual([]);
    expect(checkCommandPatterns('true')).toEqual(['true']);
    expect(checkCommandPatterns('npm ci --ignore-scripts && npm run build && npx vitest run --retry 2')).toEqual(['npm ci --ignore-scripts', 'npm run build', 'npx vitest run --retry 2']);
    expect(checkCommandPatterns('make lint; make test || true\ncargo test | tee out.txt')).toEqual(['make lint', 'make test', 'true', 'cargo test', 'tee out.txt']);
    // Separators inside quotes stay in the command; a repeated command is listed once.
    expect(checkCommandPatterns(`node -e "a && b; c | d" && node -e 'x || y' && true && true`)).toEqual(['node -e "a && b; c | d"', "node -e 'x || y'", 'true']);
  });

  // Each expected list is the command nodes OpenCode 1.18.30 matches: a subshell's commands, both sides of a lone `&`,
  // a quoted string holding an escaped quote kept whole, a redirection kept with its command
  // (test/fixtures/opencode/events/X-subshell, X-ampersand, X-escaped-quote, X-redirect-text; the old patterns are
  // denied in X-subshell-missplit and X-ampersand-whole).
  it('splits subshells, a lone ampersand and escaped quotes the way OpenCode sees the commands', () => {
    expect(checkCommandPatterns('(cd pkg && npm test)')).toEqual(['cd pkg', 'npm test']);
    expect(checkCommandPatterns('npm run lint & npm test')).toEqual(['npm run lint', 'npm test']);
    expect(checkCommandPatterns('echo "a \\" && b"')).toEqual(['echo "a \\" && b"']);
    expect(checkCommandPatterns('(cd a && make) && (cd b; make check)')).toEqual(['cd a', 'make', 'cd b', 'make check']);
    expect(checkCommandPatterns('npm test & wait')).toEqual(['npm test', 'wait']);
    expect(checkCommandPatterns('echo a\\;b && echo \\&')).toEqual(['echo a\\;b', 'echo \\&']);
    expect(checkCommandPatterns("echo 'a\\' && true")).toEqual(["echo 'a\\'", 'true']);
  });

  it('keeps redirections, substitutions and brace groups whole', () => {
    expect(checkCommandPatterns('npm test 2>&1 | tee out.txt')).toEqual(['npm test 2>&1', 'tee out.txt']);
    expect(checkCommandPatterns('make &> log.txt && make <&3 && echo a >| f')).toEqual(['make &> log.txt', 'make <&3', 'echo a >| f']);
    expect(checkCommandPatterns('make 2>&1 |& cat')).toEqual(['make 2>&1', 'cat']);
    expect(checkCommandPatterns('test -n "$(git status --porcelain && true)" || true')).toEqual(['test -n "$(git status --porcelain && true)"', 'true']);
    expect(checkCommandPatterns('echo $(date; true) && true')).toEqual(['echo $(date; true)', 'true']);
    expect(checkCommandPatterns('{ npm run lint; npm test; }')).toEqual(['npm run lint', 'npm test']);
  });

  // OpenCode 1.18.30 has no escape for `*` and `?` (X-glob-escape: `cat probe-\*.txt` does not allow `cat probe-*.txt`), so a
  // glob character in the check command is kept and its pattern is a wildcard (X-glob-star); `[` is literal (X-glob-bracket*).
  it('copies glob characters verbatim, giving a wildcard pattern', () => {
    expect(checkCommandPatterns('node --test test/*.test.js && ls a?.txt [ab].txt')).toEqual(['node --test test/*.test.js', 'ls a?.txt [ab].txt']);
  });

  it('carries the shim, the timeout, snapshots off, sharing off, and the derived ruleset', () => {
    const cfg = openCodeConfig(defaults, ['Bash(npm test:*)', 'Bash(git status)'], MAX_WAIT_MS, SHIM, 'npm ci && npm test');
    expect(cfg.mcp['orchestrator']).toEqual({ type: 'local', command: ['node', '/opt/orch/dist/agent/mcp-shim.js'], enabled: true, timeout: 3_660_000 });
    // No rule asks: a headless ask ends the run (events/P-ask.jsonl), a deny returns an error and the run goes on (events/P-deny.jsonl).
    expect(cfg.permission).toEqual({
      '*': 'deny',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      edit: 'allow',
      write: 'allow',
      bash: { '*': 'deny', 'git *': 'allow', 'npm test *': 'allow', 'git status': 'allow', 'npm ci': 'allow', 'npm test': 'allow' },
      'orchestrator_*': 'allow',
    });
    expect(JSON.stringify(cfg.permission)).not.toContain('ask');
    // `git add <f> && git commit -m <m>`: both commands match `git *` (events/X-chain-allowed.jsonl).
    expect(openCodeConfig(defaults, [], MAX_WAIT_MS, SHIM).permission['bash']).toEqual({ '*': 'deny', 'git *': 'allow' });
    // The catch-alls come first: OpenCode takes the last matching rule.
    expect(Object.keys(cfg.permission)[0]).toBe('*');
    expect(Object.keys(cfg.permission['bash'] as object)[0]).toBe('*');
    expect(openCodeConfig({ ...defaults, permission: 'allow' }, RULES, MAX_WAIT_MS, SHIM).permission).toEqual({ '*': 'allow' });
    expect(openCodeConfig({ ...defaults, snapshots: true }, [], MAX_WAIT_MS, SHIM)).not.toHaveProperty('snapshots');
    expect(openCodeConfig({ ...defaults, toolTimeoutMs: 120_000 }, [], MAX_WAIT_MS, SHIM).mcp['orchestrator']?.timeout).toBe(120_000);
    expect(openCodeConfig(defaults, [], 90_500, SHIM).mcp['orchestrator']?.timeout).toBe(150_500);
  });
});

/** A fake `opencode` on PATH that records its environment and argv and echoes its stdin. */
function fakeOpencode(dir: string): string {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = [
    '#!/bin/sh',
    'out="$PWD/.orchestrator/fake"',
    'mkdir -p "$out"',
    `printf '%s' "$OPENCODE_CONFIG_CONTENT" > "$out/config.json"`,
    `printf '%s' "\${XDG_DATA_HOME-unset}" > "$out/xdg-data"`,
    `printf '%s' "\${XDG_CONFIG_HOME-unset}" > "$out/xdg-config"`,
    `printf '%s' "\${ORCH_TOKEN-}" > "$out/token"`,
    `printf '%s\\n' "$@" > "$out/argv"`,
    'cat > "$out/stdin"',
    'cat "$out/stdin"',
    'touch "$out/done"',
  ].join('\n');
  const file = path.join(bin, 'opencode');
  writeFileSync(file, `${script}\n`);
  chmodSync(file, 0o755);
  return bin;
}

async function spawnFake(settings: Partial<OpenCodeSettings>, rules = ['Bash(npm test:*)', 'Bash(git status)']): Promise<{ worktree: string; fake: (f: string) => string; logDir: string }> {
  const dir = tmp('orch-opencode-');
  const bin = fakeOpencode(dir);
  const worktree = path.join(dir, 'wt');
  mkdirSync(path.join(worktree, '.orchestrator'), { recursive: true });
  writeFileSync(path.join(worktree, '.orchestrator', 'brief.md'), 'do the task\n');
  writeFileSync(path.join(worktree, '.orchestrator', 'brief.json'), JSON.stringify({ checkCommand: 'node --test' }));
  const logDir = path.join(dir, 'logs');
  const runner = new OpenCodeRunner({
    command: () => DEFAULT_OPENCODE_COMMAND,
    settings: () => ({ ...defaults, ...settings }),
    allowedTools: () => rules,
    maxWaitMs: MAX_WAIT_MS,
    retryWindowMs: 5000,
    logDir,
    shim: SHIM,
    extraEnv: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, XDG_DATA_HOME: '', XDG_CONFIG_HOME: '' },
  });
  await runner.spawn(launchIn(worktree), { ORCH_API: 'http://127.0.0.1:9' });
  const out = path.join(worktree, '.orchestrator', 'fake');
  await waitForFile(path.join(out, 'done'));
  return { worktree, fake: (f) => readFileSync(path.join(out, f), 'utf8'), logDir };
}

// See specs/worker-runners "OpenCode runner command composition" and specs/agent-protocol "Agent environment".
describe('OpenCode runner spawn', () => {
  it('passes the per-launch config in OPENCODE_CONFIG_CONTENT, the brief on stdin, and the token only in the environment', async () => {
    const { worktree, fake, logDir } = await spawnFake({});
    const cfg = JSON.parse(fake('config.json')) as Record<string, any>;
    expect(cfg['mcp']['orchestrator']['command']).toEqual([SHIM.command, ...SHIM.args]);
    expect(cfg['mcp']['orchestrator']['timeout']).toBe(3_660_000);
    expect(cfg['mcp']['orchestrator']).not.toHaveProperty('environment');
    expect(cfg['mcp']).not.toHaveProperty('timeout');
    expect(cfg['snapshots']).toBe(false);
    expect(cfg['share']).toBe('disabled');
    // The check command comes from the launch's brief.json.
    expect(cfg['permission']['bash']).toEqual({ '*': 'deny', 'git *': 'allow', 'npm test *': 'allow', 'git status': 'allow', 'node --test': 'allow' });
    expect(cfg['permission']['write']).toBe('allow');
    expect(cfg['permission']['orchestrator_*']).toBe('allow');
    expect(JSON.stringify(cfg)).not.toContain(TOKEN);
    expect(fake('token')).toBe(TOKEN);
    expect(fake('stdin')).toBe('do the task\n');
    expect(fake('argv').trimEnd().split('\n')).toEqual(['run', '--format', 'json', '--pure', '--print-logs', '--log-level', 'WARN', '-m', 'opencode/big-pickle', '--variant', 'high']);
    expect(fake('xdg-data')).toBe('unset');
    expect(fake('xdg-config')).toBe('unset');
    const file = path.join(worktree, '.orchestrator', 'opencode.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(cfg);
    // The fake echoes its stdin into the launch log.
    expect(await waitForFile(path.join(logDir, 'L1.log'))).toContain('do the task');
  });

  it('follows toolTimeoutMs, dataDir: launch, and ignoreUserConfig', async () => {
    const { worktree, fake } = await spawnFake({ toolTimeoutMs: 120_000, dataDir: 'launch', ignoreUserConfig: true });
    expect((JSON.parse(fake('config.json')) as Record<string, any>)['mcp']['orchestrator']['timeout']).toBe(120_000);
    expect(fake('xdg-data')).toBe(path.join(worktree, '.orchestrator', 'opencode-data'));
    const configHome = fake('xdg-config');
    expect(configHome).toBe(path.join(worktree, '.orchestrator', 'opencode-config'));
    expect(statSync(configHome).isDirectory()).toBe(true);
    expect(readdirSync(configHome)).toEqual([]);
  });
});

const EVENTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/opencode/events');
const fixture = (...files: string[]) => files.map((f) => readFileSync(path.join(EVENTS, f), 'utf8')).join('\n');
// Synthetic: the probe saw this error on stderr with --log-level ERROR but did not save the line.
const BAD_MODEL_LINE = 'timestamp=2026-10-19T00:20:01.000Z level=ERROR run=e1 message="process" error="ProviderModelNotFoundError: Model not found: opencode/gpt-bogus-9. Did you mean: opencode/gpt-5?"';
const OPAQUE = 'Unexpected server error. Check server logs for details.';

// See specs/task-lifecycle "Health failure reasons": the opencode reasons over the probe logs of 1.18.30.
describe('classifyOpenCodeFailure', () => {
  it('an unknown model alone is an opaque turnFailed; with its ERROR line it is unknownModel naming the model', () => {
    expect(classifyOpenCodeFailure(fixture('E-badmodel.jsonl'))).toEqual({ reason: 'turnFailed', detail: OPAQUE });
    const named = classifyOpenCodeFailure(fixture('E-badmodel.jsonl') + '\n' + BAD_MODEL_LINE);
    expect(named?.reason).toBe('unknownModel');
    expect(named?.detail).toContain('Model not found: opencode/gpt-bogus-9');
  });

  it('turnFailed takes the ERROR line carrying the event ref', () => {
    const line = 'timestamp=t level=ERROR run=e1 ref=err_8135f5fd error="SomeProviderError: boom"';
    expect(classifyOpenCodeFailure(fixture('E-badmodel.jsonl') + '\n' + line)).toEqual({ reason: 'turnFailed', detail: 'SomeProviderError: boom' });
  });

  it('a shim that never started is mcpStartupFailed although the turn completed', () => {
    expect(classifyOpenCodeFailure(fixture('D4.jsonl'))).toBeUndefined();
    const out = classifyOpenCodeFailure(fixture('D4.err', 'D4.jsonl'));
    expect(out?.reason).toBe('mcpStartupFailed');
    expect(out?.detail).toContain('message="server unavailable" key=orchestrator type=local status=failed');
  });

  it('an auto-rejected ask ends the run and is permissionDenied naming the command', () => {
    // events/P-ask.jsonl: the step ends with reason tool-calls and no further step follows.
    const out = classifyOpenCodeFailure(fixture('P-ask.jsonl', 'P-ask.err'));
    expect(out?.reason).toBe('permissionDenied');
    expect(out?.detail).toContain('bash (uname -s): The user rejected permission to use this specific tool call.');
  });

  it('a deny refusal the agent continued past is not a failure', () => {
    for (const f of ['P-deny.jsonl', 'X-chain-offpattern.jsonl', 'X-pipe-offpattern.jsonl', 'X-whole-string.jsonl']) {
      expect(fixture(f)).toContain('The user has specified a rule which prevents you');
      expect(classifyOpenCodeFailure(fixture(f))).toBeUndefined();
    }
  });

  it('a rejected command is permissionDenied naming it; a removed tool with a completed turn is not a failure', () => {
    const out = classifyOpenCodeFailure(fixture('F1-ask.jsonl', 'F1-ask.err'));
    expect(out?.reason).toBe('permissionDenied');
    expect(out?.detail).toContain('echo marker-7731');
    expect(classifyOpenCodeFailure(fixture('F1-ask.err'))).toEqual({ reason: 'permissionDenied', detail: '! permission requested: bash (echo marker-7731); auto-rejecting' });
    expect(classifyOpenCodeFailure(fixture('F2-deny.jsonl'))).toBeUndefined();
  });

  it('a locked shared database at startup is startupContended', () => {
    expect(classifyOpenCodeFailure(fixture('K2.err'))).toEqual({ reason: 'startupContended', detail: 'database is locked' });
    expect(classifyOpenCodeFailure(fixture('SA-proj.err'))).toEqual({ reason: 'startupContended', detail: 'database is locked' });
    // Never after the first event: then it is not a startup death.
    expect(classifyOpenCodeFailure(fixture('C2.jsonl', 'K2.err'))).toBeUndefined();
  });

  it('duplicate skill warnings are noise; an empty log is exitBeforeTurn without detail', () => {
    const skills = fixture('D4.err').split('\n').filter((l) => l.includes('duplicate skill name'));
    expect(skills.length).toBeGreaterThan(10);
    expect(classifyOpenCodeFailure([...skills, fixture('C2.jsonl')].join('\n'))).toBeUndefined();
    expect(classifyOpenCodeFailure('')).toEqual({ reason: 'exitBeforeTurn' });
    expect(classifyOpenCodeFailure(skills.join('\n'))).toEqual({ reason: 'exitBeforeTurn' });
    expect(classifyOpenCodeFailure('level=INFO message=init\nError: spawn failed\nbye')).toEqual({ reason: 'exitBeforeTurn', detail: 'Error: spawn failed' });
  });

  it('an ERROR line about the login is authFailed; the bare word authentication is not', () => {
    // Synthetic: no failed login was observed in the probes.
    const line = 'timestamp=t level=ERROR run=a1 error="AuthError: 401 Unauthorized: invalid api key"';
    expect(classifyOpenCodeFailure(line)).toEqual({ reason: 'authFailed', detail: 'AuthError: 401 Unauthorized: invalid api key' });
    expect(classifyOpenCodeFailure('level=INFO message="using authentication from auth.json"\n' + fixture('C2.jsonl'))).toBeUndefined();
  });

  it('OpenCodeRunner.readFailure classifies the launch log; no log is no diagnosis', async () => {
    const dir = tmp('orch-opencode-fail-');
    const runner = new OpenCodeRunner({ command: () => DEFAULT_OPENCODE_COMMAND, settings: () => defaults, maxWaitMs: MAX_WAIT_MS, retryWindowMs: 5000, logDir: dir });
    const launch = launchIn(dir);
    expect(await runner.readFailure(launch)).toBeUndefined();
    writeFileSync(logPath(dir, launch.launchId), fixture('K2.err'));
    expect(await runner.readFailure(launch)).toEqual({ reason: 'startupContended', detail: 'database is locked' });
  });
});
