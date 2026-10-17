## MODIFIED Requirements

### Requirement: Idle exit and revival
An idle exit SHALL be a graceful stop: the orchestrator loop stops, in-flight verification is awaited (none exists when quiescent), no agent is reaped, the store is closed, and the exit record is written. A daemon started afterwards SHALL run the same recovery as after any stop and SHALL find nothing to adopt or repair: a `submitted` milestone keeps its `integrationSha`, `reviewVersion`, and tag; a `blocked` task keeps its question and answer; pending outbox effects stay pending; parked launches stay `claimable` with their worktrees re-prepared when missing; and the next tick proceeds from the stored state. The exit record SHALL NOT be consulted by recovery. The crash matrix SHALL keep passing with the default idle window, because every run in it finishes well inside it. A daemon in container mode (`daemon.idleExitMs: 0`, reached through a non-loopback `ORCH_URL`) SHALL never exit idle and SHALL never be revived by a client spawning a local process; a signalled stop in that mode SHALL be recovered like any graceful stop, and a check abandoned at the shutdown grace SHALL restart from `queued` (see specs/operator-control "Container mode").

#### Scenario: Review survives an idle exit
- **WHEN** the daemon exits idle while MVP is `submitted` at version 2 and is revived by `accept` with that sha and version
- **THEN** MVP becomes `done` and no launch, job, or tag is created or changed by recovery

#### Scenario: Blocked question survives an idle exit
- **WHEN** the daemon exits idle while T3 is `blocked` with a question and is revived by `answer`
- **THEN** T3 becomes `unstarted` with the answer in its carry and is launched on the next tick

#### Scenario: Parked launches survive an idle exit
- **WHEN** the daemon exits idle with two launches parked in `pull` mode and is revived by a worker's `claim`
- **THEN** the worker receives the oldest parked launch with its worktree present

#### Scenario: Container mode never exits idle and is never revived locally
- **WHEN** `daemon.idleExitMs` is 0 and a client's `ORCH_URL` names the daemon's non-loopback Service
- **THEN** the daemon stays up while quiescent, and a client that cannot reach it reports the URL as unreachable instead of spawning a local daemon
