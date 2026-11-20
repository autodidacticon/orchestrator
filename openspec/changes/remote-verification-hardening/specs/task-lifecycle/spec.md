## ADDED Requirements

### Requirement: Transition table: verifier outcomes: verifierLost
The verifier SHALL request `submitted -> failed` with trigger `verificationFailed` and failure kind `verifierLost` for a task whose remote verify job lost its verifier three times, as verifier-pool "Verify lease: cycle cap" says. The transition SHALL spend an attempt, as for a failed check.

#### Scenario: Verifier lost three times
- **WHEN** the tick applies a job that is `failed` with `failureKind` `verifierLost`
- **THEN** the task goes `submitted -> failed` with trigger `verificationFailed` and failure kind `verifierLost`, and `attempts` is 1
