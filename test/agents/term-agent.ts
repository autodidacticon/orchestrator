/**
 * Test agent for reaping shutdowns: `term-agent.ts <dir> <launchId>`. It writes its pid to `<dir>/<launchId>/pid`
 * and a marker `ready` beside it. On the first SIGTERM it writes `Date.now()` to `term`, and 100 ms later prints one
 * Claude Code result object (`total_cost_usd` 0.25) as one line on its standard output. It never exits on the
 * signal, and exits by itself after 60 seconds. See specs/operator-control "Shutdown: launches reaped together".
 */
import { appendFileSync, mkdirSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

const [dir, launchId] = process.argv.slice(2);
if (!dir || !launchId) {
  process.stderr.write('usage: term-agent.ts <dir> <launchId>\n');
  process.exit(2);
}
const own = path.join(dir, launchId);
mkdirSync(own, { recursive: true });
const pidlog = process.env['ORCH_PIDLOG'];
if (pidlog) appendFileSync(pidlog, `${process.pid} ${launchId} - start ${Date.now()}\n`);

let termed = false;
process.on('SIGTERM', () => {
  if (termed) return;
  termed = true;
  writeFileSync(path.join(own, 'term'), String(Date.now()));
  setTimeout(() => {
    const result = { type: 'result', subtype: 'success', is_error: false, duration_ms: 1000, num_turns: 1, result: 'terminated', total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 20 } };
    writeSync(1, `${JSON.stringify(result)}\n`);
  }, 100);
});

writeFileSync(path.join(own, 'pid'), String(process.pid));
writeFileSync(path.join(own, 'ready'), 'x');
setTimeout(() => process.exit(0), 60_000);
