## MODIFIED Requirements

### Requirement: Pod termination
On SIGTERM or SIGINT the worker loop SHALL claim no more and SHALL hand back a launch it holds: it SHALL stop the agent's process group, relay a fallback report, read the status, and, while it still holds the launch, commit the work in progress, push `HEAD` to the launch branch and release with keep and reason `podTerminating`. It SHALL exit 0 when it held nothing, the report was accepted, the launch had ended or the release was answered 200, and 1 otherwise.

#### Scenario: Signals
- **WHEN** the loop gets SIGTERM or SIGINT
- **THEN** it prints `worker <id> terminating <launchId> <taskId>` (`-` for a missing id) and claims no more; a second signal during the termination changes nothing and records no second release

#### Scenario: Idle
- **WHEN** the loop gets the signal with no launch held and no claim in flight
- **THEN** it ends its wait and exits 0 at once, and releases nothing

#### Scenario: Claim in flight
- **WHEN** the signal arrives while a claim is in flight
- **THEN** the claim's fetch is aborted and the claim is sent again for at most 5000 ms (`TERMINATION_CALL_MS`); answered 200, its launch is released without keep with reason `podTerminating`, no agent starts and the loop exits 0 when the release is answered 200; with any other answer, or no answer within those 5000 ms, it exits 0

#### Scenario: Claim never answered
- **WHEN** in `test/worker/loop.test.ts`, with `retryWindowMs` 60000, a claim is in flight at SIGTERM and the daemon never answers it
- **THEN** the loop exits 0 within `TERMINATION_CALL_MS` plus 1000 ms of the signal

#### Scenario: Agent not started
- **WHEN** the signal arrives while the clone is prepared or before the agent starts
- **THEN** the launch is released without keep with reason `podTerminating` at once, without waiting for the clone

#### Scenario: Stopping the agent
- **WHEN** the signal arrives while the command agent runs, in its process group of its own
- **THEN** the loop sends SIGTERM to the group, waits up to `ORCH_WORKER_AGENT_STOP_MS` (default 10000, set in `WorkerSettings` only when the variable is set) for it to exit and close its pipes, and then sends SIGKILL to the group; 0 sends SIGKILL at once; after a SIGKILL it waits for the command's exit, not for its pipes; the scripted agent is awaited

#### Scenario: Steps after the agent
- **WHEN** the agent has exited after the signal
- **THEN** the loop stops its heartbeats (waiting at most 5 s for one in flight), relays a fallback report, and reads the status; a task `submitted` or `done` is `report accepted` and nothing is released; a launch that has ended is left alone; a launch still held, or a status read without an answer or answered other than 200, is handed back

#### Scenario: Work in progress
- **WHEN** a held launch is handed back and the clone has uncommitted or untracked files outside `.orchestrator/`
- **THEN** they are committed on the launch branch as one commit (`git add -A`, hooks skipped, identity `orchestrator-worker <worker@orchestrator.local>`), `HEAD` is pushed to the launch branch on origin, forced, within 30 s, and release is called with `{ workerId, reason: 'podTerminating', keep: true, headSha, wipCommit }`, `headSha` the pushed `HEAD`

#### Scenario: Nothing uncommitted
- **WHEN** a held launch is handed back with a clean clone
- **THEN** nothing is committed, the push and the release still run, and the release body has no `wipCommit`; at the launch's base with no agent API call the daemon answers `kept: false`

#### Scenario: Failed commit
- **WHEN** the work-in-progress commit fails (an `index.lock` left behind, say)
- **THEN** the loop logs it, pushes `HEAD` as it is and releases with that `headSha` and no `wipCommit`

#### Scenario: Failed push
- **WHEN** the push fails
- **THEN** the loop prints `push-failed` (git's message on stderr), calls no release, and exits 1; the lease expiry then decides from what origin holds

#### Scenario: Failed release
- **WHEN** the release is answered other than 200 or gets no answer
- **THEN** the loop prints `release-failed` (the status with the answer's `error` or `reason` on stderr), does not try again, and exits 1; a release answered 200 prints `released` and exits 0 whatever `kept` says

#### Scenario: Bounded calls after the signal
- **WHEN** the loop starts an API call after the signal (the relay's post, the status read, the release)
- **THEN** a connection failure is retried for at most the smaller of `ORCH_RETRY_WINDOW_MS` and 5000 ms, each fetch is bounded as verifier-pool `Verifier termination: bounded calls` says, and a call in flight at the signal is aborted and has at most 5000 ms left; a push the relay makes after the signal is limited to 30 s and stays unforced

#### Scenario: Handed back in a slice
- **WHEN** in `test/slice/worker-termination.test.ts` an agent changes a tracked file, adds an untracked file and waits, and the loop gets SIGTERM
- **THEN** the loop exits 0, `launch.released` has `reason: podTerminating`, `keep: true`, `kept: true` and `headSha`, origin's branch tip is that commit holding both files and nothing under `.orchestrator/`, the task is `unstarted` with `attempts` 0 and `interruptions` 1, and the next claim answers `carry.interrupted.headSha` equal to it
