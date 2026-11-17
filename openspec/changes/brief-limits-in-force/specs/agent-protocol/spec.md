## ADDED Requirements

### Requirement: Brief states the limits in force
The daemon SHALL pass in every brief input it builds `limits` (`stuckAfterMs`, `stuckFailAfterMs`, `maxLaunchMs`) from the configuration in force when the brief is composed, and `brief.json` SHALL carry it. The Reporting section SHALL hold one `- Limits:` line after the place of the lease line stating each limit above 0 with its consequence, what counts as progress, what to do, and that the numbers can change during the run, a change arriving as a `nudge` notice.

#### Scenario: Default limits
- **WHEN** a launch is briefed under the default configuration
- **THEN** its brief has one limits line naming `health.stuckAfterMs` 900000 (flagged, a `stuck` notice in the inbox), `health.stuckFailAfterMs` 2700000 (the launch is ended and the attempt spent) and `budgets.maxLaunchMs` 7200000 (the launch is ended when the budget is used up, also while it makes progress)
- **AND** the line says a progress signal is a call to an operation, a commit, or a change in the worktree, tells the worker to call `heartbeat` between long steps, to run a longer command in the background, and to report or ask a question before the budget ends
- **AND** the line says the numbers are those in force when the brief was written, that the operator can change them during the run, and that a change arrives as a `nudge` notice in the inbox
- **AND** the line does not say when the budget clock starts, what it leaves out, or how idle time is measured, and holds no URL
- **AND** `brief.json` carries `limits` with those three numbers

#### Scenario: One limit 0
- **WHEN** a brief is composed with `stuckAfterMs` 0 and the other two limits above 0
- **THEN** the limits line does not name `health.stuckAfterMs` or promise a `stuck` notice, and still names the other two limits

#### Scenario: All limits 0
- **WHEN** a brief is composed with all three limits 0
- **THEN** the brief has no limits line, and `brief.json` carries `limits` with the three zeros

#### Scenario: Input without limits
- **WHEN** a brief is composed from an input without `limits`
- **THEN** the brief has no limits line and `brief.json` has no `limits` key

#### Scenario: Launch prepared for a claim
- **WHEN** a launch is prepared for a claim
- **THEN** its brief has the lease line followed by the limits line, and `brief.json` carries both `leaseTtlMs` and `limits`
