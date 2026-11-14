## 1. Recovery

- [x] 1.1 `endLostClaim`: a waiting launch with an answer is retried with it; without one the task stays waiting
- [x] 1.2 `answer`: a waiting task whose launch is no longer live is retried with the answer
- [x] 1.3 `scrubLostRefs`: lost launch branches and context commits; rewrite stored carries; `recovery.workLost` events; `o.lostRefs`
- [x] 1.4 Guarded re-prepare of a parked launch: missing base or a throwing `prepare` fails the task as `worktreeLost`, uncharged

## 2. Brief

- [x] 2.1 `scrubCarry` in `src/brief/lost.ts`; `briefInput` and `revisionContext` never name a lost ref
- [x] 2.2 `composeBrief`: `lostWork`, conflict without a branch, revision without a branch

## 3. Graph, configuration, lifecycle

- [x] 3.1 `loadGraph` records a rejected stored proposal's stamp; `StoreGraphSource` skips it
- [x] 3.2 `storeDurabilityWarning` and the startup warning event
- [x] 3.3 `reviveDaemon` revives a Postgres run with a local daemon record

## 4. Tests

- [x] 4.1 Real git (`test/slice/fresh-clone.test.ts`): waiting answered and unanswered; kept work lost; base missing and a throwing prepare
- [x] 4.2 `test/slice/fresh-clone-gaps.test.ts`: rejected proposal across a restart and re-sent; unparsable proposal; warning; `scrubCarry`; brief text
- [x] 4.3 `test/runs/lifecycle.test.ts`: Postgres run revival
- [x] 4.4 `npm test` green without `--retry`
