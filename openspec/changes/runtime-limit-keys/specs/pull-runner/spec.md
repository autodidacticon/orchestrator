## ADDED Requirements

### Requirement: Claim states the limit in force
The `health.stuckFailAfterMs` of a claim response, a repeated claim included, SHALL be the value in force when the response is built, overrides applied: an override of 0 SHALL give 0, and a cleared override SHALL give the file value, else the default. A work loop that has already taken the value for a launch keeps it for that launch.

#### Scenario: A claim after an override
- **WHEN** `health: { stuckFailAfterMs: 1800000 }` is applied and a worker claims a launch
- **THEN** the claim carries `health.stuckFailAfterMs` 1800000

#### Scenario: A repeated claim after a further change
- **WHEN** the override is changed to 3600000 and the worker repeats its claim
- **THEN** the repeated claim carries 3600000

#### Scenario: A claim after an override of 0
- **WHEN** `health: { stuckFailAfterMs: 0 }` is applied and a worker claims a launch
- **THEN** the claim carries `health.stuckFailAfterMs` 0
