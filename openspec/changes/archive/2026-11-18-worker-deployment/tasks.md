## 1. Worker loop

- [x] 1.1 `ORCH_WORKER_TASK`: every claim carries `taskId`
- [x] 1.2 `ORCH_WORKER_MAX_LAUNCHES`: exit 0 after that many launches; malformed values refused
- [x] 1.3 Tests in `test/worker/loop.test.ts`

## 2. Manifests and image

- [x] 2.1 `deploy/base/worker.yaml` and the base kustomization
- [x] 2.2 Kind overlay `orchestrator.yaml` (remote access, `git.workerOriginUrl`), scripted-agent patch, M3 graph tasks, fixture `.gitattributes`
- [x] 2.3 `orchestrator-worker` on `PATH` in the image
- [x] 2.4 `test/host/deploy.test.ts` and `test/host/docker.test.ts`

## 3. Smoke

- [x] 3.1 `SMOKE` worked by the `smoke-worker` pod; remote claims elsewhere
- [x] 3.2 M3 step: scale, follow logs, three named assertions
- [x] 3.3 Recovery assertions under remote access (operator answer A): no recovery event for a recorded parked launch, no `launch.reprepared`; spec deltas for both drills
- [x] 3.5 `deploy/smoke.sh --fresh` passes against kind
- [x] 3.4 `deploy/README.md`
