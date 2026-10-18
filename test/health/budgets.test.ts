import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config.js';
import { priceUsage } from '../../src/health/budgets.js';

// See specs/health-monitoring "Run cost budget": the pricing formula.
describe('priceUsage', () => {
  const price = { inputPerMTok: 2, outputPerMTok: 10 };

  it('prices input and output per million tokens', () => {
    expect(priceUsage({ input: 1_000_000, output: 1_000_000 }, price)).toBe(12);
    expect(priceUsage({ input: 40361, output: 260 }, price)).toBe(0.083322);
    expect(priceUsage({ input: 0, output: 0 }, price)).toBe(0);
  });

  it('bills input minus cached input at the input rate and cached input at its own rate, falling back to the input rate', () => {
    // (40361 - 32128) * 2 + 32128 * 0.5 = 16466 + 16064 = 32530 per 1e6
    expect(priceUsage({ input: 40361, cachedInput: 32128, output: 0 }, { ...price, cachedInputPerMTok: 0.5 })).toBe(0.03253);
    expect(priceUsage({ input: 40361, cachedInput: 32128, output: 0 }, price)).toBe(0.080722);
  });

  it('bills cache writes at their own rate, falling back to the input rate', () => {
    expect(priceUsage({ input: 0, cacheWriteInput: 1_000_000, output: 0 }, { ...price, cacheWriteInputPerMTok: 2.5 })).toBe(2.5);
    expect(priceUsage({ input: 0, cacheWriteInput: 1_000_000, output: 0 }, price)).toBe(2);
  });

  it('bills reasoning output on top of output at its own rate, falling back to the output rate', () => {
    expect(priceUsage({ input: 0, output: 1000, reasoningOutput: 500 }, { ...price, reasoningOutputPerMTok: 4 })).toBe(0.012);
    expect(priceUsage({ input: 0, output: 1000, reasoningOutput: 500 }, price)).toBe(0.015);
  });

  it('rounds to 1e-6', () => {
    expect(priceUsage({ input: 1, output: 0 }, { inputPerMTok: 0.3, outputPerMTok: 0 })).toBe(0);
    expect(priceUsage({ input: 7, output: 0 }, { inputPerMTok: 0.3, outputPerMTok: 0 })).toBe(0.000002);
    expect(priceUsage({ input: 3, output: 1 }, { inputPerMTok: 1 / 3, outputPerMTok: 1 })).toBe(0.000002);
  });
});

describe('budgets.prices', () => {
  it('defaults to an empty table', () => {
    expect(configSchema.parse({}).budgets.prices).toEqual({});
    expect(configSchema.parse({ budgets: { prices: { 'gpt-6-astra': { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 } } } }).budgets.prices).toEqual({ 'gpt-6-astra': { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 } });
  });

  it('rejects a negative rate, a missing required rate, an unknown rate, and an unsafe model key', () => {
    expect(() => configSchema.parse({ budgets: { prices: { 'gpt-6-astra': { inputPerMTok: -1, outputPerMTok: 10 } } } })).toThrow();
    expect(() => configSchema.parse({ budgets: { prices: { 'gpt-6-astra': { inputPerMTok: 1, outputPerMTok: 10, reasoningOutputPerMTok: -0.1 } } } })).toThrow();
    expect(() => configSchema.parse({ budgets: { prices: { 'gpt-6-astra': { inputPerMTok: 1 } } } })).toThrow();
    expect(() => configSchema.parse({ budgets: { prices: { 'gpt-6-astra': { inputPerMTok: 1, outputPerMTok: 1, perCall: 1 } } } })).toThrow();
    for (const key of ['bad model', '-flag', '$(rm -rf)', '__proto__x', '']) {
      expect(() => configSchema.parse({ budgets: { prices: { [key]: { inputPerMTok: 1, outputPerMTok: 1 } } } }), key).toThrow();
    }
  });
});
