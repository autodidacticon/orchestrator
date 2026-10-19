// Probe harness for the bash-rule fixtures (ORC-68): `node probe-bash-rule.mjs <configs/X-name.json> <events/X-name.jsonl>`.
// Runs `opencode run` once in a fresh scratch git repo under the config's permission, asking the model to run the
// config's command verbatim, and writes the redacted JSONL to the events file. Evidence only; no test runs it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const [cfgPath, outPath] = process.argv.slice(2);
const { permission, command, files = {} } = JSON.parse(readFileSync(cfgPath, 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'oc-probe-'));
try {
  spawnSync('git', ['init', '-q'], { cwd: scratch });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(scratch, name), body);
  const prompt = `Use the bash tool exactly once to run this command verbatim, with no changes: ${command}\nThen reply DONE, or DENIED if the tool call was rejected.`;
  const r = spawnSync('opencode', ['run', '--format', 'json', '--pure', '--print-logs', '--log-level', 'WARN', '--dir', scratch, '-m', 'opencode/big-pickle', prompt], {
    cwd: scratch,
    env: { ...process.env, PWD: scratch, OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission, snapshots: false, share: 'disabled' }) },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 300_000,
  });
  const redact = (s) => s.split(scratch).join('<scratch>').split(homedir()).join('~');
  writeFileSync(outPath, redact(r.stdout));
  process.stderr.write(redact(r.stderr).split('\n').filter((l) => l && !l.includes('duplicate skill name')).join('\n'));
  console.log(`exit ${r.status}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
