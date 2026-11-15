## 1. Child environments

- [x] 1.1 `LIBPQ_VARS` in `src/runs/childEnv.ts`; `withoutStore` and `isolationEnv` remove it, `DATABASE_URL_FILE` and the existing store names
- [x] 1.2 Tests: each libpq name, spelled out in `test/runs/child-env.test.ts`; check and agent printouts; daemon git hooks in `test/slice/git-env.test.ts`

## 2. Store URL from a file

- [x] 2.1 `store.urlFile` and `DATABASE_URL_FILE` in `withStoreEnv` (postgres only, read once per process, conflicts and unreadable files refused); `urlSource: urlFile`
- [x] 2.2 Tests: `withStoreEnv` units; a real Postgres daemon from `DATABASE_URL_FILE` with its environment read through `/proc/<pid>/environ` or `ps eww`, from `store.urlFile` in a tracked config, and from a missing file

## 3. Deployment

- [x] 3.1 `deploy/base`: the Secret's `uri` mounted as a file, `store.urlFile` in `orchestrator.yaml`, no `DATABASE_URL` in the daemon's environment; `test/host/deploy.test.ts` asserts it
- [x] 3.2 `deploy/README.md` "Store credentials": what a same-user child can still reach, and what a deployment does about it

## 4. Spec

- [x] 4.1 state-backend, agent-protocol, integration-pipeline and cluster-runtime deltas; `openspec validate store-credentials-reach --strict`
