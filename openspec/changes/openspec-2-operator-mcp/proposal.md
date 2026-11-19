## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. In `operator-mcp`, 11 of the 17 requirements are over the limit (11847 characters and 88 occurrences of SHALL or MUST in all). This change splits each the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (ORC-139, task ORC-161).

## What Changes

- Eleven requirements are MODIFIED. Each keeps its header and every scenario, names and text unchanged. Its description is cut to one behavior of at most 500 characters:

  | Requirement | Before | After | Scenarios kept |
  |---|---|---|---|
  | Operator MCP server | 3056 | 238 | 15 |
  | Tool set | 597 | 432 | 1 |
  | Wait tool | 1029 | 439 | 4 |
  | Start tool | 1983 | 290 | 10 |
  | Review tool | 544 | 436 | 2 |
  | Worker tools | 922 | 282 | 4 |
  | Configure tool | 971 | 420 | 6 |
  | Configure and start tools: limit keys | 631 | 421 | 3 |
  | Wait digest: profileHeld | 634 | 489 | 2 |
  | Configure tool: endLive | 551 | 335 | 4 |
  | Start tool turns the profile hold on | 929 | 430 | 2 |

- 30 requirements are ADDED, one for each behavior moved out of those descriptions. Each has a name `operator-mcp` does not have yet, a description of at most 500 characters (the longest is 498), and at least one scenario of its own with a WHEN and a THEN step.
- No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped: the eleven original descriptions hold 88; the cut descriptions hold 32 and the ADDED descriptions 57 (89: the split of "Worker tools" sentence 1 turns "each taking" into "SHALL each take").
- The other six requirements of `operator-mcp` are not touched.

Below, every sentence of each original description is listed, numbered from 1 in the order of the description: it either stays in the MODIFIED description or moves to exactly one ADDED requirement (a split sentence: each of its parts to one place). "Unchanged" means word for word. Where a reference is made explicit, the old and new text are both given.

### Deviations

Three sentences are longer than 500 characters on their own. The operator answered the question about them (launch block seq 2) with A, with one change to the split of "Operator MCP server" sentence 3, and made the rule general: when semicolons and list items leave a part over 500 characters, split at another clause joint, changing only the words at the joint (repeat the subject, turn a participle into SHALL plus a verb), and keep any exception explicit in the part it qualifies, so that each part is right when read alone.

- "Operator MCP server" sentence 9 (737 characters) is split at its semicolon: the second clause starts with "it", made explicit as "The server" (498 characters).
- "Operator MCP server" sentence 3 (682 characters) is split at its two semicolons. Its first clause is still 527 characters, so it is split once more at ", except that". The head keeps the exception in a few words, as the operator asked: it ends ", except a `repo` inside a linked worktree." The tail's "a path" becomes "A `repo`" and is the description of **Repo argument from a linked worktree**; every other word is kept.
- "Worker tools" sentence 1 (501 characters) has no semicolon. It is cut at ", each taking": the head stays in the MODIFIED description with a period; the tail moves to **Token-scoped worker tools** with the subject "The token-scoped tools `launch_heartbeat`, `launch_report`, `launch_block`, `launch_inbox`, and `launch_log`" repeated, and the participles "each taking ... and forwarding to" turned into "SHALL each take ... and forward to".

### Moved sentences: "Operator MCP server"

- Stay in the MODIFIED description, unchanged: sentences 1, 2, 10.
- Sentence 3, split (see Deviations): "Every tool SHALL take an optional `repo` argument, an absolute path inside the session's project, which the server SHALL resolve to the real path of its git top level, except that a path inside a linked worktree (one made by `git worktree add`, such as a launch worktree, whose git directory is not its repository's common git directory) SHALL resolve to the real path of the main working tree of its repository, the directory above `git rev-parse --git-common-dir`, so that a launch worktree's path names the run it belongs to; the server SHALL never forward `repo` to the daemon; a relative `repo`, or one not inside a git repository, SHALL fail the call with a message saying so."
  - Part moves to **Repo argument resolution**: "Every tool SHALL take an optional `repo` argument, an absolute path inside the session's project, which the server SHALL resolve to the real path of its git top level, except a `repo` inside a linked worktree."
  - Part moves to **Repo argument from a linked worktree**: "A `repo` inside a linked worktree (one made by `git worktree add`, such as a launch worktree, whose git directory is not its repository's common git directory) SHALL resolve to the real path of the main working tree of its repository, the directory above `git rev-parse --git-common-dir`, so that a launch worktree's path names the run it belongs to."
  - Part moves to **Repo argument resolution**: "The server SHALL never forward `repo` to the daemon."
  - Part moves to **Repo argument resolution**: "A relative `repo`, or one not inside a git repository, SHALL fail the call with a message saying so."
- Sentence 4 moves to **Run directory resolution order**, unchanged: "The server SHALL resolve the run directory from the call's `repo`, else the `repo` the session last passed to a tool other than a worker tool, else a `--repo` argument, the `ORCH_REPO` environment variable, or the git top level of its working directory, in that order."
- Sentence 5 moves to **Worker tools bind their repo per call**, unchanged: "The worker tools (`claim`, `release`, `launch_heartbeat`, `launch_report`, `launch_block`, `launch_inbox`, and `launch_log`) SHALL use a `repo` they are passed for that call only and SHALL never change the session's repository; a worker tool's call that fails, whatever the reason, SHALL leave the session's repository as it was."
- Sentence 6 moves to **Repository bound once per call**, with its references made explicit: "The server SHALL make that choice once per call, before the tool's handler runs, and every request the call forwards SHALL go to the daemon of the repository chosen; because the server handles calls concurrently, a call that names another `repo` while it is in flight SHALL NOT change the daemon it reaches." becomes "The server SHALL make the choice of the call's repository once per call, before the tool's handler runs, and every request the call forwards SHALL go to the daemon of the repository chosen; because the server handles calls concurrently, a call that names another `repo` while it is in flight SHALL NOT change the daemon it reaches."
- Sentence 7 moves to **Run directory resolution order**, unchanged: "When none of them yields a repository, the tool SHALL fail with a message naming the `repo` argument rather than resolve to another place, and the `repo` argument's description SHALL say so."
- Sentence 8 moves to **Daemon revived on demand**, with its references made explicit: "Before forwarding any tool other than `start`, `stop`, and `runs` it SHALL revive the daemon on demand as the operator-control specification defines, so that an idle exit or a crash is invisible to the session, and SHALL refuse only after an explicit stop or for a repository with no run directory." becomes "Before forwarding any tool other than `start`, `stop`, and `runs` the server SHALL revive the daemon on demand as the operator-control specification defines, so that an idle exit or a crash is invisible to the session, and SHALL refuse only after an explicit stop or for a repository with no run directory."
- Sentence 9, split (see Deviations): "On its first successful contact with a daemon, and again whenever that daemon's pid changes, it SHALL register an attachment `{ id, pids }` with its own pid followed by its ancestor chain, walked with `ps -o ppid=` up to six levels within 300 ms; it SHALL send the attachment id in the `x-orch-attachment` header of every request it forwards, SHALL register again when a response carries `x-orch-attachment: unknown` (the operation stands and is not retried) and before forwarding any `claim`, SHALL carry the attachment on every `claim`, and SHALL end the attachment on every daemon it registered with, with reason `sessionEnded`, when its transport closes or it receives `SIGTERM`, `SIGINT`, or `SIGHUP`, waiting at most half a second."
  - Part moves to **Attachment registration**: "On its first successful contact with a daemon, and again whenever that daemon's pid changes, the server SHALL register an attachment `{ id, pids }` with its own pid followed by its ancestor chain, walked with `ps -o ppid=` up to six levels within 300 ms."
  - Part moves to **Attachment carried and ended**: "The server SHALL send the attachment id in the `x-orch-attachment` header of every request it forwards, SHALL register again when a response carries `x-orch-attachment: unknown` (the operation stands and is not retried) and before forwarding any `claim`, SHALL carry the attachment on every `claim`, and SHALL end the attachment on every daemon it registered with, with reason `sessionEnded`, when its transport closes or it receives `SIGTERM`, `SIGINT`, or `SIGHUP`, waiting at most half a second."

### Moved sentences: "Tool set"

- Stay in the MODIFIED description, unchanged: sentences 1, 2, 3.
- Sentence 4 moves to **Tool name list**, unchanged: "The implementation SHALL keep one list of tool names that the tests compare against the server's advertised tools, so that adding a tool is one change in one place."

### Moved sentences: "Wait tool"

- Stay in the MODIFIED description, unchanged: sentences 1, 2, 3.
- Sentence 4 moves to **Wait until filter**, with its references made explicit: "When `until` is set it SHALL return early only when the digest satisfies the filter, otherwise at the timeout." becomes "When `until` is set `wait` SHALL return early only when the digest satisfies the filter, otherwise at the timeout."
- Sentence 5 moves to **Wait polls keep their daemon**, unchanged: "Every poll a `wait` makes SHALL go to the daemon of the repository the call was bound to, for the whole duration of the call."
- Sentence 6 moves to **Wait submitted events come cut**, with its references made explicit: "Every poll SHALL send `cutSubmitted=true`, so that a milestone's submitted transition event comes with the cuts of the review index and an `omitted` list; the tool SHALL take no argument for it, and its description SHALL say that a submitted event comes cut and that `review` holds the rest." becomes "Every poll of `wait` SHALL send `cutSubmitted=true`, so that a milestone's submitted transition event comes with the cuts of the review index and an `omitted` list; the `wait` tool SHALL take no argument for it, and its description SHALL say that a submitted event comes cut and that `review` holds the rest."
- Sentence 7 moves to **Wait submitted events come cut**, with its references made explicit: "A daemon that ignores the parameter returns the event whole." becomes "A daemon that ignores the `cutSubmitted` parameter returns the event whole."

### Moved sentences: "Start tool"

- Stay in the MODIFIED description, unchanged: sentences 1, 2, 12.
- Sentence 3 moves to **Start mode default for a spawned daemon**, with its references made explicit: "When it spawns the daemon and no `mode` argument is given, it SHALL pass `--default-mode pull`, so that a run started from the plugin executes its launches through session workers unless the repository's `orchestrator.yaml` sets `runner.mode` or the run already holds a mode override." becomes "When `start` spawns the daemon and no `mode` argument is given, `start` SHALL pass `--default-mode pull`, so that a run started from the plugin executes its launches through session workers unless the repository's `orchestrator.yaml` sets `runner.mode` or the run already holds a mode override."
- Sentence 4 moves to **Start mode default for a codex run**, with its references made explicit: "When the runner kind for the start is `codex`, it SHALL pass `--default-mode spawn` instead, because pull-mode workers are the session's Claude subagents and claim only `claude-code` launches." becomes "When the runner kind for the start is `codex`, `start` SHALL pass `--default-mode spawn` instead of `--default-mode pull`, because pull-mode workers are the session's Claude subagents and claim only `claude-code` launches."
- Sentence 5 moves to **Start runner kind in force**, unchanged: "The runner kind for the start is the `runnerKind` argument; without one it is the kind already in force for the run: the run's stored override, as recorded in `config.json`, else `runner.kind` in `orchestrator.yaml`, else `claude-code`."
- Sentence 6 moves to **Start runner kind in force**, with its references made explicit: "The tool SHALL NOT open the store to find it." becomes "The `start` tool SHALL NOT open the store to find the runner kind for the start."
- Sentence 7 moves to **Start mode default for a codex run**, unchanged: "When the codex default applied, the result SHALL carry a `modeNote` saying so."
- Sentence 8 moves to **Start warns about a codex run in pull mode**, unchanged: "When the kind in force after the start is `codex` and the mode in force is `pull`, the `modeNote` SHALL warn that codex launches stay parked."
- Sentence 9 moves to **Start mode default for a spawned daemon**, unchanged: "When the daemon is already running and no `mode` is given, the mode SHALL be left as it is."
- Sentence 10 moves to **Start configuration arguments**, with its references made explicit: "It SHALL accept the optional configuration arguments `checkCommand`, `integrationBranch`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort` (any level of either kind), `codex` (`{ model, effort }`), `sandbox` (the key `codex.sandbox`), and `commit` (the commit policy of `runnerKind`, else of the kind in force) beside `mode`." becomes "`start` SHALL accept the optional configuration arguments `checkCommand`, `integrationBranch`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort` (any level of either kind), `codex` (`{ model, effort }`), `sandbox` (the key `codex.sandbox`), and `commit` (the commit policy of `runnerKind`, else of the kind in force) beside `mode`."
- Sentence 11 moves to **Start configuration result**, with its references made explicit: "It SHALL pass them to the lifecycle `start` as one override document and return the `config` block with value and source per key, the `toolchain` record, `needsConfig`, and any `rejected` keys, so that the session can report what was detected and set what was not." becomes "`start` SHALL pass the configuration arguments to the lifecycle `start` as one override document and return the `config` block with value and source per key, the `toolchain` record, `needsConfig`, and any `rejected` keys, so that the session can report what was detected and set what was not."

### Moved sentences: "Review tool"

- Stay in the MODIFIED description, unchanged: sentences 1.
- Sentence 2 moves to **Review tool description**, with its references made explicit: "Its description SHALL name `task`, `full` and `omitted`, and say that `full` can be too large for a client." becomes "The `review` tool's description SHALL name `task`, `full` and `omitted`, and say that `full` can be too large for a client."

### Moved sentences: "Worker tools"

- Sentence 1, split (see Deviations): "The server SHALL additionally expose `claim` with `{ workerId, taskId?, access? }`, forwarding its attachment in the body, `release` with `{ launchId, reason, keep? }`, and the token-scoped tools `launch_heartbeat`, `launch_report`, `launch_block`, `launch_inbox`, and `launch_log`, each taking `{ launchId, token, ...body }` and forwarding to the agent API route of the same name with the token as the bearer, so that a session subagent, which cannot run the per-agent MCP shim, can act as the agent."
  - Part moves to **Token-scoped worker tools**: "The token-scoped tools `launch_heartbeat`, `launch_report`, `launch_block`, `launch_inbox`, and `launch_log` SHALL each take `{ launchId, token, ...body }` and forward to the agent API route of the same name with the token as the bearer, so that a session subagent, which cannot run the per-agent MCP shim, can act as the agent."
  - Part stays in the MODIFIED description: "The server SHALL additionally expose `claim` with `{ workerId, taskId?, access? }`, forwarding its attachment in the body, `release` with `{ launchId, reason, keep? }`, and the token-scoped tools `launch_heartbeat`, `launch_report`, `launch_block`, `launch_inbox`, and `launch_log`."
- Sentence 2 moves to **Launch block stays in the foreground**, unchanged: "`launch_block` SHALL stay a foreground call: it SHALL return the daemon's response when it arrives within at most ninety seconds and otherwise `{ pending: true, seq }`; the worker SHALL call it again with the same seq, and the daemon's replay rules SHALL return the answer once admitted."
- Sentence 3 moves to **Start mode argument**, unchanged: "`start` SHALL accept an optional `mode` of `spawn`, `pull`, or `mixed` and apply it to the run whether or not it spawned the daemon."

### Moved sentences: "Configure tool"

- Stay in the MODIFIED description, unchanged: sentences 1.
- Sentence 2 moves to **Configure forwards to the configuration route**, with its references made explicit: "It SHALL fold `sandbox` and `commit` into the per-kind blocks, forward to `PUT /v1/config`, and return the route's response as a single JSON text block, including a 400 or 409 unchanged." becomes "`configure` SHALL fold `sandbox` and `commit` into the per-kind blocks, forward to `PUT /v1/config`, and return the route's response as a single JSON text block, including a 400 or 409 unchanged."
- Sentence 3 moves to **Configure, status and wait descriptions**, with its references made explicit: "Its description SHALL name both kinds' defaults and SHALL say that `ultra` is codex-only." becomes "The `configure` description SHALL name both kinds' defaults and SHALL say that `ultra` is codex-only."
- Sentence 4 moves to **Configure, status and wait descriptions**, unchanged: "The `status` tool description SHALL mention the `config`, `toolchain`, and `needsConfig` facts, `runnerKind`, the codex leaves, `claimableByKind`, and the per-launch `runner`, `model`, and `effort`, and the `wait` tool description SHALL mention `needsConfig` in the digest."

### Moved sentences: "Configure and start tools: limit keys"

- Stay in the MODIFIED description, unchanged: sentences 1, 2, 3.
- Sentence 4 moves to **Configure description names the limit keys**, with its references made explicit: "The `configure` description SHALL name the keys and say that the values are milliseconds, that 0 disables a limit, that a change applies on the next tick, and that a null falls back to the file or the default." becomes "The `configure` description SHALL name the limit keys `budgets: { maxLaunchMs }` and `health: { stuckAfterMs, stuckFailAfterMs }` and say that the values are milliseconds, that 0 disables a limit, that a change applies on the next tick, and that a null falls back to the file or the default."

### Moved sentences: "Wait digest: profileHeld"

- Stay in the MODIFIED description, unchanged: sentences 1, 2, 3, 4, 6.
- Sentence 5 moves to **Held task writes no event**, unchanged: "No event SHALL be written when a task becomes held; a session learns of it from `status.profiles` and from the digest of its next `wait` return."

### Moved sentences: "Configure tool: endLive"

- Stay in the MODIFIED description, unchanged: sentences 1, 2, 4.
- Sentence 3 moves to **Configure description names endLive**, unchanged: "The `configure` description SHALL say that a change that would end a live launch is refused without `endLive`, that the 409 lists the launches under `wouldEnd`, and that `endLive` is sent only when the user says so."

### Moved sentences: "Start tool turns the profile hold on"

- Stay in the MODIFIED description, unchanged: sentences 1, 3, 4.
- Sentence 2 moves to **Remote daemon keeps its own profile hold**, with its references made explicit: "The remote path (a remote `ORCH_URL`) SHALL NOT spawn and SHALL NOT change the hold; a remote daemon gets the hold only from its own file." becomes "The remote path (a remote `ORCH_URL`) SHALL NOT spawn and SHALL NOT change the profile hold; a remote daemon gets the profile hold only from its own file."
- Sentence 5 moves to **Start result reports the profile hold**, unchanged: "The `start` result SHALL carry `confirmProfile`."
- Sentence 6 moves to **Descriptions name the profile hold**, unchanged: "The `start` description SHALL name `runner.confirmProfile` and `confirmProfile` and say that `orchestrator.yaml` wins; the `status` description SHALL name `profiles` and `runner.confirmProfile`; the `wait` description SHALL name `profileHeld`."
- Sentence 7 moves to **Start result reports the profile hold**, with its references made explicit: "There SHALL be no `start` argument that forces or clears the hold." becomes "There SHALL be no `start` argument that forces or clears the profile hold."

### Where the new scenarios come from

Each new scenario states behavior the code has at the change's base commit (9890215 after the rebase; none of the files named here changed since e0f3aa6):

- Repo argument resolution: `src/operator/mcp-server.ts` (`OperatorClient.useRepo`: `repo must be an absolute path`; the `tool` wrapper strips `repo` before the handler).
- Repo argument from a linked worktree: `src/runs/runDir.ts` (`repoOfWorktree`), `test/slice/operator-mcp.test.ts` ("a launch worktree as repo reaches its repository's daemon, ...").
- Run directory resolution order: `src/operator/mcp-server.ts` (`OperatorClient.repo`), `src/runs/runDir.ts` (`resolveRepoPath`: `--repo` before `ORCH_REPO`).
- Worker tools bind their repo per call: `src/operator/mcp-server.ts` (`WORKER_TOOL_NAMES`, `useRepo` with `remember: false`), `test/slice/operator-mcp.test.ts` ("... a worker tool's repo does not move the session").
- Repository bound once per call: `src/operator/mcp-server.ts` (the `tool` wrapper binds `client.at(bound)`; the `configure` handler's `GET /v1/config` and `PUT /v1/config` both go through it).
- Daemon revived on demand: `src/operator/mcp-server.ts` (the `runs` handler calls `listRuns` and never `OperatorClient.url`), `test/slice/operator-mcp.test.ts` ("revives the daemon after an idle exit and refuses after a stop").
- Attachment registration: `src/operator/mcp-server.ts` (`ensureAttached`, `register`), `src/runs/ancestry.ts` (`ancestorPids`).
- Attachment carried and ended: `src/operator/mcp-server.ts` (`detach` with a 500 ms timeout, the `SIGTERM`/`SIGINT`/`SIGHUP` handlers).
- Tool name list: `test/slice/operator-mcp.test.ts` and `test/slice/worker-tools.test.ts` (the listed names equal `TOOL_NAMES`).
- Wait until filter: `src/operator/mcp-server.ts` (`digestSatisfies`, `OperatorClient.wait` returning `matched: false` at the deadline).
- Wait polls keep their daemon: `src/operator/mcp-server.ts` (`OperatorClient.wait` polls in slices through `call(bound, ...)`), `test/slice/operator-mcp.test.ts` ("a wait bound to one repo keeps polling its daemon while a call names another repo").
- Wait submitted events come cut: `src/operator/mcp-server.ts` (the `wait` input schema; the poll URL carries `cutSubmitted=true`).
- Start mode default for a spawned daemon, Start mode default for a codex run, Start warns about a codex run in pull mode: `src/operator/mcp-server.ts` (`defaultModeFor`, `modeNoteFor`), `src/runs/lifecycle.ts` (`--mode` / `--default-mode`), `test/slice/operator-mcp.test.ts` ("defaults a plugin-started codex run to spawn, ...").
- Start runner kind in force: `src/operator/mcp-server.ts` (`kindOfRun`: `config.json`, then `orchestrator.yaml`, then `claude-code`).
- Start configuration arguments: `src/runs/resolve.ts` (`foldRunnerArgs`), `test/slice/operator-mcp.test.ts` ("... binds sandbox and commit to codex": `config.codex.sandbox`).
- Start configuration result: `src/runs/lifecycle.ts` (`applyOverrides`: a start-only key on a running daemon goes under `rejected`; `configFields`).
- Review tool description, Configure, status and wait descriptions, Configure description names the limit keys, Configure description names endLive, Descriptions name the profile hold: `src/operator/mcp-server.ts` (the tool descriptions), `test/slice/operator-mcp.test.ts` ("drives a run end to end over stdio: ...", its tool-list assertions).
- Token-scoped worker tools: `src/operator/mcp-server.ts` (`forwardLaunch`: `GET` for `inbox`, `authorization: Bearer <token>`), `test/slice/worker-tools.test.ts`.
- Launch block stays in the foreground, Start mode argument: `test/slice/worker-tools.test.ts` ("a session acts as the worker: ..., mode switch"), `src/runs/lifecycle.ts` (`--mode`).
- Configure forwards to the configuration route: `src/operator/mcp-server.ts` (the `configure` handler), `src/runs/resolve.ts` (`foldRunnerArgs`: `commit` into the block of `runnerKind`).
- Held task writes no event: `src/loop/orchestrator.ts` (`profiles` and `profileHeld` are computed, not recorded), `test/slice/profile-hold.test.ts` ("criterion 14: ...").
- Remote daemon keeps its own profile hold: `src/runs/lifecycle.ts` (`remoteDaemonUrl`, `reviveDaemon`: an unreachable remote daemon is reported, never spawned), `src/operator/mcp-server.ts` (`OperatorClient.url`).
- Start result reports the profile hold: `test/slice/operator-mcp.test.ts` ("a run started through the start tool holds a task on default worker values until configure sets them"), `src/operator/mcp-server.ts` (the `start` input schema).

## Capabilities

### New Capabilities

### Modified Capabilities

- `operator-mcp`: eleven long requirements are split; 30 requirements are added from their descriptions.

## Impact

Spec text only. No code, test or other spec changes.
