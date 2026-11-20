import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';
import { SlotValidator } from '../../src/brief/template.js';
import { leaseCoversFlushDeadline } from '../../src/config.js';
import { parseGraph } from '../../src/graph/load.js';

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

  it('base renders the namespace, config, Postgres cluster, daemon, service, worker and verifier Deployments, and no volume claim', () => {
    expect(kinds(base)).toEqual(['Cluster/postgres', 'ConfigMap/orchestrator-config', 'Deployment/orchestrator', 'Deployment/orchestrator-verifier', 'Deployment/orchestrator-worker', 'Namespace/orch', 'Service/orchestrator']);
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
    // The URL comes from the mounted Secret file (store.urlFile), never from the ConfigMap itself; the default lease leaves the startup margin above the deadline (a deadline of 300000 with the default lease would fail).
    expect(cfg.store).toEqual({ kind: 'postgres', urlFile: '/var/run/secrets/orchestrator/postgres/uri', flushDeadlineMs: 120000 });
    expect(leaseCoversFlushDeadline(cfg.leaseTtlMs ?? 600_000, cfg.store.flushDeadlineMs)).toBe(true);
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

  // See specs/cluster-runtime "Worker Deployment".
  for (const [label, rs] of [['base', base], ['kind overlay', kind]] as const) {
    it(`the ${label} renders orchestrator-worker: replicas 0, POD_NAME from the Downward API, an emptyDir clone cache, ORCH_API at the daemon Service`, () => {
      const spec = find(rs, 'Deployment', 'orchestrator-worker').spec;
      expect(spec.replicas).toBe(0);
      const pod = spec.template.spec;
      // Its own label: the daemon's selectors (the Service, deploy/smoke.sh's pod lookups) never match a worker pod.
      expect(spec.template.metadata.labels['app.kubernetes.io/name']).toBe('orchestrator-worker');
      expect(spec.selector.matchLabels['app.kubernetes.io/name']).toBe('orchestrator-worker');
      const [worker] = pod.containers;
      expect(pod.containers).toHaveLength(1);
      expect(worker.image).toBe('orchestrator:dev');
      expect(worker.command).toEqual(['orchestrator-worker']);
      const podName = (worker.env as Array<{ name: string; valueFrom?: { fieldRef?: { fieldPath: string } } }>).find((e) => e.name === 'POD_NAME');
      expect(podName?.valueFrom?.fieldRef?.fieldPath).toBe('metadata.name');
      const svc = find(rs, 'Service', 'orchestrator');
      const port = svc.spec.ports[0].port;
      expect(env(worker, 'ORCH_API')).toBe(`http://${svc.metadata.name}.${svc.metadata.namespace}.svc:${port}`);
      expect(env(worker, 'ORCH_API')).toBe('http://orchestrator.orch.svc:8080');
      // The clone cache is the loop's ORCH_WORKER_CACHE (default /var/cache/orchestrator), on an emptyDir.
      const cache = env(worker, 'ORCH_WORKER_CACHE') ?? '/var/cache/orchestrator';
      const mount = worker.volumeMounts.find((m: { mountPath: string }) => m.mountPath === cache);
      expect(mount).toBeDefined();
      expect(pod.volumes.find((v: { name: string }) => v.name === mount.name)).toEqual({ name: mount.name, emptyDir: {} });
      expect(pod.volumes.some((v: Record<string, unknown>) => 'persistentVolumeClaim' in v)).toBe(false);
      // The base names no agent; the kind overlay runs the scripted one.
      expect(env(worker, 'ORCH_WORKER_AGENT')).toBe(label === 'base' ? undefined : 'scripted');
    });
  }

  // See specs/cluster-runtime "Verifier Deployment".
  for (const [label, rs] of [['base', base], ['kind overlay', kind]] as const) {
    it(`the ${label} renders orchestrator-verifier: its own label, uid/gid/fsGroup 1000, one container on orchestrator:dev, POD_NAME, ORCH_API at the daemon Service, an emptyDir cache, no Secret and no database variable`, () => {
      const spec = find(rs, 'Deployment', 'orchestrator-verifier').spec;
      // The base keeps it at 0 (verifier.mode local checks in the daemon's container); the kind overlay runs one.
      expect(spec.replicas).toBe(label === 'base' ? 0 : 1);
      expect(spec.template.metadata.labels['app.kubernetes.io/name']).toBe('orchestrator-verifier');
      expect(spec.selector.matchLabels['app.kubernetes.io/name']).toBe('orchestrator-verifier');
      const pod = spec.template.spec;
      expect(pod.securityContext).toEqual({ runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 });
      expect(pod.containers).toHaveLength(1);
      const [verifier] = pod.containers;
      expect(verifier.name).toBe('verifier');
      expect(verifier.image).toBe('orchestrator:dev');
      expect(verifier.command).toEqual(['orchestrator-verifier']);
      const vars = verifier.env as Array<{ name: string; value?: string; valueFrom?: { fieldRef?: { fieldPath: string }; secretKeyRef?: unknown } }>;
      expect(vars.find((e) => e.name === 'POD_NAME')?.valueFrom?.fieldRef?.fieldPath).toBe('metadata.name');
      const svc = find(rs, 'Service', 'orchestrator');
      expect(env(verifier, 'ORCH_API')).toBe(`http://${svc.metadata.name}.${svc.metadata.namespace}.svc:${svc.spec.ports[0].port}`);
      expect(env(verifier, 'ORCH_VERIFIER_CACHE')).toBe('/var/cache/orchestrator');
      const mount = verifier.volumeMounts.find((m: { mountPath: string }) => m.mountPath === env(verifier, 'ORCH_VERIFIER_CACHE'));
      expect(mount).toBeDefined();
      expect(pod.volumes.find((v: { name: string }) => v.name === mount.name)).toEqual({ name: mount.name, emptyDir: {} });
      expect(env(verifier, 'ORCH_VERIFIER_BACKOFF_MAX_MS')).toBe(label === 'base' ? undefined : '2000');
      // No Secret, no claim, no store: the verifier reaches the daemon's API only.
      for (const v of pod.volumes as Array<Record<string, unknown>>) {
        expect(v).not.toHaveProperty('secret');
        expect(v).not.toHaveProperty('persistentVolumeClaim');
        expect(v).not.toHaveProperty('ephemeral');
      }
      expect(verifier.envFrom).toBeUndefined();
      expect(vars.some((e) => e.valueFrom?.secretKeyRef !== undefined)).toBe(false);
      const names = vars.map((e) => e.name);
      for (const n of ['DATABASE_URL', 'DATABASE_URL_FILE']) expect(names).not.toContain(n);
      expect(names.filter((n) => n.startsWith('PG'))).toEqual([]);
    });
  }

  it('the kind overlay replaces orchestrator.yaml with a remote run: the base keys plus runner.access remote, git.workerOriginUrl at git-origin, verifier.mode remote, and capacity 3', () => {
    const cfgOf = (rs: Resource[]) => parse((rs.find((r) => r.kind === 'ConfigMap' && r.metadata.name.startsWith('orchestrator-config')) as Resource).data?.['orchestrator.yaml'] ?? '') as Record<string, any>;
    const baseCfg = cfgOf(base);
    const kindCfg = cfgOf(kind);
    expect(baseCfg.runner.access).toBeUndefined();
    expect(kindCfg.runner.access).toBe('remote');
    expect(kindCfg.git.workerOriginUrl).toBe('git://git-origin.orch.svc:9418/fixture.git');
    expect(kindCfg.git.workerOriginUrl).toBe(env(find(kind, 'Deployment', 'orchestrator').spec.template.spec.initContainers[0], 'REPO_URL'));
    // Everything else is the base file: kustomize replaces the file whole, so the overlay repeats each base key.
    // capacity 3 parks all three dependants of SMOKE before the drill snapshot.
    expect(kindCfg.capacity).toBe(3);
    // Remote verification in the overlay only: the base keeps verifier.mode local, the default.
    expect(kindCfg.verifier).toEqual({ mode: 'remote' });
    expect(baseCfg.verifier).toBeUndefined();
    const strip = (c: Record<string, any>) => ({ ...c, capacity: undefined, verifier: undefined, runner: { ...c.runner, access: undefined }, git: { ...c.git, workerOriginUrl: undefined } });
    expect(JSON.parse(JSON.stringify(strip(kindCfg)))).toEqual(JSON.parse(JSON.stringify(strip(baseCfg))));
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

// See specs/cluster-runtime "Smoke M5 step: fixture check and fragment". No kubectl needed.
describe('deploy/overlays/kind/graph-m5.yaml', () => {
  const graphText = readFileSync(path.join(root, 'deploy/overlays/kind/graph.yaml'), 'utf8');
  const fragment = readFileSync(path.join(root, 'deploy/overlays/kind/graph-m5.yaml'), 'utf8');
  const real = readFileSync(path.join(root, 'deploy/overlays/kind-claude/real-task.yaml'), 'utf8');

  it('after graph.yaml adds exactly SMOKE-M5-PASS and SMOKE-M5-BREAK, tasks on SMOKE that the brief validator accepts, and leaves every node as it was', () => {
    const before = parseGraph(graphText);
    const after = parseGraph(graphText + fragment);
    expect([...after.nodes.keys()].filter((id) => !before.nodes.has(id))).toEqual(['SMOKE-M5-PASS', 'SMOKE-M5-BREAK']);
    for (const [id, node] of before.nodes) expect(after.nodes.get(id), id).toEqual(node);
    for (const id of ['SMOKE-M5-PASS', 'SMOKE-M5-BREAK']) {
      const n = after.nodes.get(id)!;
      expect(n.kind).toBe('task');
      expect(n.deps).toEqual(['SMOKE']);
      expect(typeof n.payload['description']).toBe('string');
      expect((n.payload['description'] as string).trim()).not.toBe('');
      expect(n.payload['acceptanceCriteria']).toHaveLength(1);
      expect(n.payload).not.toHaveProperty('model');
      expect(new SlotValidator().validate(n, n.payload as Record<string, unknown>)).toEqual({ ok: true });
    }
  });

  it('graph.yaml, graph-m5.yaml and real-task.yaml parse as one graph that adds the two M5 tasks and SMOKE-REAL', () => {
    const before = parseGraph(graphText);
    const after = parseGraph(graphText + fragment + real);
    expect([...after.nodes.keys()].filter((id) => !before.nodes.has(id))).toEqual(['SMOKE-M5-PASS', 'SMOKE-M5-BREAK', 'SMOKE-REAL']);
  });

  it('is a fragment, not a graph of its own', () => {
    expect(fragment).not.toMatch(/^nodes:/m);
    expect(fragment.endsWith('\n')).toBe(true);
  });
});
