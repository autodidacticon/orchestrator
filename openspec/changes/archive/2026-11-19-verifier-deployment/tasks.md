## 1. Image

- [x] 1.1 Link `dist/src/verifier/loop.js` as `/usr/local/bin/orchestrator-verifier` in the `Dockerfile`; name the verifier loop in its first comment
- [x] 1.2 `test/host/docker.test.ts`: four entrypoints from the package bins, four names in `deploy/README.md`

## 2. Manifests

- [x] 2.1 `deploy/base/verifier.yaml` and its line in `deploy/base/kustomization.yaml`
- [x] 2.2 Kind overlay: `verifier.mode: remote`, the verifier patch (one replica, `ORCH_VERIFIER_BACKOFF_MAX_MS=2000`)
- [x] 2.3 Fixture check `fixture/test.js`, fragment `graph-m5.yaml`, the comment of `kind-claude/real-task.yaml`
- [x] 2.4 `test/host/deploy.test.ts`: base kinds, the verifier Deployment in both renders, the overlay keys, the fragment parse

## 3. Smoke test

- [x] 3.1 Step 5 waits for `orchestrator-verifier`
- [x] 3.2 The M5 step: probe, upload, worker restart, eight assertions, `pg_m5_jobs` and `pg_m5_reason`; `cleanup` stops the probe
- [x] 3.3 The real-agent upload sends `graph-m5.yaml` too
- [x] 3.4 `test/host/smoke.test.ts`: schema functions, verifier rollout, M5 order, real-agent upload

## 4. Notes and checks

- [x] 4.1 `deploy/README.md` ("The verifiers", the corrected sentences) and `README.md` "Running on Kubernetes"
- [x] 4.2 `openspec validate verifier-deployment --strict`
- [x] 4.3 `npm test` and `bash deploy/smoke.sh --fresh`
