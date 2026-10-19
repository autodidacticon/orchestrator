## MODIFIED Requirements

### Requirement: Standalone brief
Before launching, the orchestrator SHALL write `<worktree>/.orchestrator/brief.md` and `brief.json`. They SHALL contain:
- the task payload verbatim and the acceptance criteria;
- the definition of done: under the `agent` commit policy, commit all work on the launch branch (a dirty worktree is refused with the file list; commit and resubmit); under `daemon`, leave the changes in the worktree, committed or not, because the orchestrator commits what is uncommitted when it accepts the report. In both cases: never merge or touch the integration branch, declare a no-op explicitly, and terminate after the report is accepted;
- workspace facts: worktree path, branch, `baseSha`, integration branch;
- the completion report of each direct dependency, and any released cancellation with its reason;
- attempt context when present: the prior failure report, verifier output, conflict details naming the files and the sibling that landed, and the human's answer. Under `agent`, the conflict, interruption, and revision texts tell the agent to rebase, merge or cherry-pick the prior branch, squash a work-in-progress commit, and commit the delta. Under `daemon` they tell it instead to inspect the prior branch with `git show`/`git diff` and reapply the changes as file edits;
- the API base URL, the launch token, the fallback report path, and the instruction to stop immediately on a 401.

The agent sees the shim's tools under a name that depends on its CLI: `mcp__orchestrator__<tool>` under Claude Code and Codex, `orchestrator_<tool>` under OpenCode. The `claude-code` and `codex` briefs keep their Reporting text (the `codex` one is in "Codex brief reports through the MCP server"). An `opencode` brief's Reporting section SHALL name `orchestrator_heartbeat`, `orchestrator_report`, `orchestrator_block`, `orchestrator_inbox` and `orchestrator_log` and tell the agent to prefer them to calling the API from a command. It SHALL keep the API and the fallback file, because no sandbox blocks loopback. It SHALL NOT name `mcp__orchestrator__` tools.

An `opencode` brief's workspace section SHALL say that OpenCode permission rules are in force with nothing else confining the agent's commands. It SHALL say that a command a rule does not allow fails with "The user rejected permission to use this specific tool call." and is not approved at runtime. It SHALL tell the agent not to retry it but to ask with a `needsAccess` question naming the command and continue with what it can, and say that the operator can run it or set `runner.opencode.permission` to `allow` for the next launch. It SHALL NOT mention a sandbox.

`brief.json` SHALL carry the launch's `runner` (`kind`, `commitPolicy`, `sandbox` for a `codex` launch, and `permission` for an `opencode` launch). The `permission` holds `mode` (`derived` or `allow`) and, under `derived`, the `bashPatterns` the runner's ruleset allows, `git *` first. A brief composed without a runner SHALL be the `claude-code` text under the `agent` policy. The brief MUST be sufficient for a person to perform the task without any other channel.

#### Scenario: Brief carries direct dependency reports
- **WHEN** T2 is launched after T1 is done
- **THEN** T2's brief contains T1's completion report and nothing from transitive dependencies beyond a pointer to the log

#### Scenario: Retry brief carries context
- **WHEN** a task is launched for its second attempt after a verifier red check
- **THEN** the brief contains the first attempt's failure report and the check output

#### Scenario: Codex brief under daemon commits
- **WHEN** a brief is composed for a `codex` launch with `commitPolicy: daemon`, carrying interruption (with a work-in-progress commit), conflict, and revision context
- **THEN** it says the orchestrator commits uncommitted changes, tells the agent to reapply the prior branch's changes as file edits, does not contain "commit and resubmit", "squash the work-in-progress commit", or "commit the delta", and `brief.json` carries `runner.kind: codex`

#### Scenario: OpenCode brief names its tools and the rejection
- **WHEN** a brief is composed for an `opencode` launch
- **THEN** it names `orchestrator_report` and the other four tools, contains "The user rejected permission", keeps the API line, and contains neither "sandbox" nor `mcp__orchestrator__`

#### Scenario: Claude Code and Codex briefs unchanged by the third kind
- **WHEN** the briefs of a `claude-code` and a `codex` launch are composed from the inputs of the goldens in `test/fixtures/brief`
- **THEN** each is byte-identical to its golden

### Requirement: Check command and tool rules in the brief
The brief's definition of done SHALL name the effective check command at the time the brief is composed. When `checkCommand` is unresolved the brief SHALL say that no check command is configured for the repository yet, that the operator is being asked, and that the agent must run the project's documented test suite before submitting. For spawned launches whose runner carries an allow list (the Claude Code runner), the brief's workspace section SHALL list the Bash rules in force, stating that a worker holding a claimed launch runs under its own permissions instead. It SHALL tell the agent to run commands from the worktree root without `cd`, because every part of a compound command must match a rule on its own. It SHALL tell the agent to ask with a `needsAccess` question naming the command when it needs one the rules do not cover, rather than retrying it. For a `codex` launch the workspace section SHALL carry no Bash rules. It SHALL instead name the Codex sandbox mode and say that approvals are disabled, so a command the sandbox refuses fails with `Operation not permitted` and is not approved at runtime. It SHALL tell the agent not to retry such a command but to ask with a `needsAccess` question naming it. It SHALL also say that the operator can run the command or change `runner.codex.sandbox` for the next launch. For an `opencode` launch the workspace section SHALL carry no Bash rules either. Under `runner.opencode.permission: derived` it SHALL list the bash patterns the runner's ruleset allows (`git *` and the patterns derived from the same rules the OpenCode runner is given: `Bash(x:*)` as `x *`, `Bash(x)` as `x`), next to the file tools and the orchestrator tools, and say every other command is rejected. Under `allow` it SHALL say every command and tool is allowed and list no patterns. Both forms SHALL state that a worker holding a claimed launch runs under its own permissions instead. A retry brief's runner diagnosis line SHALL name permission rules rather than a sandbox among the causes outside the worktree.

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

#### Scenario: OpenCode derived patterns in the brief
- **WHEN** an `opencode` launch is prepared under `permission: derived` with the rules `Bash(npm test:*)` and `Bash(git status)`
- **THEN** `brief.json` carries `runner.permission` `{ mode: derived, bashPatterns }` starting with `git *`, and the workspace section lists `npm test *` and `git status`

#### Scenario: OpenCode allow in the brief
- **WHEN** an `opencode` launch is prepared under `permission: allow`
- **THEN** the workspace section says every command is allowed and lists no patterns

### Requirement: Codex brief reports through the MCP server
The brief of a `codex` launch SHALL tell the agent to call heartbeat, report, block, inbox and log through the `orchestrator` MCP server's tools, and not to call the agent API from a command (curl or a script), because the Codex sandbox refuses a command's network access while Codex runs the MCP server outside the sandbox. It SHALL keep the fallback report file for the case where an MCP tool call itself fails. A `claude-code` or `opencode` brief SHALL NOT carry this text.

#### Scenario: Codex brief names the MCP tools
- **WHEN** a brief is composed for a `codex` launch
- **THEN** its Reporting section names the `orchestrator` MCP server's tools and says not to call the API from a command

#### Scenario: Real Codex reports through the MCP server
- **WHEN** the opt-in e2e (`ORCH_E2E_CODEX=1`) runs four tasks under `workspace-write`
- **THEN** every task is published through an MCP `report`, no launch ends with `fallback:submit`, and the question task's log holds exactly one completed `block` item carrying the answer
