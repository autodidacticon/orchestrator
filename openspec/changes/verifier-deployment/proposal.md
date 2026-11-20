## Why

Under `verifier.mode: remote` the daemon offers each verify job over its API (#30, #32), and the verifier loop `orchestrator-verifier` claims it, rebases the sealed commit, runs the check command and posts the result (#33). Nothing runs that loop in a cluster yet: the image puts three entrypoints on `PATH`, `deploy/base` has no verifier Deployment, the kind overlay runs every check in the daemon's container, and the smoke test cannot tell where a check ran.

## What Changes

- `Dockerfile`: links `dist/src/verifier/loop.js` as `/usr/local/bin/orchestrator-verifier`; packages, stages, `USER` and `CMD` are unchanged.
- New `deploy/base/verifier.yaml`: the Deployment `orchestrator-verifier` at `replicas: 0`, label `app.kubernetes.io/name: orchestrator-verifier`, uid, gid and `fsGroup` 1000, one container `verifier` on `orchestrator:dev` running `orchestrator-verifier`, with `POD_NAME`, `ORCH_API` and `ORCH_VERIFIER_CACHE` on an `emptyDir`; no Secret, volume claim or database variable.
- Kind overlay: `verifier.mode: remote` in its `orchestrator.yaml`, and a patch that runs the verifier at one replica with `ORCH_VERIFIER_BACKOFF_MAX_MS=2000`. The base keeps `local`.
- Fixture check `fixture/test.js`: waits 5 seconds and fails on a `README.md` line that starts with `- SMOKE-M5-BREAK `. New graph fragment `deploy/overlays/kind/graph-m5.yaml` with `SMOKE-M5-PASS` and `SMOKE-M5-BREAK`.
- `deploy/smoke.sh`: step 5 waits for the verifier rollout; a new M5 step with a process probe and eight `M5:` assertions; the real-agent upload sends `graph.yaml`, `graph-m5.yaml` and `real-task.yaml`.
- `deploy/README.md` and the "Running on Kubernetes" paragraph of `README.md` are corrected, with a new section "The verifiers".

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `cluster-runtime`: MODIFIED "Daemon image", "Daemon image: deploy notes", "Reference manifests", "Reference manifests: kind overlay remote run", "Smoke test", "Smoke test: M3 and M4 steps", "Smoke real-agent step" and "Deploy notes state who the layout is for"; ADDED "Verifier Deployment" and "Smoke M5 step", each with its `<name>: <behavior>` parts.

## Impact

- Files: `Dockerfile`, `deploy/base/verifier.yaml`, `deploy/base/kustomization.yaml`, `deploy/overlays/kind/{kustomization.yaml,orchestrator.yaml,graph-m5.yaml,fixture/test.js}`, the comment of `deploy/overlays/kind-claude/real-task.yaml`, `deploy/smoke.sh`, `deploy/README.md`, `README.md`.
- Tests: `test/host/deploy.test.ts`, `test/host/docker.test.ts`, `test/host/smoke.test.ts`.
- No source file changes. Follow-ups: #39 (probes, resources, NetworkPolicy), #37 (scaling), #36 and #38 (allowlist, deploy key), the M6 cluster-tokens issue (verifier token), #40 (Helm).
