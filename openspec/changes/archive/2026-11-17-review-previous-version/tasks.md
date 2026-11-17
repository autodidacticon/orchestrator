## 1. Answer

- [x] 1.1 `src/operator/review.ts`: `previousOf`, a pure builder of the block from gathered facts, with the stat cut for the index
- [x] 1.2 `gatherPrevious`: kv `tagged:<id>:<n-1>`, the second-to-last submitted transition, used only when its sha matches, and one `diffStat` call when the shas differ (a throw is an empty stat)
- [x] 1.3 `indexOf` and `fullOf` take the facts and place `previous` after `omitted` and before `diffStat`; the one-task answer is unchanged

## 2. Tests

- [x] 2.1 Unit cases in `test/operator/review.test.ts`: version 1, added and republished tasks, no sha on record, an empty stat between two shas, the same commit, an unreadable closure, and the cut
- [x] 2.2 Loop cases in `test/operator/review.test.ts` on the loop harness: version 1, a republished task at version 2, an added task at version 3, and the same commit with no git call for the previous sha
- [x] 2.3 `test/slice/events.test.ts`: `GET /v1/milestones/<id>/review` at version 2 answers `previous.version` 1
