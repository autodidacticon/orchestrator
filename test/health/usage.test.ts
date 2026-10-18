import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner, parseUsage } from '../../src/runner/claude-code.js';
import { CodexRunner, parseCodexUsage } from '../../src/runner/codex.js';
import { logPath } from '../../src/runner/subprocess.js';
import type { Launch } from '../../src/state/store.js';

const result = { type: 'result', subtype: 'success', is_error: false, duration_ms: 4567, duration_api_ms: 4000, num_turns: 3, result: 'done', total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 20 } };

describe('usage parser', () => {
  it('reads the last JSON object of a Claude Code log, after stderr noise and earlier objects', () => {
    const log = ['[warn] something on stderr', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }), 'more noise {not json', JSON.stringify(result), ''].join('\n');
    expect(parseUsage(log)).toEqual({ costUsd: 0.0123, turns: 3, durationMs: 4567, tokens: { input: 10, output: 20 }, source: 'claude-code' });
    expect(parseUsage(`noise\n${JSON.stringify(result, null, 2)}\n`)).toEqual({ costUsd: 0.0123, turns: 3, durationMs: 4567, tokens: { input: 10, output: 20 }, source: 'claude-code' });
  });

  it('lifts the cache fields into the runner-neutral token shape, cache reads counted inside input', () => {
    const cached = { ...result, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 } };
    expect(parseUsage(JSON.stringify(cached))?.tokens).toEqual({ input: 310, cachedInput: 300, cacheWriteInput: 40, output: 20 });
    expect(parseUsage(JSON.stringify({ ...result, usage: undefined }))).toEqual({ costUsd: 0.0123, turns: 3, durationMs: 4567, source: 'claude-code' });
  });

  it('yields nothing for a log without a usage object', () => {
    expect(parseUsage('')).toBeUndefined();
    expect(parseUsage('just text\nno braces here')).toBeUndefined();
    expect(parseUsage(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeUndefined();
    expect(parseUsage('{ broken')).toBeUndefined();
  });

  it('ClaudeCodeRunner.readUsage reads the launch log', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-usage-'));
    try {
      const runner = new ClaudeCodeRunner({ command: 'true', logDir: dir, retryWindowMs: 1000 });
      const launch = { launchId: 'L9', taskId: 'T1', attempt: 1, launchNo: 1, status: 'ended', token: 't', branch: 'b', worktree: dir, baseSha: 's', graphRev: 'r', createdAt: 1 } as Launch;
      expect(await runner.readUsage(launch)).toBeUndefined();
      writeFileSync(logPath(dir, 'L9'), `stderr line\n${JSON.stringify(result)}\n`);
      expect(await runner.readUsage(launch)).toEqual({ costUsd: 0.0123, turns: 3, durationMs: 4567, tokens: { input: 10, output: 20 }, source: 'claude-code' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const codexFixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/codex');
const fixture = (f: string) => readFileSync(path.join(codexFixtures, f), 'utf8');
const turn = (u: Record<string, number>) => JSON.stringify({ type: 'turn.completed', usage: u });

// See specs/worker-runners "Codex usage parsing".
describe('Codex usage parser', () => {
  const expected = { tokens: { input: 40361, cachedInput: 32128, cacheWriteInput: 0, output: 260, reasoningOutput: 0 }, source: 'codex' };

  it('sums turn.completed usage from a JSONL log with stderr lines interleaved', () => {
    const lines = fixture('git-events.jsonl').trimEnd().split('\n');
    const stderr = fixture('git-err.txt').trimEnd().split('\n');
    const log = lines.flatMap((l, i) => [l, stderr[i % stderr.length]!]).join('\n');
    const usage = parseCodexUsage(log);
    expect(usage).toEqual(expected);
    expect(usage).not.toHaveProperty('costUsd');
    expect(usage).not.toHaveProperty('durationMs');
    expect(usage).not.toHaveProperty('turns');
  });

  it('sums two turn.completed lines', () => {
    const log = ['{"type":"thread.started","thread_id":"t"}', turn({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }), 'progress on stderr', turn({ input_tokens: 50, cached_input_tokens: 0, cache_write_input_tokens: 5, output_tokens: 7, reasoning_output_tokens: 3 })].join('\n');
    expect(parseCodexUsage(log)).toEqual({ tokens: { input: 150, cachedInput: 40, cacheWriteInput: 5, output: 17, reasoningOutput: 3 }, source: 'codex' });
  });

  it('yields nothing for a log cut off before turn.completed, a failed turn, or a Claude log', () => {
    expect(parseCodexUsage(fixture('git-err.txt'))).toBeUndefined();
    expect(parseCodexUsage(fixture('C-events.jsonl'))).toBeUndefined();
    expect(parseCodexUsage(`stderr line\n${JSON.stringify(result)}\n`)).toBeUndefined();
    expect(parseCodexUsage('')).toBeUndefined();
    expect(parseCodexUsage('{"type":"turn.completed", broken')).toBeUndefined();
  });

  it('CodexRunner.readUsage reads the launch log', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-usage-'));
    try {
      const runner = new CodexRunner({ command: 'true', logDir: dir, retryWindowMs: 1000, maxWaitMs: 60_000, settings: () => ({ sandbox: 'workspace-write', ephemeral: true, ignoreUserConfig: true }) });
      const launch = { launchId: 'L9', taskId: 'T1', attempt: 1, launchNo: 1, status: 'ended', token: 't', branch: 'b', worktree: dir, baseSha: 's', graphRev: 'r', createdAt: 1, runner: 'codex' } as Launch;
      expect(await runner.readUsage(launch)).toBeUndefined();
      writeFileSync(logPath(dir, 'L9'), `${fixture('git-err.txt')}${fixture('git-events.jsonl')}`);
      expect(await runner.readUsage(launch)).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
