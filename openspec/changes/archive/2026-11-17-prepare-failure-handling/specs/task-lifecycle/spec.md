## MODIFIED Requirements

### Requirement: Transition table enforcement
The system SHALL permit exactly the transitions below and MUST reject any other transition with an error naming the current and requested status.

| From | To | Whose intent | Trigger |
|---|---|---|---|
| unstarted | blocked | orchestrator | brief validation failed, or a remediation candidate awaits review |
| unstarted | running | orchestrator | ready, brief valid, slot admitted; launch created |
| running | submitted | agent | submit report accepted and sealed |
| running | failed | agent | fail report |
| running | blocked | agent | block delivered through the fallback file after exit |
| running | waiting | agent | block through the long-poll |
| running | failed | orchestrator | process dead without a report, lease expired, or a claimed launch released after progress without keep |
| running | failed | orchestrator | worktreeLost: a claimed launch's worktree is gone at startup on a fresh clone; attempts unchanged |
| running | unstarted | orchestrator | claimed launch released without progress, or released with keep after progress |
| running | unstarted | orchestrator | prepareFailed: the prepare command failed in the launch's worktree, below `prepareFailureLimit` failures in a row; attempts and carry unchanged |
| running | blocked | orchestrator | prepareFailed: the prepare command failed `prepareFailureLimit` times in a row; attempts and carry unchanged |
| waiting | running | orchestrator | answer persisted and a slot admitted |
| waiting | blocked | orchestrator | maxWait elapsed, process dead, or a claimed launch released |
| submitted | done | verifier | published |
| submitted | failed | verifier | checks red, undeclared empty diff, missing acceptance evidence, or integration cap hit |
| submitted | unstarted | verifier | rebase conflict under the cap |
| submitted | blocked | verifier | pushRefused: origin refused the publication push `git.pushRefusalLimit` times; attempts unchanged |
| submitted | failed | orchestrator | commitLost: a queued job's sealed commit is missing at startup on a fresh clone; attempts unchanged |
| failed | unstarted | orchestrator | attempts below maxAttempts |
| failed | blocked | orchestrator | attempts exhausted |
| blocked | unstarted | human | unblock or answer |
| done or cancelled | unstarted | human | reopen or uncancel when revocable |
| running, waiting, submitted, or done | unstarted | human | cascade reopen of an upstream node |
| any non-terminal | cancelled | human | cancel |
| milestone unstarted | done | orchestrator | closure satisfied, not gated |
| milestone unstarted | submitted | orchestrator | closure satisfied, gated |
| milestone submitted | done | human | accept |
| milestone submitted | blocked | human | reject |
| milestone done or submitted | unstarted | orchestrator | milestone reset: upstream reopened, or deps changed on reload |

#### Scenario: Listed transition is applied
- **WHEN** a task is `failed` with attempts below the maximum and the orchestrator requests `unstarted`
- **THEN** the transition is applied

#### Scenario: Unlisted transition is rejected
- **WHEN** a transition from `unstarted` directly to `done` is requested for a task
- **THEN** the transition is rejected and the overlay is unchanged

#### Scenario: Milestone never runs
- **WHEN** a transition to `running` is requested for a milestone
- **THEN** the transition is rejected

#### Scenario: Cascade row applies to a running dependent
- **WHEN** T2 is `running` and a human cascades a reopen of T1 with trigger `cascade`
- **THEN** T2 becomes `unstarted` and its lease is cleared

#### Scenario: Milestone reset row
- **WHEN** MVP is `done` and the orchestrator requests `unstarted` with trigger `milestoneReset`
- **THEN** the transition is applied, and the same request by an agent is rejected

#### Scenario: Release without progress returns to unstarted
- **WHEN** a claimed launch is released before any progress was observed
- **THEN** the orchestrator applies `running -> unstarted` with `attempts` unchanged and the lease cleared

#### Scenario: Kept release after progress returns to unstarted
- **WHEN** a claimed launch with commits is released with `keep`
- **THEN** the orchestrator applies `running -> unstarted` with trigger `released`, `attempts` unchanged, the lease cleared, and `carry.interrupted` set

#### Scenario: Fresh-clone losses spend no attempt
- **WHEN** startup on a fresh clone applies `submitted -> failed` with trigger `commitLost` or `running -> failed` with trigger `worktreeLost`
- **THEN** `attempts` is unchanged and the task is retried through `failed -> unstarted`

#### Scenario: A refused push blocks the task
- **WHEN** the verifier's job for a submitted task fails as `pushRefused`
- **THEN** the verifier applies `submitted -> blocked` with trigger `pushRefused` and `attempts` unchanged, and the same request by an agent is rejected

#### Scenario: A failed prepare command returns the task to unstarted
- **WHEN** a launch's prepare command fails while its task runs on it, below `prepareFailureLimit` failures in a row
- **THEN** the orchestrator applies `running -> unstarted` with trigger `prepareFailed`, `attempts` and the carry unchanged and the lease cleared, and the same request by an agent is rejected

#### Scenario: Prepare failures at the limit block the task
- **WHEN** a task's prepare command fails for the `prepareFailureLimit`-th time in a row
- **THEN** the orchestrator applies `running -> blocked` with trigger `prepareFailed`, `attempts` and the carry unchanged, and the same request by an agent is rejected

### Requirement: Structured blocked reasons
A `blocked` status SHALL carry a reason with a kind from `needsDecision`, `needsAccess`, `impossible`, `dependencyCancelled`, `outOfScope`, `insufficientSpec`, `milestoneRejected`, `pushRefused`, and `prepareFailed`, plus a message, and for `needsDecision` any options and the eventual answer. Only the verifier SHALL set `pushRefused`, and agents MUST NOT block with it. Only the orchestrator SHALL set `prepareFailed`, and agents MUST NOT block with it.

#### Scenario: Question survives into the next brief
- **WHEN** a task is blocked with kind `needsDecision` and a human answers
- **THEN** the task returns to `unstarted` and its next brief contains the question and the answer

#### Scenario: A refused push names origin's text
- **WHEN** a task is blocked with kind `pushRefused`
- **THEN** its message holds the text origin answered the push with, and an unblock returns it to `unstarted` with its budgets reset

#### Scenario: Repeated prepare failures name the command
- **WHEN** a task is blocked with kind `prepareFailed`
- **THEN** its message names the prepare command, the count and the last reason and holds no command output, and an unblock returns it to `unstarted` with its count of prepare failures removed

#### Scenario: An agent cannot block with an orchestrator kind
- **WHEN** an agent's block call names kind `prepareFailed` or `pushRefused`
- **THEN** it is answered 400 and the task stays `running`
