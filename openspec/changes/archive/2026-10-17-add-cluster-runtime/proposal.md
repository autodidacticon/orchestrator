## Why

Milestone M1 of the cloud-native project ("Daemon runs on kind") was implemented by an unattended orchestrator run on 2026-10-17: six tasks (ORC-8, 9, 12, 13, 14, 19) published a daemon image, kustomize manifests with a kind overlay, a smoke script, health probes, a configurable bind host and advertised URL, and a container-mode lifecycle. The specs were deliberately held back so six parallel agents would not churn on shared spec files; one task (ORC-14) wrote spec text into the main specs anyway. This change gives the landed code its specification, reconciles the main specs with the code, and documents the cluster path in the README. It inverts the usual spec-first order on purpose; the archive records why.

## What Changes

- New capability `cluster-runtime` describing what landed: the bind host and advertised URL (`apiBind`, `apiBaseUrl`, file keys only), the `/healthz` and `/readyz` probes, the daemon image, the reference kustomize manifests with the kind overlay and its git-origin fixture, and the smoke script with its dry run. Scenarios are written from the tests the run landed.
- `operator-control`: the `Container mode` requirement ORC-14 added is kept and tidied; `Idle exit` is corrected so the probe exemption names `/healthz` and `/readyz` beside `GET /v1/status?probe=1`, which is what the code does.
- `crash-recovery`: the container scenario ORC-14 appended to `Idle exit and revival` is kept and reworded to match the operator-control text.
- README: a short "Running on Kubernetes" pointer to `deploy/README.md`, the `apiBind`, `apiBaseUrl`, `ORCH_LOG_FORMAT`, and `ORCH_URL` lines in the configuration section, and the Contents index entry for `cluster-runtime` and this change.
- Code changes only where the spec and the code disagree; none are known beyond comments that name spec sections.

## Capabilities

### New Capabilities
- `cluster-runtime`: running the daemon as a long-lived container on Kubernetes: bind host and advertised URL, health probes, the daemon image, the reference manifests and kind overlay, the smoke test, and the mounted-graph limitation.

### Modified Capabilities
- `operator-control`: `Idle exit` names the two probe routes as non-activity; `Container mode` is tidied in place (requirement already present in the main spec).
- `crash-recovery`: the `Idle exit and revival` requirement keeps its container scenario with wording aligned to operator-control.

## Impact

- Specs: `openspec/specs/cluster-runtime/spec.md` (new), `operator-control`, `crash-recovery`.
- Docs: `README.md` (running section, configuration keys, Contents index), `deploy/README.md` is already the operational reference and is only linked.
- Code: none expected; the tasks include a reconciliation pass that fixes any disagreement found while writing scenarios, and the comment references in `src/agent/server.ts`, `src/operator/routes.ts`, `src/config.ts`, `src/main.ts`, and the tests already point at `specs/cluster-runtime` and `specs/operator-control "Container mode"`.
- Out of scope, deliberately: the two hardening items from the stop incident of the same night (an isolated `ORCH_HOME` for spawned agents and check commands; recording the caller of `POST /v1/shutdown`). They get their own change.
