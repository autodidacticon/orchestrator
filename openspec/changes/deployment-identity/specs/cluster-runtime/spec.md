## ADDED Requirements

### Requirement: Deployment run id
The reference manifests SHALL set no fixed run id: neither `store.runId` in the ConfigMap nor `ORCH_RUN_ID` on the daemon. Each deployment SHALL get its id from its clone's origin (`REPO_URL`, with `git.pushIntegration` on). `deploy/README.md` SHALL state the order in which the id is chosen, its format, and when to set `store.runId` or `ORCH_RUN_ID`. `deploy/smoke.sh` SHALL read the run id from `/v1/status`.

#### Scenario: Base manifest
- **WHEN** the base is rendered
- **THEN** the ConfigMap's `store` block is `{kind: postgres, flushDeadlineMs}` without `runId` or `url`, and the daemon container has no `ORCH_RUN_ID`

#### Scenario: Two deployments on one database
- **WHEN** two deployments of the manifest clone different repositories and use one Postgres database
- **THEN** their run ids differ, because each id is the hash of its own origin
