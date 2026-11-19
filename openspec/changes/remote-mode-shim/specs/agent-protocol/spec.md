## MODIFIED Requirements

### Requirement: Standalone brief
Before launching, the orchestrator SHALL write `<worktree>/.orchestrator/brief.md` and `brief.json`. They SHALL contain:
- the task payload verbatim and the acceptance criteria;
- the definition of done: under the `agent` commit policy, commit all work on the launch branch (a dirty worktree is refused with the file list; commit and resubmit); under `daemon`, leave the changes in the worktree, committed or not, because the orchestrator commits what is uncommitted when it accepts the report. In both cases: never merge or touch the integration branch, declare a no-op explicitly, and terminate after the report is accepted. When the repository has an `openspec/` root (the launch worktree contains `openspec/`), for every runner kind and commit policy it SHALL also say to record any spec change as an OpenSpec change directory `openspec/changes/<name>/` named after the task, with `proposal.md`, `tasks.md` and `specs/<capability>/spec.md` delta files holding `## ADDED|MODIFIED|REMOVED Requirements` sections with full `### Requirement:` blocks, validated with `openspec validate <name>`, and not to edit `openspec/specs/` directly. Without an `openspec/` root the brief SHALL NOT carry that item;
- workspace facts: worktree path, branch, `baseSha`, integration branch;
- the completion report of each direct dependency, and any released cancellation with its reason;
- attempt context when present: the prior failure report, verifier output, conflict details naming the files and the sibling that landed, and the human's answer. Under `agent`, the conflict, interruption, and revision texts tell the agent to rebase, merge or cherry-pick the prior branch, squash a work-in-progress commit, and commit the delta. Under `daemon` they tell it instead to inspect the prior branch with `git show`/`git diff` and reapply the changes as file edits;
- the API base URL, the launch token, the fallback report path, and the instruction to stop immediately on a 401.

A remote launch (`access: remote`) has no worktree: its brief is kept on the launch row (see specs/remote-workspace). The text the orchestrator writes into its workspace and reporting sections SHALL name no path on the daemon's machine (not the run directory, the worktrees root or the daemon's clone) and no loopback address; text carried verbatim (the payload, dependency reports, verifier output) is not rewritten. Its workspace section SHALL instead name the clone (the current directory, a clone of the repository the worker loop made), the branch, the base commit and the integration branch, and SHALL say how work is submitted: commit all work on the branch; `report` with kind submit through the `orchestrator` MCP server's tool pushes the branch to `origin` and names the pushed commit; an agent that calls the API itself first runs `git push origin <branch>` and sends the tip's full sha as `sealedSha`; the orchestrator reads the work from `origin`, not from the clone. Its API base URL SHALL be `apiBaseUrl` (without a trailing slash), never the bind address, and its fallback report path SHALL be the relative path `.orchestrator/report.json`, which the brief says is relative to the root of the clone; `brief.json` SHALL carry the same branch, base commit, API base URL and fallback path. For a carry holding `interrupted`, the remote brief SHALL say that the branch starts at `carry.interrupted.headSha` (the worker loop creates it there), not at the base commit, and SHALL NOT tell the agent to merge or cherry-pick the prior branch onto its base. Whether the remote brief carries the OpenSpec change rule SHALL follow whether the daemon's clone has an `openspec/` root. The commit-policy lines of the definition of done SHALL be those of `agent`, since a remote launch never has policy `daemon`, and the prepare-command item SHALL NOT appear, since a remote run has no `prepareCommand`. A local launch's brief SHALL be unchanged by this.

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

#### Scenario: Remote brief names the clone and no daemon path
- **WHEN** a brief is composed for a remote launch on a run with `apiBaseUrl` `http://orchestrator.example:8080/`
- **THEN** its markdown names the branch, the base commit, the integration branch, `http://orchestrator.example:8080/v1/launches/<launchId>/...` and `.orchestrator/report.json`, and contains neither the run directory, the worktrees root, nor `127.0.0.1`

#### Scenario: Remote brief says to push before submitting
- **WHEN** a brief is composed for a remote launch
- **THEN** its Submit line tells the agent to commit all work on the branch, names the `orchestrator` MCP server's `report` tool as the one that pushes the branch to `origin` and names the pushed commit, tells an agent that calls the API itself to run `git push origin <branch>` first and send `sealedSha`, and says that the orchestrator reads the work from `origin`

#### Scenario: Remote brief after an interruption
- **WHEN** a brief is composed for a remote launch whose task's carry holds `interrupted` with `headSha` H
- **THEN** it says the branch starts at H, created there by the worker loop, not at the base commit

#### Scenario: Remote brief.json matches the markdown
- **WHEN** a brief is composed for a remote launch
- **THEN** its JSON carries the same `branch`, `baseSha`, `apiBaseUrl` and `fallbackPath` that the markdown names

#### Scenario: Remote brief in a repository with an openspec root
- **WHEN** a remote launch is prepared on a run whose clone contains `openspec/`
- **THEN** its brief carries the OpenSpec change-directory rule

### Requirement: MCP façade
A stdio MCP server launched per agent SHALL expose the five operations as tools, forward them to the HTTP API with the token from its environment, and retry through daemon restarts for the retry window before surfacing an error.

Started with `--orch-env-file <path>`, the façade SHALL layer the file's `KEY=VALUE` lines over its environment. When the file is missing or unreadable, it SHALL exit 1 with a message naming the path. The flag is not `--env-file`, because Node takes that flag from anywhere in argv.

The `report` tool's description SHALL state that a submit requires a committed, clean worktree only when `ORCH_COMMIT_POLICY` is unset or `agent`.

The façade SHALL be in remote mode when `ORCH_ACCESS` is `remote`; the worker loop starts it so for a remote launch (see specs/worker-pool "Clone cache"). It then SHALL need `ORCH_WORKTREE` (the clone's path) and `ORCH_BRANCH` (the launch branch), and without either it SHALL exit 1 with a message naming the missing variable. With any other `ORCH_ACCESS` it SHALL read neither variable and behave as without remote mode, since a spawned agent's environment carries `ORCH_WORKTREE` too. In remote mode a `report` call with kind `submit` SHALL do three things before it calls the daemon, and the daemon's answer SHALL be returned unchanged:
- the dirty check of the clone by the rule of a local seal (changed and untracked paths outside `.orchestrator/`): a dirty clone is answered `{ status: 409, error: "dirtyWorktree", files }`;
- `git push --force origin HEAD:refs/heads/<ORCH_BRANCH>`, without a prompt and killed after 60 seconds: a failed push is answered `{ status: 503, error: "pushFailed", message }`. The push is forced because the launch branch belongs to the launch alone and an agent may rebase it after a `baseMoved` notice; `HEAD` is pushed whatever branch the clone has checked out;
- the full sha of `HEAD`, added to the body as `sealedSha`.

A git command that fails in the dirty check or while reading `HEAD` SHALL be answered `{ status: 500, error: "gitFailed", message }`. After any of these refusals nothing is sent to the daemon, so the same call may be sent again with the same `seq`. The `report` tool's input schema SHALL NOT declare `sealedSha`: the façade always names the tip it pushed. A `report` with kind `fail` and the other four tools SHALL be forwarded as without remote mode. In remote mode the `report` tool's description SHALL say that a submit needs committed work, that the tool pushes the branch to `origin` and names its tip, and that after a 409 or 503 answer the same call may be sent again with the same `seq`. The `--help` text SHALL name `ORCH_ACCESS`, `ORCH_WORKTREE` and `ORCH_BRANCH`.

A runner whose CLI can treat an MCP server as optional or gate its tools behind approvals SHALL register the façade as required and with its tools pre-approved. For Codex this means `required=true`, plus the default and per-tool `approve` keys. OpenCode has no `required` analog (a server that cannot start is a warning and the run continues); its tools are named `orchestrator_<tool>` and are pre-approved by the permission rule `"orchestrator_*": "allow"`.

A runner whose CLI times out MCP calls SHALL size the tool timeout above `maxWaitMs`, so a `block` long-poll is not cut: Codex through `tool_timeout_sec`, OpenCode through `mcp.orchestrator.timeout` (its default is 60 000 ms).

#### Scenario: Daemon restart during a call
- **WHEN** the daemon is restarting while an agent calls the `report` tool
- **THEN** the façade retries until the daemon is back and the call succeeds within the retry window

#### Scenario: Report tool under daemon commits
- **WHEN** the façade starts with `ORCH_COMMIT_POLICY=daemon`
- **THEN** the `report` tool's description does not require a committed, clean worktree

#### Scenario: Env file
- **WHEN** the façade starts with `--orch-env-file` naming a file that holds the launch's variables, and none of them is in its environment
- **THEN** a `heartbeat` call is forwarded with the token from the file

#### Scenario: Env file missing
- **WHEN** the façade starts with `--orch-env-file` naming a file that does not exist
- **THEN** it exits 1 and stderr names the file

#### Scenario: Remote submit pushed and sealed by the façade
- **WHEN** the façade runs with `ORCH_ACCESS=remote`, `ORCH_WORKTREE` naming a clean clone whose one commit is not pushed and `ORCH_BRANCH` naming the launch branch, and the agent calls `report` with kind `submit` and no `sealedSha`
- **THEN** origin's launch branch is the clone's `HEAD`, the daemon records an `agent.report` event whose `sealedSha` is that sha, and the call is answered 200 with `accepted: true`

#### Scenario: Dirty clone refused without a round trip
- **WHEN** in remote mode the clone has a changed tracked file or an untracked file outside `.orchestrator/`, and the agent calls `report` with kind `submit`
- **THEN** the call is answered 409 `dirtyWorktree` naming the file, nothing is pushed, and the launch's `lastSignal` is still `claimed`; files under `.orchestrator/` alone leave the clone clean

#### Scenario: Failed push refused without a round trip
- **WHEN** in remote mode origin cannot be reached while the agent calls `report` with kind `submit`
- **THEN** the call is answered 503 `pushFailed` and the launch's `lastSignal` is still `claimed`; once origin is back, the same call with the same `seq` is accepted

#### Scenario: Remote mode without its variables
- **WHEN** the façade starts with `ORCH_ACCESS=remote` and no `ORCH_BRANCH`, or no `ORCH_WORKTREE`
- **THEN** it exits 1 and stderr names the missing variable
