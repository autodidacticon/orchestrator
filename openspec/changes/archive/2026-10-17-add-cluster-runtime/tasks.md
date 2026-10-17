## 1. Reconcile the specs with the landed code

- [x] 1.1 Walk each `cluster-runtime` requirement against its test (`test/slice/bind.test.ts`, `test/slice/probes.test.ts`, `test/host/docker.test.ts`, `test/host/deploy.test.ts`, `test/host/smoke.test.ts`) and the code (`src/config.ts`, `src/agent/server.ts`, `src/operator/routes.ts`, `Dockerfile`, `deploy/`); where a scenario is not covered by an existing assertion, add the assertion to that test rather than loosening the scenario
- [x] 1.2 Walk `operator-control` "Container mode" and "Idle exit" and `crash-recovery` "Idle exit and revival" against `src/main.ts`, `src/log.ts`, `src/runs/lifecycle.ts`, `src/operator/mcp-server.ts`, `test/slice/container.test.ts`, `test/runs/log.test.ts`, `test/runs/remote.test.ts`; add the "Never idle when disabled" and "Loopback URL still revives" assertions where the tests lack them (the container and remote tests already have both; confirm)
- [x] 1.3 Confirm `apiBind` and `apiBaseUrl` are absent from `OVERRIDABLE_KEYS` and `overridesSchema` in `src/runs/resolve.ts`, and that `PUT /v1/config` with either key answers 400 naming it; add that assertion to `test/loop/config.test.ts`
- [x] 1.4 Fix any disagreement 1.1 to 1.3 turned up in the code, keeping the spec as written unless the code is right and the spec text came from an acceptance criterion that was wrong; note each fix in this file. Outcome: no code disagreed. Two assertions were added: `deploy.test.ts` checks `apiBaseUrl` names the Service, `config.test.ts` checks `apiBind` and `apiBaseUrl` are refused as overrides. The "Import against the mounted graph" scenario has no local test: it is a property of the read-only ConfigMap mount and is exercised only on a cluster.

## 2. Documentation

- [x] 2.1 README "Running locally": add a short "Running on Kubernetes" paragraph pointing at `deploy/README.md` (image, manifests, kind overlay, smoke test) and naming `apiBind`, `apiBaseUrl`, `ORCH_LOG_FORMAT=json`, and `ORCH_URL` as the cluster-facing settings
- [x] 2.2 README configuration section: `apiBind` and `apiBaseUrl` in the `orchestrator.yaml` example with one-line comments, and a sentence that they are file keys read at start, not runtime overrides
- [x] 2.3 README Contents index: `cluster-runtime` under the capability specs, `operator-control` and `crash-recovery` lines mention container mode, the archived-changes list gains this change, and the "No change is active" line is kept accurate
- [x] 2.4 `deploy/README.md`: add a "Specification" line linking `openspec/specs/cluster-runtime/spec.md` and the operator-control "Container mode" requirement

## 3. Finish

- [x] 3.1 `openspec validate add-cluster-runtime`; `npm run build`; `npm test` green; `git status` shows no untracked `orchestrator.yaml`
- [x] 3.2 Archive with the delta specs synced (both operator-control blocks and the crash-recovery block are MODIFIED replacements of text already in the main specs; `cluster-runtime` is new) and commit on `main`
