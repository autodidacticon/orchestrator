import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hasKubectl = spawnSync('kubectl', ['version', '--client'], { stdio: 'ignore' }).status === 0;

interface Resource {
  kind: string;
  metadata: { name: string; namespace?: string };
  data?: Record<string, string>;
  /** Rendered manifests are checked field by field. */
  spec?: any;
}

/** `kubectl kustomize <dir>`: renders locally, never contacts a cluster. */
function render(dir: string): Resource[] {
  const out = execFileSync('kubectl', ['kustomize', path.join(root, dir)], { encoding: 'utf8' });
  return parseAllDocuments(out).map((d) => d.toJS() as Resource);
}

const kinds = (rs: Resource[]) => rs.map((r) => `${r.kind}/${r.metadata.name.replace(/-[a-z0-9]{10}$/, '')}`).sort();
const find = (rs: Resource[], kind: string, name: string) => rs.find((r) => r.kind === kind && r.metadata.name === name) as Resource;
const env = (c: { env?: Array<{ name: string; value?: string }> }, name: string) => c.env?.find((e) => e.name === name)?.value;

describe.skipIf(!hasKubectl)('reference manifests', () => {
  const base = hasKubectl ? render('deploy/base') : [];
  const kind = hasKubectl ? render('deploy/overlays/kind') : [];

  it('base renders the namespace, config, volume, daemon, and service', () => {
    expect(kinds(base)).toEqual(['ConfigMap/orchestrator-config', 'Deployment/orchestrator', 'Namespace/orch', 'PersistentVolumeClaim/orchestrator-data', 'Service/orchestrator']);
    for (const r of base) if (r.kind !== 'Namespace') expect(r.metadata.namespace).toBe('orch');
  });

  it('the ConfigMap holds orchestrator.yaml for a pull-mode, cluster-bound, never-idle daemon and a graph.yaml', () => {
    const cm = base.find((r) => r.kind === 'ConfigMap') as Resource;
    const cfg = parse(cm.data?.['orchestrator.yaml'] ?? '') as { runner: { mode: string }; daemon: { idleExitMs: number }; apiBind: string; apiPort: number; apiBaseUrl: string; graphPath: string };
    expect(cfg.runner.mode).toBe('pull');
    expect(cfg.daemon.idleExitMs).toBe(0);
    expect(cfg.apiBind).toBe('0.0.0.0');
    expect(cfg.apiPort).toBe(8080);
    // The advertised URL names the Service, so agents and clients in the cluster reach the daemon. See specs/cluster-runtime "Reference manifests".
    expect(cfg.apiBaseUrl).toBe('http://orchestrator.orch.svc:8080');
    expect(cfg.graphPath).toBe('graph.yaml');
    expect(parse(cm.data?.['graph.yaml'] ?? '')).toHaveProperty('nodes');
  });

  it('the daemon is Recreate, clones REPO_URL in an init container, and runs orchestrator --repo on the clone', () => {
    const spec = find(base, 'Deployment', 'orchestrator').spec;
    expect(spec.strategy.type).toBe('Recreate');
    const [init] = spec.template.spec.initContainers;
    expect(env(init, 'REPO_URL')).toBeTruthy();
    expect(init.command.join(' ')).toContain('git clone "$REPO_URL" /data/repo');
    const [daemon] = spec.template.spec.containers;
    expect(daemon.image).toBe('orchestrator:dev');
    expect(init.image).toBe('orchestrator:dev');
    expect(daemon.command).toEqual(['orchestrator', '--repo', '/data/repo']);
    expect(env(daemon, 'ORCH_LOG_FORMAT')).toBe('json');
    expect(daemon.livenessProbe.httpGet.path).toBe('/healthz');
    expect(daemon.readinessProbe.httpGet.path).toBe('/readyz');
    expect(daemon.volumeMounts.map((m: { mountPath: string }) => m.mountPath)).toEqual(expect.arrayContaining(['/data', '/data/repo/orchestrator.yaml', '/data/repo/graph.yaml']));
    expect(spec.template.spec.volumes.find((v: { name: string }) => v.name === 'data').persistentVolumeClaim.claimName).toBe('orchestrator-data');
  });

  it('the Service is ClusterIP on 8080', () => {
    const svc = find(base, 'Service', 'orchestrator').spec;
    expect(svc.type).toBe('ClusterIP');
    expect(svc.ports[0].port).toBe(8080);
  });

  it('the kind overlay adds git-origin and points REPO_URL at it', () => {
    expect(kinds(kind)).toEqual(
      [...kinds(base), 'ConfigMap/git-origin-fixture', 'Deployment/git-origin', 'PersistentVolumeClaim/git-origin-data', 'Service/git-origin'].sort(),
    );
    const origin = find(kind, 'Deployment', 'git-origin').spec.template.spec;
    expect(origin.containers[0].command).toEqual(expect.arrayContaining(['git', 'daemon', '--enable=receive-pack', '--base-path=/srv/git']));
    const fixture = kind.find((r) => r.kind === 'ConfigMap' && r.metadata.name.startsWith('git-origin-fixture')) as Resource;
    expect(Object.keys(fixture.data ?? {})).toEqual(expect.arrayContaining(['README.md', 'package.json']));
    expect(find(kind, 'Service', 'git-origin').spec.ports[0].port).toBe(9418);
    const init = find(kind, 'Deployment', 'orchestrator').spec.template.spec.initContainers[0];
    expect(env(init, 'REPO_URL')).toBe('git://git-origin.orch.svc:9418/fixture.git');
  });

  it('the kind overlay replaces the empty graph with one ready task, and the daemon mounts the merged ConfigMap', () => {
    const cm = kind.find((r) => r.kind === 'ConfigMap' && r.metadata.name.startsWith('orchestrator-config')) as Resource;
    const graph = parse(cm.data?.['graph.yaml'] ?? '') as { nodes: Array<{ id: string; deps: string[] }> };
    expect(graph.nodes.filter((n) => n.deps.length === 0)).toHaveLength(1);
    expect(cm.data).toHaveProperty('orchestrator.yaml');
    const volumes = find(kind, 'Deployment', 'orchestrator').spec.template.spec.volumes;
    expect(volumes.find((v: { name: string }) => v.name === 'config').configMap.name).toBe(cm.metadata.name);
  });
});
