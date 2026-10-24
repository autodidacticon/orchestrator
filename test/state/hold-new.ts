// Helper for the store's concurrent-open test (not a test file): create a new database file the
// way a first opener does, still in rollback-journal mode, and hold its exclusive lock for 1 s.
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [db, flag] = process.argv.slice(2) as [string, string];
const conn = new DatabaseSync(db);
conn.exec('BEGIN EXCLUSIVE');
conn.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
writeFileSync(flag, 'held');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
conn.exec('COMMIT');
conn.close();
