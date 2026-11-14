## ADDED Requirements

### Requirement: Durable publishing record
The verifier SHALL wait until its `publishing` record is durable before it moves the integration branch or pushes to origin. If the store goes fatal while waiting, neither effect SHALL happen and no outcome SHALL be recorded. Other progress records SHALL NOT wait. This narrows state-backend "Durability before effects": the wait on entry to `run` is not enough for the effects inside it.

#### Scenario: Sink stalls after the check started
- **WHEN** the sink stalls while a job's check runs, and the job records `publishing`
- **THEN** the integration branch and origin do not move until the sink accepts that record, and the job is then published

#### Scenario: Fatal while waiting
- **WHEN** the store goes fatal while the verifier waits for the `publishing` record
- **THEN** the integration branch and origin are unchanged, no outcome is recorded, and recovery at the next start decides the job from its last durable record
