## ADDED Requirements

### Requirement: Inbox notices for health
The inbox SHALL deliver notices of kind `stuck` with `idleMs` and a `message`, `nudge` with the operator's `message`, and `baseMoved` with the new integration `head` and the `files` its commit touched. The brief's workspace section SHALL state that such notices may arrive in the inbox, name the three kinds, tell the agent to check `inbox` after long steps, and state that rebasing the launch branch onto the integration head is allowed while merging into, pushing to, or checking out the integration branch is not.

#### Scenario: Nudge reaches the agent on its next inbox call
- **WHEN** an operator nudges a running task with "commit what you have"
- **THEN** the agent's next `inbox` call returns `{ kind: 'nudge', message: 'commit what you have' }` and the notice is not returned again

#### Scenario: Brief names the notices and allows rebasing
- **WHEN** a brief is composed
- **THEN** its workspace section names `stuck`, `nudge`, and `baseMoved` and says the launch branch may be rebased onto the integration head
