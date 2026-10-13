import { describe, expect, it } from 'vitest';

// No static import of the store: the filter must be observed from before the load.
describe('sqlite warning filter', () => {
  it("restores the process's warning listeners after one turn", async () => {
    const before = process.listeners('warning');
    await import('../../src/state/sqlite.js');
    await new Promise((r) => setImmediate(r));
    const after = process.listeners('warning');
    expect(after).toHaveLength(before.length);
    after.forEach((l, i) => expect(l).toBe(before[i]));
  });
});
