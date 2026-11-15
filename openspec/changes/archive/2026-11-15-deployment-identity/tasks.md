## 1. Run id per deployment

- [x] 1.1 `store.runId` in the config schema (file only; the stored overrides already drop `store`)
- [x] 1.2 `chooseRunId`: `store.runId`, `ORCH_RUN_ID`, `git.originUrl` hash, clone origin hash (pushIntegration on), path hash; refuse an invalid explicit id, naming it; SQLite unchanged
- [x] 1.3 `runDirFor` follows the id; `main.ts` picks the id before the store opens, for `--repo` and `--config`, and logs the path-hash warning once

## 2. Manifests

- [x] 2.1 The base ConfigMap sets no run id, and the Deployment sets no `ORCH_RUN_ID`; a comment points at the README
- [x] 2.2 `deploy/README.md` "The run id": the order, when to set one, the format

## 3. No store URL in child environments

- [x] 3.1 `childEnv.ts`: `STORE_VARS` in the isolation keys, `withholdStoreUrl`, `withoutStore`; `childEnv` applies it
- [x] 3.2 `SubprocessRunner.spawn` applies `withoutStore` for every runner kind
- [x] 3.3 `main.ts` withholds the resolved URL and refuses a tracked config file that sets `store.url`

## 4. Tests and record

- [x] 4.1 Unit: precedence, invalid ids, SQLite unchanged, run directory (`test/runs/run-id.test.ts`); child env with a check and an agent printing their environment (`test/runs/child-env.test.ts`)
- [x] 4.2 Postgres daemons: two origins on one repository path and one database; `store.runId` over `ORCH_RUN_ID`; invalid id; path hash with one warning; check and agent environments with the URL from `DATABASE_URL` and from an untracked file; tracked file refused (`test/runs/deployment-identity.test.ts`)
- [x] 4.3 `openspec validate deployment-identity --strict`
