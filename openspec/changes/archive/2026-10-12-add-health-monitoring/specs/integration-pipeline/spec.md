## ADDED Requirements

### Requirement: Rebase from the merge base
The verifier SHALL rebase onto the integration head only the commits after the merge base of the head and `sealedSha`, and SHALL record on its published outcome the files changed between the expected head and the rebased sha, so that a branch the agent rebased onto a newer head verifies without replaying published commits and the base-moved notice can list what moved.

#### Scenario: Rebased branch verifies
- **WHEN** an agent rebases its launch branch onto the integration head after a `baseMoved` notice, commits one more change, and submits
- **THEN** verification publishes exactly one trailer commit containing only the agent's changes

#### Scenario: Changed files recorded
- **WHEN** a task is published with a commit touching `src/a.ts` and `README.md`
- **THEN** the job records `changedFiles` `["README.md", "src/a.ts"]`
