import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner, parseUsage } from '../../src/runner/claude-code.js';
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
