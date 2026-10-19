## MODIFIED Requirements

### Requirement: OpenCode runner command composition
The OpenCode runner SHALL spawn `DEFAULT_OPENCODE_COMMAND`, or `runner.opencode.command` when it is set:

`opencode run --format json {pure} --print-logs --log-level WARN -m {model} {variant} < {brief}`

The brief on stdin SHALL be the whole message; the template SHALL have no positional message and no `{allowedTools}` slot. stdin SHALL always be redirected: a run whose stdin stays open hangs after `message=init`. At every spawn the runner SHALL fill:
- `{pure}` with `--pure` when `runner.opencode.pure` is true (the default), and otherwise with nothing;
- `{variant}` with `--variant <effort>` when the launch has an effort, and otherwise with nothing; `{variant}` carries the effort slot, so `hasEffortSlot` is true for the template;
- `{model}` with the launch's `provider/model`, which the shell hands to `-m` as one word.

The command SHALL contain no token and no config path. Before spawning, the runner SHALL add to the launch environment:
- `OPENCODE_CONFIG_CONTENT`: the per-launch config JSON, which outranks a repository's own `opencode.json`;
- `XDG_DATA_HOME=<worktree>/.orchestrator/opencode-data` when `runner.opencode.dataDir` is `launch` (a private database, log, and `auth.json`; OAuth logins of the user are then not visible);
- `XDG_CONFIG_HOME=<worktree>/.orchestrator/opencode-config`, an existing empty directory, when `runner.opencode.ignoreUserConfig` is true.

The config JSON SHALL carry:
- `mcp.orchestrator`: `type: local`, `command: [<shim command>, ...<shim args>]`, `enabled: true`, and `timeout`, with no `environment` block. The shim inherits `ORCH_API`, `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_RETRY_WINDOW_MS`, and `ORCH_COMMIT_POLICY` from the agent environment;
- `snapshots: false` unless `runner.opencode.snapshots` is true;
- `share: "disabled"`;
- `permission`: the ruleset below.

The same JSON SHALL be written to `.orchestrator/opencode.json` with mode 0600 for debugging and the work loop, and never passed to opencode as a path.

MCP call timeout: opencode 1.18.30 cuts an MCP tool call at 60 000 ms by default and drops `mcp.timeout.execution` with a compatibility warning; the per-server `mcp.<id>.timeout` is honoured. `mcp.orchestrator.timeout` SHALL therefore be `runner.opencode.toolTimeoutMs` when it is set, and otherwise `maxWaitMs + 60000`. The config SHALL NOT emit `mcp.timeout`. The same key is the startup tools-fetch timeout, so a shim that hangs at startup is noticed late; a shim whose command cannot start fails at once and the run continues without the tools.

Permissions: under `runner.opencode.permission: derived` (the default) the ruleset SHALL be `{ "*": "deny", read, glob, grep, list, edit, write: "allow", "bash": { "*": "deny", "git *": "allow", <one "allow" per derived rule>, <one "allow" per check-command pattern> }, "orchestrator_*": "allow" }`, with no `ask` value anywhere. The catch-alls SHALL be `deny` because headless opencode 1.18.30 auto-rejects an `ask` and then ends the run after that step (`step_finish` reason `tool-calls`, exit 0), so the model never sees the refusal (test/fixtures/opencode/events/P-ask.jsonl). A `deny` returns "The user has specified a rule which prevents you from using this specific tool call." to the model and the run goes on (P-deny.jsonl), and the brief tells the model to turn that into a `needsAccess` question. The `deny` catch-all also overrides opencode's own `ask` defaults (`external_directory`, `doom_loop`). In 1.18.30 `write` is its own permission, not covered by `edit`, and there is no `patch` tool. A derived `Bash(x:*)` SHALL become the pattern `"x *"` and `Bash(x)` SHALL become `"x"`; other rules have no bash pattern. The catch-all SHALL come first in each map, as opencode takes the last matching rule. `"npm test *"` does not match a bare `npm test`. Under `allow` the ruleset SHALL be `{ "*": "allow" }`.

Chained commands: opencode 1.18.30 matches each simple command of a bash call on its own. Each part of a `&&`, `||`, `;` or `|` chain needs a rule that allows it, and a pattern holding a whole chain never matches. Redirections are not separate commands, and `cd` is not matched against the bash rules (test/fixtures/opencode/events/X-*.jsonl, configs/X-*.json). So `git add <f> && git commit -m <m>` runs under `git *`. The check-command patterns SHALL come from splitting the effective check command the same way, at `&&`, `||`, `;`, `|` and newlines outside quotes, with each part trimmed and allowed exactly and duplicates dropped. A spawned launch reads the check command from its `.orchestrator/brief.json`, and the work loop passes the claim's `brief.checkCommand`.

The derived rules SHALL be the composed allow list when there is one. Under an opencode run, where none is composed, they SHALL be composed the same way from the detected toolchain, `runner.claude.deriveTools`, `runner.claude.allowedTools`, and the argument rules.

`composeOpenCodeCommand(launch, policy)` and `openCodeConfig(settings, allowedTools, maxWaitMs, shim, checkCommand)` SHALL be exported for the work loop.

#### Scenario: Default composition
- **WHEN** an opencode launch with model `opencode/big-pickle` and effort `high` is spawned under the default `runner.opencode`
- **THEN** the command is `opencode run --format json --pure --print-logs --log-level WARN -m opencode/big-pickle --variant high < <brief>`, with no token and no config path

#### Scenario: Keys change the command
- **WHEN** `pure` is false, or the launch has no effort
- **THEN** the command has no `--pure`, or no `--variant`, respectively

#### Scenario: Per-launch config in the environment
- **WHEN** a launch is spawned with allowed rules `Bash(npm test:*)` and `Bash(git status)` and the default `maxWaitMs`
- **THEN** `OPENCODE_CONFIG_CONTENT` has `mcp.orchestrator.command` equal to the shim command, `mcp.orchestrator.timeout` 3660000, no `mcp.timeout`, `snapshots: false`, `share: "disabled"`, no `environment` block, and a bash ruleset denying `*` and allowing `git *`, `npm test *`, and `git status`
- **AND** `.orchestrator/opencode.json` holds the same JSON with mode 0600, and the child's stdin is the brief

#### Scenario: Derived ruleset lets a task finish
- **WHEN** an opencode launch is spawned under `derived` with no derived rules and the check command `npm ci --ignore-scripts && npm run build` in its brief.json
- **THEN** the ruleset holds no `ask` and allows `write`, and its bash map is `{ "*": "deny", "git *": "allow", "npm ci --ignore-scripts": "allow", "npm run build": "allow" }`, so both the check command and `git add <f> && git commit -m <m>` run

#### Scenario: Tool timeout configured
- **WHEN** `runner.opencode.toolTimeoutMs` is 120000
- **THEN** `mcp.orchestrator.timeout` is 120000

#### Scenario: Data and config isolation
- **WHEN** `dataDir` is `launch` and `ignoreUserConfig` is true
- **THEN** `XDG_DATA_HOME` is under `<worktree>/.orchestrator/` and `XDG_CONFIG_HOME` names an existing empty directory there

#### Scenario: Real OpenCode run publishes three tasks
- **WHEN** `ORCH_E2E_OPENCODE=1 npx vitest run test/e2e/opencode.test.ts` runs with `opencode` on PATH and no OpenCode login, at capacity 2 with model `opencode/big-pickle`, `permission: derived` and the check command `node --test` allowed through the file rule `Bash(node:*)`, which the derived ruleset turns into the pattern `node *`, on a graph where T1 commits a file, T2 asks a `needsDecision` question that is answered only after 75 s, and T3 depends on both
- **THEN** the run finishes with every task `done` and one `Orchestrator-Task` trailer per task on the integration branch, every launch row has runner `opencode`, and no `needsAccess` question names `git commit`, because the agent commits under `commit: agent`
- **AND** every launch that did not die at startup has `tokens.input` and `tokens.output` above 0, `costUsd` 0 and `usageSource` `opencode`, and a question answered after 75 s reaches the agent, because `mcp.orchestrator.timeout` is above 60 s
- **AND** in the second case a task told to run `uname -s`, which is outside the patterns, gets the deny error, asks with a `needsAccess` question naming `uname`, and finishes as the answer says. Under `deny` the model continues (P-deny.jsonl), where an auto-rejected `ask` would end the run (P-ask.jsonl)
- **AND** without the variable, or without `opencode` on PATH, the file is skipped; the latter warns naming the binary
