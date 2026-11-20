## Why

Three worker loops each decide when to stop polling, and their rules differ in five places: what "live" means, the paused run, the idle exit, the human and stalled classes, and launch rows whose task already reported (GH-192). The owner decided on 2026-11-19 that the daemon classifies and each loop keeps its own reaction to a class. This change makes the daemon compute one verdict per runner kind and serve it, with the counts behind it; the loops read it in #194 and #196.

## What Changes

- A pure module `src/loop/verdict.ts` exports `WORK_VERDICTS` (`finished`, `stalled`, `paused`, `claim`, `standby`, `human`, `idle`, strongest first), `workVerdict(run, kind)`, and `strongestVerdict(list)`. It has no runtime import from the daemon.
- `GET /v1/status` carries `workByKind`: for every runner kind `{ verdict, claimable, preparing, working }`. `claimable` and `preparing` are the kind's entries of `claimableByKind` and `preparingByKind`; `working` counts the live launches of the kind whose task runs or waits on that launch, the predicate of `claim()`.
- The digest of `GET /v1/events`, of the `wait` tool and of the exit record carries the same `workByKind`.
- Without a graph both bodies carry every kind with zero counts and `idle`, or `paused` when the run is paused.
- The `status` and `wait` tool descriptions name `workByKind`.
- No loop changes, no store change, no event.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `operator-control`: ADDED "Work verdict", "Work verdict: claim and standby", "Work verdict: human and idle", "Work verdict: working launches", "Status report: work verdict per kind", "Status report: work verdict without a graph".
- `operator-mcp`: ADDED "Wait digest: workByKind", "Status and wait descriptions: workByKind".

## Impact

- `src/loop/verdict.ts` (new), `src/loop/orchestrator.ts` (`StatusReport.workByKind`, `status()`), `src/operator/routes.ts` (`digestOf` and both bodies without a graph), `src/operator/mcp-server.ts` (two descriptions).
- Tests: `test/loop/work-verdict.test.ts`, `test/slice/work-verdict.test.ts`, `test/slice/operator-mcp.test.ts`.
- `hosts/**` and `src/worker/**` are untouched.
