import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'deploy/smoke.sh');
const bash = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p)) ?? 'bash';

// Stubs that shadow every external tool and record any call, so the dry run provably contacts nothing.
const stubs = mkdtempSync(path.join(tmpdir(), 'orch-smoke-stubs-'));
const calls = path.join(stubs, 'calls');
for (const tool of ['docker', 'kind', 'kubectl', 'curl', 'jq']) {
  const p = path.join(stubs, tool);
  writeFileSync(p, `#!/bin/sh\necho ${tool} >> '${calls}'\nexit 1\n`);
  chmodSync(p, 0o755);
}
afterAll(() => rmSync(stubs, { recursive: true, force: true }));

function dryRun(env: Record<string, string> = {}) {
  return spawnSync(bash, [script, '--dry-run'], { encoding: 'utf8', env: { PATH: `${stubs}:/usr/bin:/bin`, ...env } });
}

describe('deploy/smoke.sh', () => {
  it('is executable in git, starts with set -euo pipefail, and parses', () => {
    expect(execFileSync('git', ['ls-files', '-s', 'deploy/smoke.sh'], { cwd: root, encoding: 'utf8' })).toMatch(/^100755 /);
    const lines = readFileSync(script, 'utf8').split('\n');
    expect(lines[0]).toMatch(/^#!.*bash/);
    expect(lines[1]).toBe('set -euo pipefail');
    expect(spawnSync(bash, ['-n', script]).status).toBe(0);
  });

  it('--dry-run prints the steps in order, executes nothing, and exits 0', () => {
    const r = dryRun();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const steps = r.stdout.split('\n').filter((l) => l.startsWith('+ '));
    const expected = [
      'docker build -t orchestrator:dev .',
      'kind load docker-image orchestrator:dev --name orch',
      'kubectl --context kind-orch apply -k deploy/overlays/kind',
      'kubectl --context kind-orch -n orch rollout status deployment/orchestrator',
      'kubectl --context kind-orch -n orch port-forward service/orchestrator',
      'curl -fsS -o /dev/null http://127.0.0.1:18080/healthz',
      'status_is .runner.mode == "pull" and (.claimable | length > 0)',
    ];
    const at = expected.map((e) => steps.findIndex((s) => s.includes(e)));
    expect(at.every((i) => i >= 0), `missing steps in:\n${steps.join('\n')}`).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(existsSync(calls)).toBe(false);
  });

  it('loads into and targets the cluster named by KIND_CLUSTER', () => {
    const out = dryRun({ KIND_CLUSTER: 'other' }).stdout;
    expect(out).toContain('+ kind load docker-image orchestrator:dev --name other');
    const kubectl = out.split('\n').filter((l) => l.startsWith('+ kubectl'));
    expect(kubectl.length).toBeGreaterThan(0);
    for (const l of kubectl) expect(l).toContain('--context kind-other');
  });

  it('rejects unknown arguments', () => {
    expect(spawnSync(bash, [script, '--nope'], { encoding: 'utf8' }).status).toBe(2);
  });
});
