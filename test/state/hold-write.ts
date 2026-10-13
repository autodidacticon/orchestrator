// Helper for the store's cross-process test (not a test file): hold a write
// transaction open for 1.5 s, then prove other warnings still print and the
// process's warning listeners were restored.
import { writeFileSync } from 'node:fs';

const snapshot = process.listeners('warning');
const { SqliteStore } = await import('../../src/state/sqlite.js');
const [db, flag] = process.argv.slice(2) as [string, string];
const store = new SqliteStore(db);
store.transaction(() => {
  store.setKv('held', 'child');
  writeFileSync(flag, 'held');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
});
store.close();
process.emitWarning('probe');
await new Promise((r) => setImmediate(r));
const now = process.listeners('warning');
const restored = now.length === snapshot.length && now.every((l, i) => l === snapshot[i]);
process.stdout.write(`${JSON.stringify({ restored })}\n`);
