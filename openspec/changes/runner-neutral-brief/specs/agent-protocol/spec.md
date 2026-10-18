## MODIFIED Requirements

### Requirement: Standalone brief
Before launching, the orchestrator SHALL write `<worktree>/.orchestrator/brief.md` and `brief.json`. They SHALL contain:
- the task payload verbatim and the acceptance criteria;
- the definition of done: under the `agent` commit policy, commit all work on the launch branch (a dirty worktree is refused with the file list; commit and resubmit); under `daemon`, leave the changes in the worktree, committed or not, because the orchestrator commits what is uncommitted when it accepts the report. In both cases: never merge or touch the integration branch, declare a no-op explicitly, and terminate after the report is accepted;
- workspace facts: worktree path, branch, `baseSha`, integration branch;
- the completion report of each direct dependency, and any released cancellation with its reason;
- attempt context when present: the prior failure report, verifier output, conflict details naming the files and the sibling that landed, and the human's answer. Under `agent`, the conflict, interruption, and revision texts tell the agent to rebase, merge or cherry-pick the prior branch, squash a work-in-progress commit, and commit the delta. Under `daemon` they tell it instead to inspect the prior branch with `git show`/`git diff` and reapply the changes as file edits;
- the API base URL, the launch token, the fallback report path, and the instruction to stop immediately on a 401.

`brief.json` SHALL carry the launch's `runner` (`kind`, `commitPolicy`, and `sandbox` for a `codex` launch). A brief composed without a runner SHALL be the `claude-code` text under the `agent` policy. The brief MUST be sufficient for a person to perform the task without any other channel.

#### Scenario: Brief carries direct dependency reports
- **WHEN** T2 is launched after T1 is done
- **THEN** T2's brief contains T1's completion report and nothing from transitive dependencies beyond a pointer to the log

#### Scenario: Retry brief carries context
- **WHEN** a task is launched for its second attempt after a verifier red check
- **THEN** the brief contains the first attempt's failure report and the check output

#### Scenario: Codex brief under daemon commits
- **WHEN** a brief is composed for a `codex` launch with `commitPolicy: daemon`, carrying interruption (with a work-in-progress commit), conflict, and revision context
- **THEN** it says the orchestrator commits uncommitted changes, tells the agent to reapply the prior branch's changes as file edits, does not contain "commit and resubmit", "squash the work-in-progress commit", or "commit the delta", and `brief.json` carries `runner.kind: codex`

### Requirement: Check command and tool rules in the brief
The brief's definition of done SHALL name the effective check command at the time the brief is composed. When `checkCommand` is unresolved the brief SHALL say that no check command is configured for the repository yet, that the operator is being asked, and that the agent must run the project's documented test suite before submitting. For spawned launches whose runner carries an allow list (the Claude Code runner), the brief's workspace section SHALL list the Bash rules in force, stating that a worker holding a claimed launch runs under its own permissions instead. It SHALL tell the agent to run commands from the worktree root without `cd`, because every part of a compound command must match a rule on its own. It SHALL tell the agent to ask with a `needsAccess` question naming the command when it needs one the rules do not cover, rather than retrying it. For a `codex` launch the workspace section SHALL carry no Bash rules. It SHALL instead name the Codex sandbox mode and say that approvals are disabled, so a command the sandbox refuses fails with `Operation not permitted` and is not approved at runtime. It SHALL tell the agent not to retry such a command but to ask with a `needsAccess` question naming it. It SHALL also say that the operator can run the command or change `runner.codex.sandbox` for the next launch.

#### Scenario: Detected command in the brief
- **WHEN** a brief is composed for a spawned claude-code launch in a repository whose detected check command is `npm test`
- **THEN** its definition of done says to run `npm test` before submitting and its workspace section lists `Bash(npm test:*)` among the rules

#### Scenario: Unresolved command in the brief
- **WHEN** a brief is composed while `checkCommand` is unresolved
- **THEN** it says no check command is configured yet and instructs the agent to run the project's documented tests before submitting

#### Scenario: Later brief reflects the change
- **WHEN** the operator sets `checkCommand` after T1's brief was written and T2 is prepared afterwards
- **THEN** T2's brief names the new command and T1's brief in its worktree is unchanged

#### Scenario: Codex sandbox in the brief
- **WHEN** a brief is composed for a `codex` launch whose sandbox is `workspace-write`
- **THEN** its workspace section names the sandbox `workspace-write`, says a refused command fails with `Operation not permitted` and is not approved at runtime, tells the agent to ask with a `needsAccess` question naming the command, and does not say that Bash rules are in force

### Requirement: Inbox notices for health
The inbox SHALL deliver notices of kind `stuck` with `idleMs` and a `message`, `nudge` with the operator's `message`, `baseMoved` with the new integration `head` and the `files` its commit touched, and `payloadChanged` with the new graph `rev`. The brief's workspace section SHALL state that such notices may arrive in the inbox, name the four kinds, and tell the agent to check `inbox` after long steps. The brief SHALL state that merging into, pushing to, or checking out the integration branch is not allowed. Under the `agent` commit policy it SHALL state that rebasing the launch branch onto the integration head is allowed. Under `daemon` it SHALL instead state that the orchestrator rebases the branch onto the integration head at verification.

#### Scenario: Nudge reaches the agent on its next inbox call
- **WHEN** an operator nudges a running task with "commit what you have"
- **THEN** the agent's next `inbox` call returns `{ kind: 'nudge', message: 'commit what you have' }` and the notice is not returned again

#### Scenario: Brief names the notices and allows rebasing
- **WHEN** a brief is composed for a launch with the `agent` commit policy
- **THEN** its workspace section names `stuck`, `nudge`, `baseMoved`, and `payloadChanged` and says the launch branch may be rebased onto the integration head

#### Scenario: Codex brief under daemon commits does not allow rebasing
- **WHEN** a brief is composed for a `codex` launch with `commitPolicy: daemon`
- **THEN** it names the four notice kinds, forbids merging into, pushing to, or checking out the integration branch, does not say "You may rebase", and says the orchestrator rebases the branch at verification
