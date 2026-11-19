import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_STORE_SCHEMA } from '../../src/state/pg/schema.js';

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

function dryRun(env: Record<string, string> = {}, args: string[] = []) {
  return spawnSync(bash, [script, '--dry-run', ...args], { encoding: 'utf8', env: { PATH: `${stubs}:/usr/bin:/bin`, ...env } });
}

const stepsOf = (out: string) => out.split('\n').filter((l) => l.startsWith('+ '));

// Each expected step must appear after the one before it (a step may repeat, so search on from the last match).
function expectInOrder(steps: string[], expected: string[]) {
  let from = 0;
  for (const e of expected) {
    const i = steps.findIndex((s, j) => j >= from && s.includes(e));
    expect(i, `"${e}" missing after step ${from} in:\n${steps.join('\n')}`).toBeGreaterThanOrEqual(0);
    from = i + 1;
  }
}

describe('deploy/smoke.sh', () => {
  it('is executable in git, starts with set -euo pipefail, and parses', () => {
    expect(execFileSync('git', ['ls-files', '-s', 'deploy/smoke.sh'], { cwd: root, encoding: 'utf8' })).toMatch(/^100755 /);
    const lines = readFileSync(script, 'utf8').split('\n');
    expect(lines[0]).toMatch(/^#!.*bash/);
    expect(lines[1]).toBe('set -euo pipefail');
    expect(spawnSync(bash, ['-n', script]).status).toBe(0);
  });

  it('the psql queries name the store schema', () => {
    const text = readFileSync(script, 'utf8');
    const want: Record<string, string> = { pg_launch_counts: 'launches', pg_claimable: 'launches', pg_claimable_tokens: 'launches', pg_states: 'overlay' };
    for (const [fn, table] of Object.entries(want)) {
      const line = text.split('\n').find((l) => l.startsWith(`${fn}() {`));
      expect(line, fn).toBeDefined();
      expect(line).toMatch(/psql_q "/);
      // Every table the query reads is qualified with the store's default schema.
      const read = [...line!.matchAll(/\bfrom\s+([\w."]+)/gi)].map((m) => m[1]);
      expect(read, fn).toEqual([`${DEFAULT_STORE_SCHEMA}.${table}`]);
    }
  });

  it('--dry-run prints the steps in order, executes nothing, and exits 0', () => {
    const r = dryRun();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const steps = stepsOf(r.stdout);
    expectInOrder(steps, [
      'docker build -t orchestrator:dev .',
      'kind load docker-image orchestrator:dev --name orch',
      'kubectl --context kind-orch apply --server-side -f https://raw.githubusercontent.com/cloudnative-pg/',
      'kubectl --context kind-orch -n cnpg-system rollout status deployment/cnpg-controller-manager',
      'kubectl --context kind-orch apply -k deploy/overlays/kind',
      'kubectl --context kind-orch -n orch wait --for=condition=Ready cluster/postgres',
      'kubectl --context kind-orch -n orch rollout status deployment/orchestrator',
      'kubectl --context kind-orch -n orch port-forward service/orchestrator',
      'curl -fsS -o /dev/null http://127.0.0.1:18080/healthz',
      'retry 30 put_graph',
      'status_is .runner.mode == "pull" and (.claimable | length > 0)',
      'daemon_mounts_no_claim',
      'kubectl --context kind-orch -n orch delete pod -l app.kubernetes.io/name=orchestrator',
      'kubectl --context kind-orch -n orch wait --for=condition=Ready pod -l app.kubernetes.io/name=orchestrator',
      'differs dry-run daemon_uid',
      'status_is .graphRev == "unknown" and (.claimable | length > 0)',
      'recovery_settled',
      'same  api_claimable',
      'same  pg_claimable_tokens',
      'reprepared_once_each',
      'daemon_mounts_no_claim',
      'freeze_postgres',
      'sample_outage',
      'note_write_pending',
      'thaw_postgres',
      'write_was_pending',
      'readyz_503_during_outage',
      'outage_write_completed',
      'delete_postgres_pod',
      'daemon_restarted_since',
      'ready_within_limit',
      'same dry-run daemon_uid',
      'same  api_claimable',
      'same  pg_claimable_tokens',
      'claim_returns_recorded_launch',
    ]);
    expect(steps.some((s) => s.includes('kind delete cluster') || s.includes('save_context'))).toBe(false);
    expect(existsSync(calls)).toBe(false);
  });

  it('--fresh saves the current context, recreates the cluster, and restores the context', () => {
    const r = dryRun({}, ['--fresh']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expectInOrder(stepsOf(r.stdout), ['save_context', 'kind delete cluster --name orch', 'kind create cluster --name orch', 'restore_context', 'docker build']);
    expect(existsSync(calls)).toBe(false);
  });

  it('--break pvc mounts the claim before the snapshot; --break claimable claims after it', () => {
    const pvc = stepsOf(dryRun({}, ['--break', 'pvc']).stdout);
    expectInOrder(pvc, ['retry 120 status_is .claimable | index("SMOKE-PARKED")', 'mount_break_claim', 'recovery_settled', 'same  pg_claimable', 'delete pod -l app.kubernetes.io/name=orchestrator']);
    const claimable = stepsOf(dryRun({}, ['--break', 'claimable']).stdout);
    expectInOrder(claimable, ['same  pg_claimable', '"taskId":"SMOKE-PARKED"', 'delete pod -l app.kubernetes.io/name=orchestrator']);
    expect(existsSync(calls)).toBe(false);
  });

  // Not a dry run: kind succeeds, kubectl logs its arguments, docker fails, so the script stops at the build.
  function freshWithContext(current: string | undefined) {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-smoke-ctx-'));
    const log = path.join(dir, 'log');
    const ctx = current === undefined ? 'exit 1' : `echo ${current}`;
    const tools: Record<string, string> = {
      kubectl: `echo "kubectl $*" >> '${log}'\nif [ "$1 $2" = "config current-context" ]; then ${ctx}; fi\nexit 0`,
      kind: `echo "kind $*" >> '${log}'\nexit 0`,
      docker: `echo "docker $*" >> '${log}'\nexit 1`,
    };
    for (const [tool, body] of Object.entries(tools)) {
      writeFileSync(path.join(dir, tool), `#!/bin/sh\n${body}\n`);
      chmodSync(path.join(dir, tool), 0o755);
    }
    try {
      const r = spawnSync(bash, [script, '--fresh'], { encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin`, LOCAL_PORT: '18999' } });
      return { status: r.status, calls: readFileSync(log, 'utf8').trim().split('\n') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('--fresh puts back the context that was current before kind create cluster', () => {
    const r = freshWithContext('prod');
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([
      'kubectl config current-context',
      'kind delete cluster --name orch',
      'kind create cluster --name orch',
      'kubectl config use-context prod',
      'docker build -t orchestrator:dev .',
    ]);
  });

  it('--fresh unsets the context kind made current when none was current before', () => {
    const r = freshWithContext(undefined);
    expect(r.calls).toEqual([
      'kubectl config current-context',
      'kind delete cluster --name orch',
      'kind create cluster --name orch',
      'kubectl config unset current-context',
      'docker build -t orchestrator:dev .',
    ]);
  });

  it('refuses a KUBE_CONTEXT that does not name the kind cluster', () => {
    const r = dryRun({ KIND_CLUSTER: 'dev', KUBE_CONTEXT: 'kind-orch' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('KUBE_CONTEXT=kind-orch');
    expect(r.stderr).toContain('KIND_CLUSTER=dev');
    expect(stepsOf(r.stdout)).toEqual([]);
    expect(dryRun({ KIND_CLUSTER: 'dev', KUBE_CONTEXT: 'kind-dev' }).status).toBe(0);
  });

  it('loads into and targets the cluster named by KIND_CLUSTER', () => {
    const out = dryRun({ KIND_CLUSTER: 'other' }).stdout;
    expect(out).toContain('+ kind load docker-image orchestrator:dev --name other');
    const kubectl = out.split('\n').filter((l) => l.startsWith('+ kubectl'));
    expect(kubectl.length).toBeGreaterThan(0);
    for (const l of kubectl) expect(l).toContain('--context kind-other');
  });

  it('rejects unknown arguments and unknown --break values', () => {
    for (const args of [['--nope'], ['--break', 'nothing'], ['--break']]) {
      const r = spawnSync(bash, [script, ...args], { encoding: 'utf8' });
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toContain('usage:');
    }
  });

  // --- M4 (ORC-31) ---

  const M4_A = [
    'M4: the Claude worker image runs the claude CLI',
    'M4: deleting the worker pod mid-task releases its launch with kept true',
    'M4: usage printed by the terminated agent is recorded',
  ];
  const M4_B = 'M4: every integration commit carries its Orchestrator-Launch trailer';
  const REAL = ['M4: the real task is done', "M4: the real task's launch cost is above zero", "M4: the real task's commit carries its Orchestrator-Launch trailer"];
  const M3 = ['M3: the run is finished', "M3: every smoke task is on origin's integration branch", 'M3: worker logs show one accepted report per task'];
  const lines = (out: string) => out.split('\n');

  it('--dry-run lists M4 block A between the final claim and the M3 scale-up, then block B and the real-agent skips after M3', () => {
    const r = dryRun();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const out = lines(r.stdout);
    const at = (pred: (l: string) => boolean, label: string) => {
      const i = out.findIndex(pred);
      expect(i, label).toBeGreaterThanOrEqual(0);
      return i;
    };
    const final = at((l) => l === 'smoke: skip: final: a claim of SMOKE-PARKED returns the recorded launch id and token (dry run: nothing is executed)', 'final');
    const build = at((l) => l === '+ docker build -f deploy/worker-claude/Dockerfile --build-arg PROJECT_BASE=orchestrator:dev -t orchestrator-worker-claude:dev deploy/worker-claude', 'worker image build');
    const load = at((l) => l === '+ kind load docker-image orchestrator-worker-claude:dev --name orch', 'worker image load');
    const a = M4_A.map((n) => at((l) => l === `smoke: skip: ${n} (dry run: nothing is executed)`, n));
    const scale = at((l) => l.startsWith('+ kubectl --context kind-orch -n orch scale deployment/orchestrator-worker --replicas=2'), 'M3 scale-up');
    const m3 = M3.map((n) => at((l) => l === `smoke: skip: ${n} (dry run: nothing is executed)`, n));
    const b = at((l) => l === `smoke: skip: ${M4_B} (dry run: nothing is executed)`, M4_B);
    const real = REAL.map((n) => at((l) => l === `smoke: skip: ${n} (needs --real-agent)`, n));
    const order = [final, build, load, ...a, scale, ...m3, b, ...real];
    expect(order).toEqual([...order].sort((x, y) => x - y));
    // The termination step: the stand-in agent's pod is started, awaited, and deleted before its two assertions.
    expectInOrder(stepsOf(r.stdout), ['worker_image_runs_claude', 'term_precondition', 'start_term_pod', 'term_agent_ready', 'delete_term_pod', 'term_released_kept', 'task_cost_above_zero SMOKE-M3-A', 'status_is .claimable | index("SMOKE-M3-A")', 'scale deployment/orchestrator-worker --replicas=2']);
    // Without --real-agent the real-agent step lists no command, and the real-agent names have only their skip line.
    for (const n of REAL) expect(out.filter((l) => l.includes(n))).toEqual([`smoke: skip: ${n} (needs --real-agent)`]);
    expect(r.stdout).not.toContain('create_key_secret');
    expect(r.stdout).not.toContain('kind-claude');
    expect(existsSync(calls)).toBe(false);
  });

  it('--dry-run --real-agent <file> lists the real-agent step in order, reads no key, and calls no tool', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-smoke-key-'));
    const key = path.join(dir, 'key');
    const secret = 'sk-ant-smoke-test-not-a-key-7f3c';
    writeFileSync(key, `${secret}\n`);
    try {
      const r = dryRun({}, ['--real-agent', key]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain(secret);
      expect(r.stderr).not.toContain(secret);
      const steps = stepsOf(r.stdout);
      expectInOrder(steps, [
        'trailers_name_reported_launches',
        `create_key_secret ${key}`,
        'kubectl --context kind-orch -n orch scale deployment/orchestrator-worker --replicas=0',
        'no_worker_pods',
        'kubectl --context kind-orch apply -k deploy/overlays/kind-claude',
        'put_graph_with deploy/overlays/kind-claude/real-task.yaml',
        'status_is .claimable | index("SMOKE-REAL")',
        'kubectl --context kind-orch -n orch scale deployment/orchestrator-worker --replicas=1',
        'status_is .byStatus.done | index("SMOKE-REAL")',
        'task_cost_above_zero SMOKE-REAL',
        'trailers_name_reported_launches SMOKE-REAL',
      ]);
      const out = lines(r.stdout);
      const idx = REAL.map((n) => out.indexOf(`smoke: skip: ${n} (dry run: nothing is executed)`));
      for (const i of idx) expect(i).toBeGreaterThan(out.findIndex((l) => l.includes('--replicas=1')));
      expect(idx).toEqual([...idx].sort((x, y) => x - y));
      expect(r.stdout).not.toContain('(needs --real-agent)');
      expect(out.at(-2)).toBe('smoke: dry run, nothing executed');
      expect(existsSync(calls)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses --real-agent without a value, with a missing file, with a file in the repository, or a symbolic link, before any tool', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-smoke-key-'));
    const target = path.join(dir, 'key');
    writeFileSync(target, 'not-a-key\n');
    const link = path.join(dir, 'link');
    execFileSync('ln', ['-s', target, link]);
    try {
      // package.json is tracked, so this case leaves nothing behind in the repository.
      for (const args of [['--real-agent'], ['--real-agent', path.join(dir, 'missing')], ['--real-agent', path.join(root, 'package.json')], ['--real-agent', 'package.json'], ['--real-agent', link]]) {
        const r = spawnSync(bash, [script, ...args], { cwd: root, encoding: 'utf8', env: { PATH: `${stubs}:/usr/bin:/bin`, LOCAL_PORT: '18999' } });
        expect(r.status, args.join(' ')).toBe(2);
        expect(r.stderr.trimEnd().split('\n'), args.join(' ')).toHaveLength(1);
        expect(r.stderr).not.toContain('usage:');
        expect(r.stdout).toBe('');
        expect(r.stderr).not.toContain('not-a-key');
      }
      expect(existsSync(calls)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unknown argument still exits 2 with a usage line that names --real-agent', () => {
    const r = spawnSync(bash, [script, '--nope'], { encoding: 'utf8', env: { PATH: `${stubs}:/usr/bin:/bin` } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^usage: .*--real-agent <key file>/);
    expect(existsSync(calls)).toBe(false);
  });
});
