## ADDED Requirements

### Requirement: Remote run requirements
Besides the conditions of "Access modes", the daemon SHALL refuse to start with `runner.access: remote` when `apiBaseUrl` is unset, with a message naming `apiBaseUrl`, and when the commit policy of the runner kind in force is `daemon` (for `codex`, `runner.codex.commit`, or the policy derived from its sandbox when unset), with a message naming the commit policy, the kind and its `commit` key. These conditions SHALL be checked against the configuration in force, overrides included, and named in the same message as the others. On a remote run, admission SHALL block a task whose runner kind (its `runner` selector, else the kind in force) has commit policy `daemon` with reason kind `remoteNeedsAgentCommit`, before brief validation and without creating a launch.

#### Scenario: Remote run without apiBaseUrl
- **WHEN** the daemon starts with `runner.access: remote`, `runner.mode: pull`, `git.pushIntegration: true` and no `apiBaseUrl`
- **THEN** startup fails with a message naming `apiBaseUrl`, and no launch is created

#### Scenario: Remote run whose default kind commits as the daemon
- **WHEN** the daemon starts a remote run with `runner.kind: codex` and `runner.codex.commit` unset under the default `workspace-write` sandbox
- **THEN** startup fails with a message naming the commit policy `daemon` and `runner.codex.commit`

#### Scenario: A task labelled to a daemon-commit kind on a remote run
- **WHEN** a remote run whose default kind is `claude-code` admits a task with the selector `runner: codex` and `runner.codex.commit` unset
- **THEN** the task is `blocked` with reason kind `remoteNeedsAgentCommit` and no launch is created
