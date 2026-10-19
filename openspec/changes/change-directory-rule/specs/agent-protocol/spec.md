## MODIFIED Requirements

### Requirement: Standalone brief
Before launching, the orchestrator SHALL write `<worktree>/.orchestrator/brief.md` and `brief.json`. They SHALL contain:
- the task payload verbatim and the acceptance criteria;
- the definition of done: under the `agent` commit policy, commit all work on the launch branch (a dirty worktree is refused with the file list; commit and resubmit); under `daemon`, leave the changes in the worktree, committed or not, because the orchestrator commits what is uncommitted when it accepts the report. In both cases: never merge or touch the integration branch, declare a no-op explicitly, and terminate after the report is accepted. When the repository has an `openspec/` root (the launch worktree contains `openspec/`), for every runner kind and commit policy it SHALL also say to record any spec change as an OpenSpec change directory `openspec/changes/<name>/` named after the task, with `proposal.md`, `tasks.md` and `specs/<capability>/spec.md` delta files holding `## ADDED|MODIFIED|REMOVED Requirements` sections with full `### Requirement:` blocks, validated with `openspec validate <name>`, and not to edit `openspec/specs/` directly. Without an `openspec/` root the brief SHALL NOT carry that item;
- workspace facts: worktree path, branch, `baseSha`, integration branch;
- the completion report of each direct dependency, and any released cancellation with its reason;
- attempt context when present: the prior failure report, verifier output, conflict details naming the files and the sibling that landed, and the human's answer. Under `agent`, the conflict, interruption, and revision texts tell the agent to rebase, merge or cherry-pick the prior branch, squash a work-in-progress commit, and commit the delta. Under `daemon` they tell it instead to inspect the prior branch with `git show`/`git diff` and reapply the changes as file edits;
- the API base URL, the launch token, the fallback report path, and the instruction to stop immediately on a 401.

The agent sees the shim's tools under a name that depends on its CLI: `mcp__orchestrator__<tool>` under Claude Code and Codex, `orchestrator_<tool>` under OpenCode. The `claude-code` and `codex` briefs keep their Reporting text (the `codex` one is in "Codex brief reports through the MCP server"). An `opencode` brief's Reporting section SHALL name `orchestrator_heartbeat`, `orchestrator_report`, `orchestrator_block`, `orchestrator_inbox` and `orchestrator_log` and tell the agent to prefer them to calling the API from a command. It SHALL keep the API and the fallback file, because no sandbox blocks loopback. It SHALL NOT name `mcp__orchestrator__` tools.

An `opencode` brief's workspace section SHALL say that OpenCode permission rules are in force with nothing else confining the agent's commands. It SHALL say that a command a rule does not allow fails with "The user has specified a rule which prevents you from using this specific tool call." and is not approved at runtime. That is the `deny` error, which the model sees and continues past. It SHALL tell the agent not to retry it but to ask with a `needsAccess` question naming the command and continue with what it can, and say that the operator can run it or set `runner.opencode.permission` to `allow` for the next launch. Under `derived` it SHALL list the file tools (read, glob, grep, list, edit, write), then the `bashPatterns` followed by the check command's patterns. It SHALL say that every other command is denied and that each command of a chain (`&&`, `;`, `|`) must match one of them on its own. It SHALL NOT mention a sandbox.

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

#### Scenario: OpenCode brief names its tools and the deny error
- **WHEN** a brief is composed for an `opencode` launch
- **THEN** it names `orchestrator_report` and the other four tools, contains "The user has specified a rule which prevents you" and not "The user rejected permission", keeps the API line, and contains neither "sandbox" nor `mcp__orchestrator__`

#### Scenario: Claude Code and Codex briefs unchanged by the third kind
- **WHEN** the briefs of a `claude-code` and a `codex` launch are composed from the inputs of the goldens in `test/fixtures/brief`
- **THEN** each is byte-identical to its golden

#### Scenario: Brief in a repository with an openspec root carries the change-directory rule
- **WHEN** a brief is composed for a launch whose worktree contains `openspec/`
- **THEN** its Definition of done says to record spec changes as an OpenSpec change directory `openspec/changes/<name>/` validated with `openspec validate <name>` and not to edit `openspec/specs/` directly, and the `claude-code` brief is byte-identical to the golden `test/fixtures/brief/claude-code-openspec.md`

#### Scenario: Brief without an openspec root has no change-directory rule
- **WHEN** a brief is composed for a launch whose worktree has no `openspec/`
- **THEN** its Definition of done does not mention OpenSpec
