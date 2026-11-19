## MODIFIED Requirements

### Requirement: Clone cache
The loop SHALL keep one clone per `repoUrl` under `ORCH_WORKER_CACHE` (default `/var/cache/orchestrator`), named from the URL and a hash of it, and reuse it across launches; a directory there that is not a clone SHALL be replaced. The clone's `.git/info/exclude` SHALL list `/.orchestrator/`. Before each launch the loop SHALL abort an operation a previous agent left in progress, `git fetch origin`, fetch the start commit by its sha when the fetch did not bring it, `git checkout -f -B <branch> <start>` with start `carry.interrupted.headSha` when the claim carries it and `baseSha` otherwise, `git clean -ffdx` except `.orchestrator/`, and remove a stale `.orchestrator/report.json`. It SHALL then write `.orchestrator/brief.md` (the claim's `briefMarkdown`), `.orchestrator/brief.json` (the claim's `brief`, its `worktree` set to the clone) and `.orchestrator/mcp.json` (the MCP shim with `ORCH_API`, the launch id and token, mode 0600). Through `shimEnv` the shim's `env` there SHALL also hold `ORCH_ACCESS=remote`, `ORCH_WORKTREE` (the clone) and `ORCH_BRANCH` (the claim's `branch`), so the shim's `report` tool pushes the branch and names `sealedSha` (see specs/agent-protocol "MCP façade").

#### Scenario: Interrupted head as the start
- **WHEN** a claim carries `carry.interrupted.headSha` H, a commit on origin
- **THEN** the launch branch is created at H, and the scripted agent's commit on it has H as its parent

#### Scenario: Clone reused, tree clean
- **WHEN** one loop works two launches in a row and the first agent left an untracked file, an untracked directory and an uncommitted change
- **THEN** both agents run in the same clone directory, and the second sees nothing in `git status --porcelain --ignored` but the ignored `.orchestrator/`

#### Scenario: Remote variables in mcp.json
- **WHEN** a loop runs a command agent that reads `.orchestrator/mcp.json`, starts the server it names, commits without pushing, and calls its `report` tool with kind `submit`
- **THEN** the shim's `env` there has `ORCH_ACCESS` `remote`, `ORCH_WORKTREE` the agent's working directory and `ORCH_BRANCH` the launch branch, the task is `submitted`, and the loop prints one `report accepted` line and no `relayed` line
