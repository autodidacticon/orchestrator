## MODIFIED Requirements

### Requirement: Process liveness
On every tick, in the reconcile phase, the daemon SHALL ask the runner for the liveness of each live launch as `alive`, `dead`, or `unknown`. `alive` SHALL renew the task's lease and feed the progress, stuck, and time-budget checks. `dead` SHALL be handled as before: a fallback file is applied, otherwise the task fails with reason `exitedWithoutReport`. When the runner implements `readFailure` and returns a diagnosis `{ reason, detail? }` for the dead launch, the dead-launch record SHALL carry it: the failure's message SHALL name the reason and the detail, its `detail.runnerFailure` SHALL hold the diagnosis, and the `launch.ended` event SHALL carry `runnerFailure`. A runner without `readFailure`, or one that returns nothing, SHALL leave the record as before. The same SHALL hold for a launch found dead at recovery. `unknown` SHALL leave lease expiry as the only bound on silence. Runners that spawn processes SHALL derive liveness from the recorded pid; a runner that cannot observe its launches SHALL report `unknown`.

#### Scenario: Alive process renews the lease
- **WHEN** a running launch's process is alive and the agent has made no API call since the last tick
- **THEN** the lease `expiresAt` is extended by the TTL on this tick

#### Scenario: Dead process without a report is unchanged
- **WHEN** a running launch's process is dead, no fallback file exists, and the runner has no diagnosis
- **THEN** the task becomes `failed` with reason `exitedWithoutReport`, message `process exited without a report`, and `attempts` increases

#### Scenario: Dead process with the runner's reason
- **WHEN** a running Codex launch's process is dead, no fallback file exists, and its log shows an `error` event naming the unknown model `no-such-model`
- **THEN** the task becomes `failed` with reason `exitedWithoutReport`, the message contains `unknownModel` and the error text naming `no-such-model`, `detail.runnerFailure.reason` is `unknownModel`, and the `launch.ended` event carries the same `runnerFailure`

#### Scenario: Unknown liveness falls back to the lease
- **WHEN** the runner reports `unknown` for a running launch and no API call arrives for longer than the lease TTL
- **THEN** the task becomes `failed` with reason `leaseExpired` and `attempts` increases
