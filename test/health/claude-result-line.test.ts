import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseUsage } from '../../src/runner/claude-code.js';

// See specs/health-monitoring "Usage accounting": the Claude result object is found whatever it holds.
afterEach(() => {
  vi.restoreAllMocks();
});

const braces = '{'.repeat(5000);
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 98765,
  num_turns: 42,
  result: 'done',
  total_cost_usd: 11.21,
  usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 40 },
  permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: `echo '${braces}'` } }],
};
const expected = { costUsd: 11.21, turns: 42, durationMs: 98765, tokens: { input: 3100, cachedInput: 3000, cacheWriteInput: 40, output: 200 }, source: 'claude-code' };

describe('Claude result line', () => {
  it('reads a one-line result object holding more than 200 braces at the first try', () => {
    const line = JSON.stringify(result);
    expect(line.split('{').length - 1).toBeGreaterThan(200);
    const log = `[warn] stderr noise\n${JSON.stringify({ type: 'system', subtype: 'init' })}\n${line}\n`;
    const spy = vi.spyOn(JSON, 'parse');
    expect(parseUsage(log)).toEqual(expected);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reads the same object pretty-printed after a noise line', () => {
    expect(parseUsage(`noise\n${JSON.stringify(result, null, 2)}\n`)).toEqual(expected);
  });

  it('yields nothing for 300 lines of {} without usage', () => {
    expect(parseUsage(Array.from({ length: 300 }, () => '{}').join('\n') + '\n')).toBeUndefined();
  });

  it('yields nothing when a line of text follows the object', () => {
    expect(parseUsage(`${JSON.stringify(result)}\nlate stderr line\n`)).toBeUndefined();
  });
});
