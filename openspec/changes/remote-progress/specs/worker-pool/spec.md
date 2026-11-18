## ADDED Requirements

### Requirement: Loop heartbeat
From the claim until the agent exits, the worker loop SHALL send `POST /v1/launches/:id/heartbeat` with the launch token every `lease.renewEveryMs` of the claim (a third of `leaseTtlMs`; a third of `lease.ttlMs` when `renewEveryMs` is absent), whether or not the agent calls the API itself, so that a healthy worker never loses its lease during a long silent step. Once the clone is prepared, each heartbeat SHALL carry `fingerprint`, the clone's fingerprint computed by the same function the daemon's `GitWorkspace.fingerprint` uses (specs/health-monitoring "Progress signals"), so the same tree gives the same string; it SHALL carry no `progress` text, so it is never a `heartbeatText` signal. The next heartbeat SHALL be timed from the answer to the previous one, so two never overlap. A heartbeat answered 401 SHALL end the heartbeats for that launch. The heartbeats SHALL stop when the agent exits, before any fallback report is relayed, and when the clone cannot be prepared. A loop heartbeat renews the lease, as every agent call does, and counts as progress only when its fingerprint changed.

#### Scenario: Silent agent keeps its lease
- **WHEN** a remote run with `leaseTtlMs` 60000 runs the scripted agent, which sleeps for three lease TTLs without calling the API before it commits and submits, and the daemon ticks on the same fake clock throughout
- **THEN** the loop sends nine heartbeats, one every 20 s from the claim, each with the clone's fingerprint and no text; the lease never expires; and the task ends `submitted`

#### Scenario: Without heartbeats the lease lapses
- **WHEN** the same run's loop sends no heartbeat
- **THEN** the launch ends with reason `leaseExpired`

#### Scenario: Revoked launch
- **WHEN** a loop heartbeat is answered 401
- **THEN** the loop sends no further heartbeat for that launch

#### Scenario: One fingerprint function
- **WHEN** the loop fingerprints its clone and `GitWorkspace.fingerprint` reads the same directory, clean, edited, with an untracked file and after a commit
- **THEN** both give the same string each time
