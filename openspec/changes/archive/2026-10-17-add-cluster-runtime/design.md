## Context

Six commits landed on `main` between `f976758` and `f06234e` without a change directory: `Dockerfile` and `.dockerignore`; `deploy/` with a kustomize base, a kind overlay, a git-origin fixture, `smoke.sh`, and a README; `apiBind` and `apiBaseUrl` in the config and `ApiServer.listen`; `GET /healthz` and `GET /readyz` in the operator routes with the probe exemption widened in the server dispatch; a bounded SIGTERM shutdown, `src/log.ts` with `ORCH_LOG_FORMAT=json`, the daemon writing its own pid file, and a remote-URL guard in the lifecycle and the operator MCP server. Tests cover each piece (`test/host/{docker,deploy,smoke}.test.ts`, `test/runs/{log,remote}.test.ts`, `test/slice/{bind,probes,container}.test.ts`).

ORC-14 also wrote into the main specs: a `Container mode` requirement in `operator-control` and a scenario under `Idle exit and revival` in `crash-recovery`. Those blocks exist now; they are not proposals.

## Goals / Non-Goals

**Goals:**
- Every landed behaviour has a requirement and at least one scenario, derived from the landed tests rather than invented.
- The main specs agree with the code after archive, including the two blocks ORC-14 wrote.
- The README points a reader at the cluster path without duplicating `deploy/README.md`.

**Non-Goals:**
- New behaviour. In particular not the `ORCH_HOME` isolation or shutdown attribution from the stop incident.
- Moving `Container mode` out of `operator-control`; code comments and tests cite it there.
- Running the smoke test against a cluster; that is the milestone claim and the user's cluster.

## Decisions

**Deltas for text that already exists are MODIFIED, never ADDED.** `operator-control` already holds `### Requirement: Container mode` and `crash-recovery` already holds the container scenario under `Idle exit and revival`. An ADDED delta would make the archive sync append a duplicate header. Both deltas copy the full existing block and edit it in place.

**`cluster-runtime` is the home for the pieces the code already attributes to it.** `src/config.ts`, `src/agent/server.ts`, `src/operator/routes.ts`, and the bind and probes tests cite `specs/cluster-runtime`; the lifecycle code and the container and remote tests cite `specs/operator-control "Container mode"`. The split follows those citations: anything about the process in a pod that is also true on a laptop (signals, logs, pid file, remote URL) stays in operator-control; anything that exists only for the cluster (bind, advertised URL, probes, image, manifests, smoke) goes to cluster-runtime.

**`apiBind` and `apiBaseUrl` are file keys, not runtime overrides.** The bind happens once at boot, so `configure` cannot change it; the spec says so explicitly to stop a later change from adding it to `OVERRIDABLE_KEYS` by analogy with `capacity`. Rejected: marking them start-only like `integrationBranch`, because nothing pins them and a running daemon simply never reads them again.

**The mounted-graph limitation becomes spec text.** In the manifests layout the graph is a read-only ConfigMap mount, so `PUT /v1/graph` (import, accepting a proposal) fails. The deploy README says this; the spec records it as the known gap that M2's store-backed graph source (ORC-20) closes, so nobody files it as a bug.

**`Idle exit` is corrected rather than cross-referenced.** The requirement states "a probe is `GET /v1/status` with `probe=1`", the code exempts two more routes. One sentence changes; the scenario in `probes.test.ts` ("a long sequence of health calls does not reset the idle clock") becomes the spec's scenario.

**Scenarios come from the test names.** Each landed test is one scenario, with its assertions as the THEN. Where a test asserts more than the issue's acceptance criteria asked for (the smoke script pins `--context kind-<cluster>`, the kind overlay merges a one-task graph so `claimable` can be non-empty), the spec follows the test.

## Risks / Trade-offs

- [Spec written after code can rationalise a bug as a feature] → every requirement is checked against the test that exercises it, and anything found to disagree is listed as a code fix in the tasks rather than written into the spec.
- [The verifier's `reset --hard` destroys uncommitted edits while the run is live] → the run has finished and M1 awaits review, so nothing spawns; still, the tasks end with a commit and the review happens after.
- [Two agents' spec texts (operator-control, crash-recovery) were written without the README index or the Contents list] → this change's README task covers the index for all of M1.

## Migration Plan

No code migration. Archive syncs the new spec and two modified blocks; the README index gains the entry. Rollback is reverting the commit; the landed code is unaffected either way.

## Open Questions

- None for this change. The stop-incident hardening is tracked for a separate change.
