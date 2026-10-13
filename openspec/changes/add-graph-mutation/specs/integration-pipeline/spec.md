## ADDED Requirements

### Requirement: Reopen leaves the integration branch untouched
Reopen, uncancel, and cascade SHALL NOT update the integration ref, revert or remove any published commit, or delete any milestone tag. A reopened task's next launch SHALL start from the current integration head, which contains its prior published commit, and its next publication SHALL add one further squash commit carrying the same `Orchestrator-Task` trailer and the new launch's `Orchestrator-Launch` trailer. The one-commit-per-task expectation SHALL be read per published launch.

#### Scenario: Head unchanged by reopen
- **WHEN** T1 is published at head H and then reopened with cascade over T2 and MVP
- **THEN** the integration head is still H, every tag still exists, and no foreign commit is reported

#### Scenario: Revision adds a second trailer commit
- **WHEN** reopened T1 is published again
- **THEN** the integration branch carries two commits with trailer `Orchestrator-Task: T1`, each with a distinct `Orchestrator-Launch`, and the second has the first as an ancestor
