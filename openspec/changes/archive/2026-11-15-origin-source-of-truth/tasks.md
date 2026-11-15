## 1. Configuration and origin

- [x] 1.1 `src/config.ts`: `git.originUrl`, `git.pushIntegration` (default false), `git.fetchIntervalMs`
- [x] 1.2 `src/workspace/origin.ts`: `Origin` (ensure remote, serialized fetch, tracking head, relation, lease push, tag push without force, `TagConflictError`)
- [x] 1.3 `src/loop/orchestrator.ts`: build the `Origin` from config and hand it to the workspace and the verifier

## 2. Verifier

- [x] 2.1 `run`: fetch, find an already-landed trailer, then fast-forward, catch-up push or diverged failure; take `expectedHead` from origin
- [x] 2.2 Push after the local compare-and-swap with `--force-with-lease`; on failure undo the swap and requeue
- [x] 2.3 `recoverPublishing`: origin first, then a one-time push of the recorded squash with the job's lease
- [x] 2.4 `foreignCommits`: only commits in the clone that origin lacks

## 3. Workspace and milestones

- [x] 3.1 `integrationHead`: origin's head, or the clone's while it is ahead
- [x] 3.2 `tagMilestone` pushes the tag; `src/loop/tick.ts` `pushMilestoneTags` retries with `tagPushed:` markers and reports a conflict once

## 4. Tests

- [x] 4.1 `test/slice/origin.test.ts` against a bare origin: history parity and accepted tag, lease lost mid-publication, human commit not foreign, kill between swap and push, lease lost at recovery, catch-up push, tag retry, tag conflict, no remote contact when off
- [x] 4.2 `npm test` green without `--retry`
