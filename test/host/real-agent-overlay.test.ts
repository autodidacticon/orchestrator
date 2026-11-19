/**
 * The kind overlay for Claude workers (deploy/overlays/kind-claude) and the real-agent task deploy/smoke.sh sends with
 * --real-agent. See specs/cluster-runtime "Kind overlay for the Claude worker".
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { SlotValidator } from '../../src/brief/template.js';
import { parseGraph } from '../../src/graph/load.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hasKubectl = spawnSync('kubectl', ['version', '--client'], { stdio: 'ignore' }).status === 0;

interface Resource {
  kind: string;
  metadata: { name: string };
  spec?: any;
}

/** `kubectl kustomize <dir>`: renders locally, never contacts a cluster. */
function render(dir: string): Resource[] {
  const out = execFileSync('kubectl', ['kustomize', path.join(root, dir)], { encoding: 'utf8' });
  return parseAllDocuments(out).map((d) => d.toJS() as Resource);
}
const key = (r: Resource) => `${r.kind}/${r.metadata.name}`;

describe.skipIf(!hasKubectl)('deploy/overlays/kind-claude', () => {
  const kind = hasKubectl ? render('deploy/overlays/kind') : [];
  const claude = hasKubectl ? render('deploy/overlays/kind-claude') : [];

  it('runs orchestrator-worker from the Claude worker image with the command agent and the key from the Secret', () => {
    const worker = claude.find((r) => key(r) === 'Deployment/orchestrator-worker')!;
    expect(worker).toBeDefined();
    expect(worker.spec.replicas).toBe(0);
    const containers = worker.spec.template.spec.containers as Array<{ name: string; image: string; env: Array<{ name: string; value?: string; valueFrom?: any }> }>;
    expect(containers).toHaveLength(1);
    const c = containers[0]!;
    expect(c.image).toBe('orchestrator-worker-claude:dev');
    const env = (name: string) => c.env.filter((e) => e.name === name);
    expect(env('ORCH_WORKER_AGENT')).toEqual([{ name: 'ORCH_WORKER_AGENT', value: 'command' }]);
    expect(env('ORCH_WORKER_COMMAND')).toEqual([]);
    expect(env('ANTHROPIC_API_KEY')).toEqual([{ name: 'ANTHROPIC_API_KEY', valueFrom: { secretKeyRef: { name: 'anthropic-api-key', key: 'ANTHROPIC_API_KEY' } } }]);
    expect(env('ANTHROPIC_API_KEY')[0]).not.toHaveProperty('value');
  });

  it('renders no Secret, and every other resource equals the kind overlay', () => {
    expect(claude.filter((r) => r.kind === 'Secret')).toEqual([]);
    expect(claude.map(key).sort()).toEqual(kind.map(key).sort());
    for (const r of claude) {
      if (key(r) === 'Deployment/orchestrator-worker') continue;
      expect(r, key(r)).toEqual(kind.find((k) => key(k) === key(r)));
    }
    // The worker differs only in its image and its env.
    const strip = (r: Resource) => {
      const copy = structuredClone(r);
      for (const c of copy.spec.template.spec.containers) {
        delete c.image;
        delete c.env;
      }
      return copy;
    };
    const workerOf = (rs: Resource[]) => rs.find((r) => key(r) === 'Deployment/orchestrator-worker')!;
    expect(strip(workerOf(claude))).toEqual(strip(workerOf(kind)));
  });
});

describe('deploy/overlays/kind-claude/real-task.yaml', () => {
  const graphText = readFileSync(path.join(root, 'deploy/overlays/kind/graph.yaml'), 'utf8');
  const fragment = readFileSync(path.join(root, 'deploy/overlays/kind-claude/real-task.yaml'), 'utf8');

  it('after graph.yaml parses as one graph whose only new node is SMOKE-REAL, which the brief validator accepts', () => {
    const before = parseGraph(graphText);
    const after = parseGraph(graphText + fragment);
    const added = [...after.nodes.keys()].filter((id) => !before.nodes.has(id));
    expect(added).toEqual(['SMOKE-REAL']);
    for (const [id, node] of before.nodes) expect(after.nodes.get(id), id).toEqual(node);
    const real = after.nodes.get('SMOKE-REAL')!;
    expect(real.kind).toBe('task');
    expect(real.deps).toEqual(['SMOKE']);
    expect(typeof real.payload['description']).toBe('string');
    expect((real.payload['description'] as string).trim()).not.toBe('');
    expect(real.payload['acceptanceCriteria']).toHaveLength(1);
    expect(real.payload).not.toHaveProperty('model');
    expect(real.payload).not.toHaveProperty('effort');
    expect(new SlotValidator().validate(real, real.payload as Record<string, unknown>)).toEqual({ ok: true });
  });

  it('is a fragment, not a graph of its own', () => {
    expect(fragment).not.toMatch(/^nodes:/m);
    expect(graphText.endsWith('\n')).toBe(true);
  });
});
