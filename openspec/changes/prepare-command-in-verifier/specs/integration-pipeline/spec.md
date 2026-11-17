## ADDED Requirements

### Requirement: Prepare command before the check
With the top-level file key `prepareCommand` set, the verifier SHALL run it in each job's temporary worktree after the rebase and the declared no-op test and immediately before the check command, with `prepareTimeoutMs` (default 600000) and the check command's environment ("Check environment"). The value SHALL be read once when the verifier is built; it is a file key with no override. A prepare command that exits non-zero, or whose exit code is null, SHALL fail the job with kind `checkFailed` and message `prepare command exited <code>`. One that exceeds `prepareTimeoutMs` SHALL be killed and SHALL fail the job with kind `checkTimeout` and message `prepare command exceeded <ms>ms`. On either failure the check command SHALL NOT run, an attempt SHALL be spent as for a failing check ("Check and verified tree"), and the job's output SHALL be the message, a newline, and the command's output tail, so the first line of the output names the prepare command. The verifier's prepare command SHALL have no failure count, backoff or block of its own; `maxAttempts` bounds it. The published tree SHALL be the one read before the prepare command runs ("Check and verified tree"), so nothing the command writes is published, and the verifier SHALL NOT test whether the command left the worktree clean. A command that has not closed 2000 ms after the kill at `prepareTimeoutMs`, or that exited while another process still holds its output pipe, SHALL be recorded then as a timeout. With `prepareCommand` unset the verifier SHALL behave as it does without this requirement.

#### Scenario: Install before the check
- **WHEN** `prepareCommand` installs into `node_modules/` in the temporary worktree and the check command needs that install
- **THEN** the check passes, the submission is published and the task is `done`, and the published tree has no file under `node_modules/` even though the repository does not ignore it

#### Scenario: Non-zero exit
- **WHEN** the prepare command exits 3
- **THEN** the check command does not run, the job is `failed` with kind `checkFailed`, an attempt is spent, the first line of the job's output is `prepare command exited 3` followed by the command's output, and the task's next brief carries that output

#### Scenario: Timeout
- **WHEN** the prepare command runs longer than `prepareTimeoutMs`
- **THEN** it is killed, the check command does not run, the job is `failed` with kind `checkTimeout`, an attempt is spent, and the first line of the job's output is `prepare command exceeded <prepareTimeoutMs>ms`

#### Scenario: Output pipe held after exit
- **WHEN** the prepare command exits 0 but a process it started in another process group still holds its output pipe
- **THEN** the command is killed at `prepareTimeoutMs`, the job is recorded as `failed` with kind `checkTimeout` 2000 ms later while that process may still be alive, and the first line of the job's output is `prepare command exceeded <prepareTimeoutMs>ms`

#### Scenario: Declared no-op
- **WHEN** a declared no-op is verified with `prepareCommand` set
- **THEN** neither the prepare command nor the check command runs and the job is published at the integration head

#### Scenario: No check command
- **WHEN** a job reaches the check step with no check command
- **THEN** it fails as it does without `prepareCommand`, and the prepare command does not run

#### Scenario: Unset key
- **WHEN** `prepareCommand` is unset
- **THEN** the verifier runs only the check command and every outcome is as without this requirement
