/**
 * The worker Deployment's termination settings: a grace period that covers the loop's hand-back on SIGTERM, and no
 * preStop hook (the container's command is orchestrator-worker itself, which handles the signal).
 * See specs/cluster-runtime "Worker Deployment" and specs/worker-pool "Pod termination".
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

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

describe.skipIf(!hasKubectl)('worker Deployment termination', () => {
  for (const dir of ['deploy/base', 'deploy/overlays/kind']) {
    it(`${dir} renders orchestrator-worker with terminationGracePeriodSeconds 120 and no lifecycle on its container`, () => {
      const worker = render(dir).find((r) => r.kind === 'Deployment' && r.metadata.name === 'orchestrator-worker');
      expect(worker).toBeDefined();
      const pod = worker!.spec.template.spec;
      expect(pod.terminationGracePeriodSeconds).toBe(120);
      expect(pod.containers).toHaveLength(1);
      expect(pod.containers[0].command).toEqual(['orchestrator-worker']);
      expect(pod.containers[0]).not.toHaveProperty('lifecycle');
    });
  }
});
