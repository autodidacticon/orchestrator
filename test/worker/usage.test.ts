/** The worker loop's usage helpers: the tail keeper and the post body. See specs/worker-pool "Usage post". */
import { describe, expect, it } from 'vitest';
import { TailKeeper, USAGE_TAIL_BYTES, usagePostBody } from '../../src/worker/usage.js';

const result = { type: 'result', subtype: 'success', is_error: false, duration_ms: 4567, num_turns: 3, result: 'done', total_cost_usd: 0.25, usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 7 } };
const line = (o: unknown) => `${JSON.stringify(o)}\n`;

describe('TailKeeper', () => {
  it('keeps the last 256 KiB of a stream fed in chunks, and a 300 KiB text that ends with the object still yields its usage', () => {
    const keeper = new TailKeeper();
    const filler = `${'x'.repeat(1023)}\n`;
    for (let i = 0; i < 300; i++) keeper.push(Buffer.from(filler));
    keeper.push(Buffer.from(line(result)));
    const text = keeper.text();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(USAGE_TAIL_BYTES);
    expect(Buffer.byteLength(text)).toBeGreaterThan(USAGE_TAIL_BYTES - 2048);
    expect(text.endsWith(line(result))).toBe(true);
    expect(usagePostBody(text, { workerId: 'w-1' })).toEqual({ workerId: 'w-1', usage: { tokens: { input: 140, cachedInput: 40, output: 7 }, costUsd: 0.25 } });
  });

  it('keeps a multi-byte character split across two chunks whole', () => {
    const keeper = new TailKeeper();
    const b = Buffer.from('é{}', 'utf8');
    keeper.push(b.subarray(0, 1));
    keeper.push(b.subarray(1));
    expect(keeper.text()).toBe('é{}');
  });

  it('keeps everything below the limit', () => {
    const keeper = new TailKeeper(10);
    keeper.push('abc');
    keeper.push('');
    keeper.push('def');
    expect(keeper.text()).toBe('abcdef');
    keeper.push('0123456789');
    expect(keeper.text()).toBe('0123456789');
  });
});

describe('usagePostBody', () => {
  it('posts the tokens, the claim model and the cost', () => {
    expect(usagePostBody(`noise\n${line(result)}`, { workerId: 'w-1', model: 'claude-opus-5-5' })).toEqual({
      workerId: 'w-1',
      usage: { tokens: { input: 140, cachedInput: 40, output: 7 }, model: 'claude-opus-5-5', costUsd: 0.25 },
    });
  });

  it('yields nothing for an object followed by another line', () => {
    expect(usagePostBody(`${line(result)}a line after the object\n`, { workerId: 'w-1' })).toBeUndefined();
  });

  it('leaves costUsd out for a total_cost_usd of 0, and for an object without one', () => {
    const body = usagePostBody(line({ ...result, total_cost_usd: 0 }), { workerId: 'w-1' });
    expect(body?.usage).toEqual({ tokens: { input: 140, cachedInput: 40, output: 7 } });
    expect(body?.usage).not.toHaveProperty('costUsd');
    const { total_cost_usd: _drop, ...noCost } = result;
    expect(usagePostBody(line(noCost), { workerId: 'w-1' })?.usage).not.toHaveProperty('costUsd');
  });

  it('yields no body for an object without usage, and for text without an object', () => {
    const { usage: _drop, ...noUsage } = result;
    expect(usagePostBody(line(noUsage), { workerId: 'w-1' })).toBeUndefined();
    expect(usagePostBody('just text\n', { workerId: 'w-1' })).toBeUndefined();
    expect(usagePostBody('', { workerId: 'w-1' })).toBeUndefined();
  });

  it('never posts turns, duration or the source', () => {
    const body = usagePostBody(line(result), { workerId: 'w-1' })!;
    expect(Object.keys(body.usage).sort()).toEqual(['costUsd', 'tokens']);
  });
});
