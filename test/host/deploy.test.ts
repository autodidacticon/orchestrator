import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

it('the base has no volume claim file and no mounted graph', () => {
  expect(existsSync(path.join(root, 'deploy/base/pvc.yaml'))).toBe(false);
  expect(existsSync(path.join(root, 'deploy/base/graph.yaml'))).toBe(false);
});

describe.skipIf(!hasKubectl)('reference manifests', () => {
  const base = hasKubectl ? render('deploy/base') : [];
  const kind = hasKubectl ? render('deploy/overlays/kind') : [];

  it('base renders the namespace, config, Postgres cluster, daemon, and service, and no volume claim', () => {
    expect(kinds(base)).toEqual(['Cluster/postgres', 'ConfigMap/orchestrator-config', 'Deployment/orchestrator', 'Namespace/orch', 'Service/orchestrator']);
    for (const r of base) if (r.kind !== 'Namespace') expect(r.metadata.namespace).toBe('orch');
  });

  it('the ConfigMap holds orchestrator.yaml for a pull-mode, cluster-bound, never-idle daemon on Postgres, and no graph', () => {
    const cm = base.find((r) => r.kind === 'ConfigMap') as Resource;
    const cfg = parse(cm.data?.['orchestrator.yaml'] ?? '') as { runner: { mode: string }; daemon: { idleExitMs: number }; apiBind: string; apiPort: number; apiBaseUrl: string; graphPath?: string; store: { kind: string; url?: string; flushDeadlineMs: number }; git: { pushIntegration: boolean }; leaseTtlMs?: number };
    expect(cfg.runner.mode).toBe('pull');
    expect(cfg.daemon.idleExitMs).toBe(0);
    expect(cfg.apiBind).toBe('0.0.0.0');
    expect(cfg.apiPort).toBe(8080);
    // The advertised URL names the Service, so agents and clients in the cluster reach the daemon. See specs/cluster-runtime "Reference manifests".
    expect(cfg.apiBaseUrl).toBe('http://orchestrator.orch.svc:8080');
    expect(cfg.graphPath).toBeUndefined();
    expect(Object.keys(cm.data ?? {})).toEqual(['orchestrator.yaml']);
    // The URL comes from the mounted Secret file (store.urlFile), never from the ConfigMap itself; the default lease outlasts the deadline.
    expect(cfg.store).toEqual({ kind: 'postgres', urlFile: '/var/run/secrets/orchestrator/postgres/uri', flushDeadlineMs: 120000 });
    expect(cfg.leaseTtlMs ?? 600_000).toBeGreaterThanOrEqual(cfg.store.flushDeadlineMs);
    expect(cfg.git.pushIntegration).toBe(true);
  });

  it('the daemon is Recreate, clones REPO_URL into an emptyDir, reads the store URL from the mounted CloudNativePG Secret file, and runs orchestrator --repo on the clone', () => {
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
    expect(daemon.volumeMounts.map((m: { mountPath: string }) => m.mountPath).sort()).toEqual(['/data', '/data/repo/orchestrator.yaml', '/var/run/secrets/orchestrator/postgres']);
    const volumes = spec.template.spec.volumes as Array<Record<string, unknown>>;
    expect(volumes.find((v) => v['name'] === 'data')).toEqual({ name: 'data', emptyDir: {} });
    expect(volumes.some((v) => 'persistentVolumeClaim' in v)).toBe(false);
    // The Secret's uri key is a file at store.urlFile; the daemon's environment holds no URL, no password and no
    // libpq variable, and nothing in it is read from a Secret. See deploy/README.md "Store credentials".
    const mount = daemon.volumeMounts.find((m: { mountPath: string }) => m.mountPath === '/var/run/secrets/orchestrator/postgres');
    expect(mount.readOnly).toBe(true);
    expect(volumes.find((v) => v['name'] === mount.name)).toEqual({ name: mount.name, secret: { secretName: 'postgres-app', defaultMode: 0o440, items: [{ key: 'uri', path: 'uri' }] } });
    const names = (daemon.env as Array<{ name: string; valueFrom?: unknown }>).map((e) => e.name);
    for (const n of ['DATABASE_URL', 'DATABASE_URL_FILE']) expect(names).not.toContain(n);
    expect(names.filter((n) => n.startsWith('PG'))).toEqual([]);
    expect((daemon.env as Array<{ valueFrom?: unknown }>).some((e) => e.valueFrom !== undefined)).toBe(false);
    expect(daemon.envFrom).toBeUndefined();
    // No fixed run id: each deployment's id is the hash of its clone's origin. See deploy/README.md "The run id".
    expect(daemon.env.some((e: { name: string }) => e.name === 'ORCH_RUN_ID')).toBe(false);
    const cluster = find(base, 'Cluster', 'postgres');
    expect(cluster.spec.instances).toBe(1);
    expect(cluster.spec.bootstrap.initdb.database).toBeTruthy();
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

  it('the kind overlay keeps one ready task for the smoke script to send, and the daemon mounts the ConfigMap', () => {
    const cm = kind.find((r) => r.kind === 'ConfigMap' && r.metadata.name.startsWith('orchestrator-config')) as Resource;
    const graph = parse(readFileSync(path.join(root, 'deploy/overlays/kind/graph.yaml'), 'utf8')) as { nodes: Array<{ id: string; deps: string[] }> };
    expect(graph.nodes.filter((n) => n.deps.length === 0)).toHaveLength(1);
    expect(Object.keys(cm.data ?? {})).toEqual(['orchestrator.yaml']);
    const volumes = find(kind, 'Deployment', 'orchestrator').spec.template.spec.volumes;
    expect(volumes.find((v: { name: string }) => v.name === 'config').configMap.name).toBe(cm.metadata.name);
  });
});
