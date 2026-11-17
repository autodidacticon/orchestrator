## 1. Vectors

- [x] 1.1 `test/runs/run-id-vectors.test.ts`: `origin run ids are frozen` over twenty `[url, id]` literal pairs; the groups as literals; `runIdFor('/data/repo')` and `runLockKey('88b53ae7afc6f781')` as literals
- [x] 1.2 Run it with no edit to `src/`

## 2. Deploy notes

- [x] 2.1 `deploy/README.md` "Who this layout is for" before "Daemon image"
- [x] 2.2 Probes, origin hash rule, URL source refusal, lease rule, SIGTERM exit code, the two smoke-test exit-code sentences, `--break claimable` and attempts
- [x] 2.3 Statements from tasks 1, 4, 8, 9, 19 and 20, written from the code
- [x] 2.4 `deploy/base/orchestrator.yaml`, the comments in `src/config.ts` and `src/main.ts`, and `test/host/deploy.test.ts` on the lease margin

## 3. Checks

- [x] 3.1 `openspec validate run-id-vectors --strict`
- [x] 3.2 `npm test` without `--retry`
