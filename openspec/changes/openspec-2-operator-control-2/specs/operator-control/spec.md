## MODIFIED Requirements

### Requirement: Exit record
On every graceful exit, whether by the `shutdown` route, by signal, or by idle exit, the daemon SHALL write `exit: { at, reason, reap, digest, by?, unflushedBatches?, storeClosed?, rejected? }` into `daemon.json` after the orchestrator has stopped and before the process ends. `reason` is `stop`, `signal`, or `idle`. `digest` is the event-stream digest taken before the store closes. `by`, present for a `stop`, names the caller as recorded by the `shutdown` route.

#### Scenario: Stop records the reason
- **WHEN** the daemon is stopped through the `shutdown` route with `reap` false
- **THEN** `daemon.json` carries `exit` with reason `stop`, `reap` false, the digest, and `by` with the caller's remote address, and no `unflushedBatches` or `storeClosed`

#### Scenario: Crash leaves no record
- **WHEN** the daemon is killed with SIGKILL
- **THEN** `runs` lists the run as not alive with no exit record

#### Scenario: Restart clears the record
- **WHEN** a daemon that exited idle is started again
- **THEN** `daemon.json` has no `exit` while it runs

#### Scenario: Exit that lost batches
- **WHEN** the database session stops answering, a write is committed, and the daemon receives SIGTERM
- **THEN** the daemon exits 1, and `exit` carries reason `signal` and `unflushedBatches` equal to the count the daemon logged

#### Scenario: Revival refusal names the loss
- **WHEN** the exit record is a `stop` with `unflushedBatches: 3` and an operation asks for revival
- **THEN** the refusal reads `stop, losing 3 unflushed batches`

### Requirement: Container mode
The daemon SHALL run as a long-lived foreground process. On SIGTERM or SIGINT it SHALL stop the tick loop, finish the in-flight tick and verifier job, close the API server and its open connections, write the exit record with reason `signal`, and exit 0. `daemon.idleExitMs: 0` keeps the daemon running however long it is idle (see "Idle exit").

#### Scenario: SIGTERM mid-check
- **WHEN** the daemon receives SIGTERM while a verifier job is `checking`
- **THEN** the job is published, the server closes, `daemon.json` carries `exit` with reason `signal`, and the process exits 0 within ten seconds

#### Scenario: Never idle when disabled
- **WHEN** `daemon.idleExitMs` is 0 and the daemon is quiescent past a short window
- **THEN** it is still alive and answering

#### Scenario: Remote URL unreachable
- **WHEN** `ORCH_URL` is `http://orchestrator.orch.svc:8080`, nothing answers there, and an operation would revive the daemon
- **THEN** the operation fails naming that URL as unreachable, and no local daemon is spawned

#### Scenario: Loopback URL still revives
- **WHEN** `ORCH_URL` is a loopback URL whose daemon exited idle and an operation needs it
- **THEN** a local daemon is spawned as before

#### Scenario: JSON logs
- **WHEN** the daemon runs with `ORCH_LOG_FORMAT=json`
- **THEN** every stderr line parses as a JSON object with `ts`, `level`, and `msg` first and the data fields after, and the text format is unchanged without the variable

### Requirement: Session attachments
The daemon SHALL expose `POST /v1/attachments` with `{ id, pids }`, where `pids` is the registering process's own pid followed by its ancestor pids up to six levels, stopping before pid 1, recording the attachment durably and appending `attachment.started` on first sight (registering a live attachment again SHALL refresh its chain).

#### Scenario: Dead attachment releases its launches
- **WHEN** a worker claimed T2 through an attachment whose first pid has since died
- **THEN** the next reconcile releases T2's launch with `keep`, T2 is `unstarted` with `attempts` unchanged, and the attachment is gone from `status`

#### Scenario: Session end by ancestry
- **WHEN** `POST /v1/attachments/ended` names a pid that is in an attachment's chain but is neither its own pid nor its parent, as the session process is above the launcher and `npx`
- **THEN** the response is immediate, the attachment is recorded as ended, and the next reconcile releases its launch with `keep`

#### Scenario: Unknown attachment flagged
- **WHEN** `status` is called with `x-orch-attachment` naming an attachment that has ended
- **THEN** the response is the current status and carries the header `x-orch-attachment: unknown`

#### Scenario: Attachment without launches
- **WHEN** an attachment that holds no launch ends
- **THEN** nothing is released and the attachment is removed

#### Scenario: OpenCode session end by stdio close
- **WHEN** an OpenCode session ends whose operator server holds an attachment with a claimed launch; OpenCode has no session end event, so no hook posts to `POST /v1/attachments/ended`
- **THEN** OpenCode closes the server's stdio, the server posts the end of its own attachment with reason `sessionEnded`, and the next reconcile releases the launch with `keep` and `attempts` unchanged; were the server killed instead, its dead first pid ends the attachment at the next reconcile

#### Scenario: Codex session end by ancestry
- **WHEN** a Codex SessionEnd hook posts `{ pids, reason: "other" }`, where its second pid is the codex process and an attachment's chain is the operator server, its launcher, and that codex process
- **THEN** the attachment is recorded as ended with reason `other`, and the next reconcile releases its launch with `keep` and `attempts` unchanged

#### Scenario: Nested session end leaves the outer session attached
- **WHEN** an attachment's chain is `[S, L, C, T, 1]` (operator server, launcher, session, terminal) and it holds a claimed launch, and a session nested under a shell inside C ends, so its hook posts `[H, N, B, C, T]` (hook, nested session, shell, C, T)
- **THEN** the attachment stays live and the launch stays claimed; a post of `[H, C, T]` or `[H, P, C, T]` ends it and the next reconcile releases the launch with `keep` and `attempts` unchanged

#### Scenario: Far or init pids end nothing
- **WHEN** `POST /v1/attachments/ended` posts a chain whose only pid shared with an attachment's chain is further up than its third position, or is pid 1
- **THEN** the response lists no ended attachment and the attachment stays live

### Requirement: Configuration route
The daemon SHALL expose `GET /v1/config`, returning the resolved configuration with value and source per key, the `toolchain` detection record, the overrides in force, and `needsConfig`. The CLI SHALL expose `orchestrator-ctl config`. Without flags it SHALL print the block, including `runnerKind` and the `claude`, `codex`, and `opencode` leaves with their sources.

#### Scenario: Select OpenCode from the CLI
- **WHEN** `orchestrator-ctl config --runner-kind opencode --permission allow --data-dir launch` is run, then `orchestrator-ctl config --clear opencode.permission`, then `orchestrator-ctl config --commit daemon --runner-kind opencode`
- **THEN** the bodies sent are `{ runnerKind: "opencode", opencode: { permission: "allow", dataDir: "launch" } }`, `{ opencode: { permission: null } }`, and `{ runnerKind: "opencode", opencode: { commit: "daemon" } }`

#### Scenario: Mistyped data-dir leaf with a daemon URL
- **WHEN** `orchestrator-ctl --url X config --data-dir lanch` is run, or `orchestrator-ctl config --data-dir lanch` with `ORCH_URL` set
- **THEN** the CLI exits non-zero with a message naming `opencode.dataDir`, the values `shared` and `launch`, and the store location, and no request is sent

#### Scenario: Data-dir names the store without a daemon URL
- **WHEN** `orchestrator-ctl config --data-dir <path>` is run with neither `--url` nor `ORCH_URL`
- **THEN** the daemon URL is read from the store under `<path>` and the configuration block is printed

#### Scenario: OpenCode leaves on the configure tool
- **WHEN** the `configure` tool is called with `opencode: { model: "opencode/big-pickle" }`, and then with `runnerKind: "opencode"` and `effort: "ultra"`
- **THEN** the first sets `opencode.model` with source `argument`, and the second is refused with 400 naming `effort` and `opencode`

#### Scenario: Set the check command
- **WHEN** `PUT /v1/config` carries `{ checkCommand: "npm test" }` while it was unresolved
- **THEN** the response lists `checkCommand` under `applied` with source `argument`, the event log holds `operator.config` with the patch, and `needsConfig` is empty

#### Scenario: Show the configuration
- **WHEN** `orchestrator-ctl config` is run without flags
- **THEN** it prints every key with its value and source, the toolchain record, and `needsConfig`

#### Scenario: Add a tool rule from the CLI
- **WHEN** `orchestrator-ctl config --allow "Bash(docker:*)"` is run
- **THEN** the allow list's `argument` part contains the rule and the next spawned launch is given it

#### Scenario: Mixed request applies nothing
- **WHEN** `PUT /v1/config` carries a valid `capacity` and an invalid `checkCommand` of empty string
- **THEN** the response is 400 naming `checkCommand` and the capacity is unchanged

#### Scenario: Set the effort from the CLI
- **WHEN** `orchestrator-ctl config --effort high` is run
- **THEN** `config.effort` is `{ value: "high", source: "argument" }` and the next prepared launch has `effort: high`

#### Scenario: Select Codex from the CLI
- **WHEN** `orchestrator-ctl config --runner-kind codex --sandbox danger-full-access` is run and then `orchestrator-ctl config` is run without flags
- **THEN** it prints `runnerKind` as `{ value: "codex", source: "argument" }`, `codex.sandbox` as `{ value: "danger-full-access", source: "argument" }`, and `codex.commit` as `{ value: "agent", source: "default" }`

#### Scenario: Commit policy binds to the kind in force
- **WHEN** the kind in force is `codex` and `orchestrator-ctl config --commit daemon` is run
- **THEN** `codex.commit` is `{ value: "daemon", source: "argument" }` and `claude.commit` is unchanged

#### Scenario: Clear and set in one call refused
- **WHEN** `orchestrator-ctl config --clear codex --sandbox read-only` is run
- **THEN** the CLI exits non-zero naming `codex` and `codex.sandbox`, and no `PUT /v1/config` is made

#### Scenario: OpenCode leaves fold under their namespace
- **WHEN** `--set opencode.model=opencode/big-pickle --set opencode.dataDir=launch` is given, and the fold receives `{ commit: "daemon", runnerKind: "opencode" }`, and separately `{ opencode: null, dataDir: "launch" }`
- **THEN** the first is `{ opencode: { model: "opencode/big-pickle", dataDir: "launch" } }`, the second `{ runnerKind: "opencode", opencode: { commit: "daemon" } }`, and the third is refused naming `opencode` and `opencode.dataDir`

### Requirement: Status report: configuration
`status` SHALL additionally report `config`, every configuration key as `{ value, source }` with nested blocks per leaf, `runnerKind` (the kind in force), `allowedTools` carrying `parts` and `applied`, `model` and `effort` (those of the kind in force) each carrying `applied`, and the `claude`, `codex`, and `opencode` leaves (among them `codex.sandbox`, `opencode.permission`, `opencode.dataDir`, and each kind's `commit`).

#### Scenario: Detected values visible
- **WHEN** `status` is requested in a Node repository started without a file
- **THEN** `config.checkCommand` is `{ value: "npm test", source: "detected" }`, `config.integrationBranch` names the detected branch with its source, `config.runnerKind` is `{ value: "claude-code", source: "default" }`, `config.model` is `{ value: "claude-opus-5-5", source: "default", applied: true }`, and `toolchain.kinds` contains `node`

#### Scenario: Unresolved check command visible
- **WHEN** the repository has no recognised manifest and no file
- **THEN** `status.needsConfig` and the digest's `needsConfig` both equal `["checkCommand"]`

#### Scenario: Reported before a graph is loaded
- **WHEN** `status` is requested before any graph has been imported
- **THEN** the response carries `config`, `toolchain`, and `needsConfig` alongside `error: graph not loaded`

#### Scenario: Live launch selection visible
- **WHEN** T2 is live from a task that declares `effort: high`
- **THEN** `status.liveLaunches` has T2 with `runner: "claude-code"`, `effort: "high"`, and `model: "claude-opus-5-5"`

#### Scenario: Codex leaves visible
- **WHEN** `status` is requested on a run whose file sets `runner.kind: codex`
- **THEN** `config.runnerKind` is `{ value: "codex", source: "file" }`, `config.model` is `gpt-6-astra`, and `config.codex.sandbox` and `config.codex.commit` carry their values and sources

#### Scenario: OpenCode leaves visible
- **WHEN** `status` is requested on a run started with `--set runnerKind=opencode`
- **THEN** `config.runnerKind` is `{ value: "opencode", source: "argument" }` and `config.opencode.model` is `{ value: "anthropic/claude-opus-5-5", source: "default" }`, with `opencode.effort`, `opencode.commit`, `opencode.permission`, and `opencode.dataDir` carrying their values and sources

### Requirement: Start arguments
The daemon lifecycle `start` SHALL accept `checkCommand`, `integrationBranch`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, `claude`, `codex`, and `opencode` beside `mode`. The result SHALL carry `config`, `toolchain`, and `needsConfig` as read from `GET /v1/config` after the daemon is healthy.

#### Scenario: OpenCode run defaults to spawn
- **WHEN** the `start` tool is called with `runnerKind: "opencode"` on a run with no configured mode
- **THEN** the result has `mode: "spawn"` and a `modeNote` naming `orchestrator-work --runner opencode`

#### Scenario: Model set at start
- **WHEN** `start` is called with `model: "claude-sonnet-5-5"` in a repository with no running daemon
- **THEN** the daemon is spawned with `--set model=claude-sonnet-5-5` and the result's `config.model` is `{ value: "claude-sonnet-5-5", source: "argument", applied: true }`

#### Scenario: Invalid effort refused before serving
- **WHEN** the daemon is started with `--set effort=huge`
- **THEN** it exits with a usage error naming `effort` and never serves

#### Scenario: Codex selected at start
- **WHEN** `orchestrator-ctl start --set runnerKind=codex --set codex.sandbox=read-only` is run in a repository with no running daemon
- **THEN** the result's `config.runnerKind` is `{ value: "codex", source: "argument" }` and `config.codex.sandbox` is `{ value: "read-only", source: "argument" }`

#### Scenario: Codex run names its work loop
- **WHEN** the `start` tool is called with `runnerKind: "codex"` on a run with no configured mode, and later with `mode: "pull"`
- **THEN** both results carry a `modeNote` naming `orchestrator-work --runner codex`

### Requirement: Requests from another origin are refused
The API server SHALL answer 403 to any request that carries an `Origin` header, whatever its value (`null` and an empty value included), on every bind, for every method and every path.

#### Scenario: Origin header on a loopback bind
- **WHEN** a daemon bound to `127.0.0.1` receives a `POST` with `Origin: https://example.com` and `Host: 127.0.0.1:<port>`
- **THEN** it answers 403 with `code: 'originHeader'` and the route handler does not run

#### Scenario: Origin header on a cluster bind
- **WHEN** a daemon bound to `0.0.0.0` receives a request with `Host: 10.1.2.3:8080` and an `Origin` header
- **THEN** it answers 403 with `code: 'originHeader'`

#### Scenario: Foreign Host on a loopback bind
- **WHEN** a daemon bound to `127.0.0.1` receives a request with `Host: evil.example:<port>`, `Host: localhost:<other port>`, or no `Host`
- **THEN** it answers 403 with `code: 'hostHeader'` and the route handler does not run

#### Scenario: localhost with the listening port
- **WHEN** a daemon bound to `127.0.0.1` receives a request with `Host: localhost:<port>` or `Host: LOCALHOST:<port>` and no `Origin`
- **THEN** the request reaches its route

#### Scenario: The apiBaseUrl host
- **WHEN** a daemon bound to `127.0.0.1` with `apiBaseUrl: https://orch.test` receives a request with `Host: orch.test` or `Host: orch.test:443`
- **THEN** the request reaches its route, and `Host: 127.0.0.1:<port>` still does, while `Host: orch.test:80` is answered 403 with `code: 'hostHeader'`

#### Scenario: No Host check on a cluster bind
- **WHEN** a daemon bound to `0.0.0.0` receives a request with `Host: 10.1.2.3:8080` and no `Origin`
- **THEN** the request reaches its route

#### Scenario: A kubelet probe is answered as before
- **WHEN** a daemon bound to `0.0.0.0` receives `GET /healthz` with `Host: <pod IP>:8080` and no `Origin`
- **THEN** it answers the probe as before

#### Scenario: A refused request does not count as activity
- **WHEN** a page polls a route with an `Origin` header
- **THEN** each request is answered 403 before it is counted as activity, so it does not keep the daemon from its idle exit

### Requirement: Configuration route: limit keys
`PUT /v1/config` SHALL take `budgets: { maxLaunchMs }` and `health: { stuckAfterMs, stuckFailAfterMs }`, each leaf a value or null and each block a value or null, applying toolchain-discovery "Runtime limit overrides". A refusal SHALL be a 400 whose `key` is the dotted key (`budgets.maxLaunchMs`, `health.stuckAfterMs`, `health.stuckFailAfterMs`, or the unknown leaf). `applied` SHALL name the block, `budgets` or `health`.

#### Scenario: The spawn path takes the limit blocks
- **WHEN** `start` on a stopped run passes `budgets: { maxLaunchMs: 10800000 }` and `health: { stuckAfterMs: 0 }`
- **THEN** the spawned daemon's `GET /v1/config` gives both leaves with source `argument`

#### Scenario: A refusal at spawn is readable
- **WHEN** `start` on a stopped run with the default limits passes `health: { stuckFailAfterMs: 600000 }`
- **THEN** the call fails, and its error text ends with the refusal line, which holds 600000 and 900000

### Requirement: Configuration command: set flags
`orchestrator-ctl config` SHALL take `--set key=value` (repeatable) for every key `start --set` takes, including `budgets.maxLaunchMs`, `health.stuckAfterMs` and `health.stuckFailAfterMs`, parse it as `start` does, and merge it per leaf into the one `PUT /v1/config` built from the other flags. Different leaves of one block SHALL merge.

#### Scenario: A limit set and cleared from the CLI
- **WHEN** `orchestrator-ctl config --set budgets.maxLaunchMs=10800000` runs, then `orchestrator-ctl config --clear budgets.maxLaunchMs`
- **THEN** the override document is `{ budgets: { maxLaunchMs: 10800000 } }` after the first and empty after the second

#### Scenario: A leaf named twice
- **WHEN** `config --set capacity=3 --capacity 4`, or `config --clear budgets.maxLaunchMs --set budgets.maxLaunchMs=1`, runs
- **THEN** it fails before any request and the override document is unchanged

#### Scenario: Leaves of one block merge
- **WHEN** `config --set codex.model=gpt-6-pro --sandbox read-only` runs
- **THEN** the override document holds both leaves under `codex`

### Requirement: Status report: profiles
`status` SHALL carry `profiles`, listing every `unstarted` task node grouped into one entry per distinct `{ runner, model, effort, modelSource, effortSource }` (model-selection "Profile sources of a task"). Each entry SHALL carry `held` (a boolean), `missing` (a list holding `model`, `effort`, both or neither, in that order), `tasks` (the count) and `sample` (at most 5 task ids, in graph order).

#### Scenario: Profiles are grouped and ordered

- **WHEN** the first task of a graph has `model: claude-sonnet-5-5` and the next six have no selector, all `unstarted`
- **THEN** `profiles` has two entries: the first with `tasks: 1`, `modelSource: "task"` and `effortSource: "default"`; the second with `tasks: 6` and a `sample` of the first 5 of those ids in graph order

#### Scenario: A task that waits on a dependency is listed

- **WHEN** the profile hold is on and a task with no selector depends on a task that runs
- **THEN** `profiles` has an entry with `held: true` whose `sample` holds the waiting task

#### Scenario: Without a graph

- **WHEN** a daemon whose configuration sets `runner.confirmProfile: true` has no graph loaded
- **THEN** `GET /v1/status` answers with `runner.confirmProfile` true and `profiles` `[]`

### Requirement: Configuration route: a change that would end a live launch
`PUT /v1/config` SHALL refuse with 409 a patch that would end a live launch, unless the body holds `endLive: true` (or `"true"`). A patch would end a launch when, for a `live` launch that holds the lease of a `running` task, the limits in force after the patch end it now and the limits in force before the patch do not.

#### Scenario: A lowered time budget is refused
- **WHEN** a launch of a running task is at 9000 ms elapsed under a budget of 10000 and `PUT /v1/config` carries `{ budgets: { maxLaunchMs: 5000 } }`
- **THEN** the answer is 409 with `wouldEnd: [{ taskId, launchId, limit: "budgets.maxLaunchMs", value: 5000, elapsedMs: 9000 }]` and an `error` naming the task and `endLive`, the stored document is unchanged, and the task is still `running` after a tick

#### Scenario: A lowered stuck fail limit is refused, a lowered flag limit is not
- **WHEN** a launch is idle for 2000 ms under limits 1000 and 3000 and the patch is `{ health: { stuckFailAfterMs: 1500 } }`
- **THEN** the answer is 409 with an entry `limit: "health.stuckFailAfterMs"`, `value: 1500` and `idleMs: 2000`; and the patch `{ health: { stuckAfterMs: 500 } }` for the same launch is applied

#### Scenario: The confirmed change
- **WHEN** the refused patch is sent again with `endLive: true`
- **THEN** it is answered 200 with `applied` holding `budgets`, the `operator.config` event holds `endLive: true`, the stored document holds no `endLive` key, and the next tick ends the launch with reason `timeBudget`

#### Scenario: Clearing a raise
- **WHEN** a boot budget of 10000 was raised to 0, a launch runs past 15000 ms, and the patch is `{ budgets: { maxLaunchMs: null } }` or `{ budgets: null }`
- **THEN** the answer is 409 naming that launch and the value in force stays 0; once the launch has submitted, the same clear is applied and the leaf is `{ value: 10000, source: "file" }`

#### Scenario: A limit switched on
- **WHEN** under a boot budget of 0 a launch is at 15000 ms elapsed and the patch is `{ budgets: { maxLaunchMs: 10000 } }`
- **THEN** the answer is 409 naming the launch

#### Scenario: The boundary follows the checks
- **WHEN** a launch's elapsed time equals the new `budgets.maxLaunchMs`, and its idle time equals the new `health.stuckFailAfterMs`
- **THEN** the first is listed in `wouldEnd` and the second is not

#### Scenario: Never refused
- **WHEN** the patch is `{ capacity: 3 }`, a raise, or leaves both ending limits in force unchanged, or the only launch past the new limits belongs to a `waiting` task
- **THEN** it is not refused for live launches

#### Scenario: Nothing applied on a refusal
- **WHEN** `{ capacity: 3, budgets: { maxLaunchMs: 5000 } }` is refused for a live launch
- **THEN** `capacity` keeps its value

#### Scenario: endLive alone
- **WHEN** the body is `{ endLive: true }`
- **THEN** the answer is 200 with `applied: []` and the stored document is unchanged and holds no `endLive` key

#### Scenario: The command line
- **WHEN** `orchestrator-ctl config --set budgets.maxLaunchMs=1` is run while a launch is live
- **THEN** the 409 with `wouldEnd` is relayed; with `--end-live` the change is applied

### Requirement: Profile hold default for a spawned daemon
The daemon SHALL take `--default-confirm-profile on|off`. Any other value SHALL end the start with an error that holds `--default-confirm-profile must be on or off, not <value>`, whatever the file says and before the store is opened.

#### Scenario: The default is adopted once and kept

- **WHEN** `startDaemon({ defaultConfirmProfile: true })` starts a fresh run whose file states no `runner.confirmProfile`
- **THEN** the result has `confirmProfile: true`
- **AND** while that daemon runs, `startDaemon({ mode: "pull" })` returns `started: false`, `mode: "pull"` and `confirmProfile: true`
- **AND** after a stop, `startDaemon()` without the option returns `confirmProfile: true`

#### Scenario: A stored off is not turned on by the default

- **WHEN** a run was first started with `defaultConfirmProfile: false` and is started again with `true`
- **THEN** the result has `confirmProfile: false`

#### Scenario: The file overwrites the stored choice

- **WHEN** a run whose stored choice is `on` is started after `runner: { confirmProfile: false }` is added to `orchestrator.yaml`
- **THEN** the result has `confirmProfile: false`, with or without `defaultConfirmProfile: true`
- **AND** after the line is removed again, a start with `defaultConfirmProfile: true` still returns `confirmProfile: false`

#### Scenario: A bad flag value

- **WHEN** the daemon is started with `--default-confirm-profile maybe`
- **THEN** the start fails with `--default-confirm-profile must be on or off, not maybe` before the store is opened

## ADDED Requirements

### Requirement: Exit record: written after the store closes
The record SHALL be written after the store's close returns. When the close reports lost batches, the record SHALL carry their count as `unflushedBatches`. When the sink rejected a batch, the record SHALL carry its cause as `rejected`.

#### Scenario: A batch rejected at shutdown
- **WHEN** the store's close at shutdown returns one lost batch and the batch the sink rejected
- **THEN** the exit record carries `unflushedBatches: 1` and `rejected` with the sink's error, and the record's description contains `a batch rejected: batch rejected by the sink`

### Requirement: Exit record: shutdown grace elapsed
When the shutdown grace period elapses before the close returns, the record SHALL carry `storeClosed: false` and `unflushedBatches` set to the pending count read before the record is written, even when that count is 0.

#### Scenario: Grace elapsed with nothing pending
- **WHEN** the shutdown grace period elapses before the store's close returns and no batch is pending
- **THEN** the exit record carries `storeClosed: false` and `unflushedBatches: 0`, and it is not clean

### Requirement: Exit record: journal fatal during a shutdown
When the journal turns fatal after a shutdown began and before the close returns, the record SHALL carry `storeClosed: false` and the fatal condition's `unflushedBatches` before the daemon exits 1. A fatal condition with no shutdown under way leaves no record and reads as a crash.

#### Scenario: Fatal journal after SIGTERM
- **WHEN** the daemon has begun a shutdown on SIGTERM and the journal turns fatal with 2 unflushed batches before the store's close returns
- **THEN** `daemon.json` carries `exit` with `storeClosed: false` and `unflushedBatches: 2`, and the daemon exits 1

#### Scenario: Fatal journal with no shutdown
- **WHEN** the journal turns fatal while no shutdown is under way
- **THEN** the daemon exits 1 without writing `exit`, and the run reads as a crash

### Requirement: Exit record: clean record
A record without `unflushedBatches`, `storeClosed`, and `rejected` is clean. A clean record SHALL be written only after the store closed with nothing unflushed.

#### Scenario: Clean stop
- **WHEN** the daemon is stopped through the `shutdown` route and the store closes with nothing unflushed
- **THEN** the exit record has no `unflushedBatches`, `storeClosed`, or `rejected`, and it is clean

### Requirement: Exit record: start and crash
A daemon that starts SHALL write `daemon.json` without `exit`. A dead pid whose `daemon.json` has no `exit` SHALL be read as a crash. `runs` SHALL report, for every run whose daemon is not alive, the exit record or that none exists.

#### Scenario: Idle exit listed, then cleared by a revival
- **WHEN** the daemon exits idle, `runs` is called, and the run is then revived
- **THEN** `runs` lists the run as not alive with `exit.reason` `idle`, and the revived daemon's `daemon.json` has no `exit`

### Requirement: Exit record: revival refusal
The revival refusal after a `stop` SHALL name the caller when one was recorded, and SHALL name the lost batches when the record is not clean.

#### Scenario: Refusal names the caller
- **WHEN** the daemon was stopped through the `shutdown` route with `x-orch-attachment: a1`, and a revival is asked for
- **THEN** the revival is refused with a message containing `stop by attachment a1`

### Requirement: Container mode: shutdown deadline
When stopping on SIGTERM or SIGINT takes longer than 8 seconds the daemon SHALL write the exit record and exit 0 anyway; a check abandoned that way restarts from `queued` on the next start, as after a crash.

#### Scenario: Stop that overruns the deadline
- **WHEN** the daemon receives SIGTERM and its stop has not returned 8 seconds later
- **THEN** the daemon writes the exit record with reason `signal` and exits

### Requirement: Container mode: daemon files
The daemon SHALL write `daemon.pid` and `daemon.json` in its data directory itself, whether or not a client spawned it; in a container nothing reads them. The bind address, advertised URL, probes, image, and manifests a container needs are specified in specs/cluster-runtime.

#### Scenario: Files written without a spawning client
- **WHEN** the daemon is started in the foreground with no client spawning it
- **THEN** its data directory holds `daemon.pid` with the process's own pid, and `daemon.json`

### Requirement: Container mode: JSON log format
When `ORCH_LOG_FORMAT` is `json`, every line the daemon logs on stderr SHALL be one JSON object with `ts`, `level`, and `msg` first, followed by the data fields; a data field named `ts`, `level`, or `msg` is dropped. Any other value SHALL keep the text format.

#### Scenario: Data fields cannot replace the record keys
- **WHEN** the daemon logs `real` at level `warn` with data `{ msg: "fake", level: "x", other: 1 }` under `ORCH_LOG_FORMAT=json`
- **THEN** the line parses as `{ ts, level: "warn", msg: "real", other: 1 }`

#### Scenario: Text format for another value
- **WHEN** `ORCH_LOG_FORMAT` is `text` or unset
- **THEN** each stderr line is the text format: the timestamp, the level in capitals, the message, and the data as JSON

### Requirement: Container mode: remote daemon URL
When `ORCH_URL` names a host other than `localhost`, `*.localhost`, `127.0.0.0/8`, or `::1`, the client-side `start` and revival SHALL NOT spawn a local daemon: revival returns nothing to revive when the URL answers a probe and otherwise fails naming the URL as unreachable, and `start` refuses.

#### Scenario: Start refused for an unreachable remote URL
- **WHEN** `ORCH_URL` is `http://orchestrator.orch.invalid:8080` and nothing answers there, and `start` is called
- **THEN** `start` fails naming the URL as unreachable, and no `daemon.pid` or `daemon.json` is written in the run directory

### Requirement: Container mode: operator server on a remote daemon URL
The operator MCP server SHALL use an `ORCH_URL` that names a host other than `localhost`, `*.localhost`, `127.0.0.0/8`, or `::1` directly, without registering an attachment, since the pids it would register are not the daemon's.

#### Scenario: Remote daemon used as is
- **WHEN** `ORCH_URL` names `http://orchestrator.orch.svc:8080`, which answers a probe, and an operator tool is called
- **THEN** the call is sent to that URL without first registering an attachment there, and no local daemon is spawned

### Requirement: Session attachments: end by id
The daemon SHALL expose `POST /v1/attachments/:id/end` with `{ reason }`, recording the end. The end routes SHALL respond once the end is recorded, before any release.

#### Scenario: End an idle attachment by id
- **WHEN** an attachment `idle` that holds no launch is ended with `POST /v1/attachments/idle/end` and `{ reason: "bye" }`
- **THEN** the response is `{ ended: true }`, and after the next reconcile `status.attachments` is empty

### Requirement: Session attachments: end by ancestry
The daemon SHALL expose `POST /v1/attachments/ended` with `{ pids, reason }`, where `pids` is the posting hook's own pid followed by its ancestors, recording the end of every live attachment for which the nearest pid in `pids` that is also in the attachment's chain is the hook's parent or grandparent (`pids[1]` or `pids[2]`). pid 1 SHALL never match.

#### Scenario: End by the hook's parent
- **WHEN** an attachment's chain ends with pid 424242 and a hook posts `{ pids: [777777, 424242], reason: "clear" }`
- **THEN** the response lists the attachment under `ended`, and a post of `{ pids: [555555] }` before it ended nothing

#### Scenario: pid 1 shared
- **WHEN** a hook posts `[H, 1]`, where pid 1 is the only pid after the hook's own
- **THEN** no attachment is ended

### Requirement: Session attachments: a nested session stays attached
An attachment whose nearest shared pid is further up the posted chain, as for a session nested under a shell or another process inside the attachment's session, SHALL stay live.

#### Scenario: Shared pid in the fourth position
- **WHEN** an attachment's chain is `[S, L, C, T]` and a hook posts `[H, X, Y, T]`, whose only pid shared with the chain is T
- **THEN** the attachment stays live

### Requirement: Session attachments: attachment header
An operator request MAY carry the header `x-orch-attachment` naming the caller's attachment; when that id is not a live attachment the daemon SHALL still perform the operation and SHALL add the response header `x-orch-attachment: unknown`.

#### Scenario: Live attachment header
- **WHEN** `status` is called with `x-orch-attachment` naming a live attachment
- **THEN** the response is 200 and carries no `x-orch-attachment` header

### Requirement: Session attachments: reconcile releases
A claim MAY carry `attachment`, stored on the launch's worker record. At every reconcile the daemon SHALL end any attachment whose first pid is dead, SHALL release with `keep` and reason `sessionEnded` every live claimed launch whose worker carries an ended attachment, SHALL append `attachment.ended`, and SHALL remove the record.

#### Scenario: Claim through a dead attachment
- **WHEN** a worker claims T1 with `attachment: "dead"`, an attachment whose first pid is not alive, and a tick runs
- **THEN** the launch's worker record carries `attachment: "dead"`, the launch is ended as released, T1 has `attempts: 0` and a fresh claimable launch, and one `attachment.ended` event is appended

### Requirement: Session attachments: status
`status` SHALL report `attachments` as `[{ id, pids, since, launches }]` for live attachments.

#### Scenario: Launches listed by attachment
- **WHEN** a worker claims T1 through attachment `dead` before any reconcile
- **THEN** `status.attachments` is `[{ id: "dead", launches: [<T1's launch id>], ... }]`

### Requirement: Configuration route: PUT keys
The daemon SHALL expose `PUT /v1/config`, taking any of `checkCommand`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, `claude`, `codex`, and `opencode` (the per-kind leaves; `opencode` holds `model`, `effort`, `commit`, `command`, `permission`, and `dataDir`), each a value or null to clear, applying the runtime override rules of the toolchain-discovery specification.

#### Scenario: Keys cleared with null
- **WHEN** `PUT /v1/config` clears `allowedTools` and `capacity` with null, where the file sets `capacity: 4`
- **THEN** `applied` lists `allowedTools` and `capacity`, `capacity` is `{ value: 4, source: "file" }`, and the argument part of `allowedTools` is empty

### Requirement: Configuration route: PUT validation and recording
`PUT /v1/config` SHALL validate the whole body before applying anything, answer 400 naming an invalid key and 409 naming a start-only key, and otherwise record an `operator.config` event carrying the patch and the override document in one transaction, rewrite `config.json`, append `config.resolved`, wake the loop, and return the new `config` block with the keys it `applied`.

#### Scenario: Invalid value refused whole
- **WHEN** `PUT /v1/config` carries `{ effort: "huge" }` while the effort in force is `high`
- **THEN** the response is 400 with `key` `effort`, and the effort in force is still `high`

### Requirement: Configuration route: command key flags
`orchestrator-ctl config` SHALL set keys with `--check-command`, `--capacity`, `--allow <rule>` (repeatable), `--runner-command`, `--runner-kind <kind>`, `--model`, `--effort`, `--sandbox <mode>` (the key `codex.sandbox`), `--permission <derived|allow>` (the key `opencode.permission`), `--data-dir <shared|launch>` (the key `opencode.dataDir`), `--commit <agent|daemon>`, and `--clear <key>` (repeatable; a per-kind key such as `codex.sandbox` or `opencode.permission` clears one leaf).

#### Scenario: Several key flags in one call
- **WHEN** `orchestrator-ctl config --allow "Bash(make:*)" --allow "Bash(docker:*)" --capacity 3 --check-command "make check"` is run
- **THEN** the response has `capacity` `{ value: 3, source: "argument" }`, `checkCommand` `{ value: "make check", source: "argument" }`, and both rules in the argument part of `allowedTools`

### Requirement: Configuration route: command data-dir value
For `--data-dir`, on `config` a value of `shared` or `launch` SHALL be read as the leaf, and any other value SHALL keep naming the store location when no daemon URL is given. For `--data-dir`, when `--url` or `ORCH_URL` addresses the daemon, any other value SHALL be refused before anything is sent, with a message naming both meanings and the two accepted values.

#### Scenario: Leaf value with ORCH_URL set
- **WHEN** `ORCH_URL` addresses a daemon and `orchestrator-ctl config --data-dir lanch` is run, then `orchestrator-ctl config --data-dir launch`
- **THEN** the first exits non-zero naming `shared or launch` with no request sent, and the second sends one `PUT /v1/config`

### Requirement: Configuration route: command runner kind and commit policy
`--runner-kind` SHALL take `claude-code`, `codex`, or `opencode`. `--commit` SHALL set the commit policy of `--runner-kind` when it is given in the same call, else of the kind in force.

#### Scenario: Commit bound to the kind named in the call
- **WHEN** the kind in force is `codex` and `orchestrator-ctl config --runner-kind claude-code --commit daemon` is run
- **THEN** `runnerKind` is `{ value: "claude-code", source: "argument" }` and `claude.commit` is `{ value: "daemon", source: "argument" }`

### Requirement: Configuration route: a cleared key and its leaf in one call
A call that clears a key and sets a leaf under it (`--clear codex --sandbox read-only`, `--clear codex.sandbox --sandbox read-only`) SHALL be refused before anything is sent, naming both, and so SHALL `--clear runnerKind` together with `--commit` unless `--runner-kind` names the kind the policy binds to; the daemon refuses the same patch shapes.

#### Scenario: Clear runnerKind with commit refused
- **WHEN** `orchestrator-ctl config --clear runnerKind --commit daemon` is run without `--runner-kind`
- **THEN** the CLI exits non-zero with a message saying to name the kind with `--runner-kind`, and no `PUT /v1/config` is made

### Requirement: Configuration route: fold of the OpenCode arguments
The operator-surface fold (`foldRunnerArgs`) SHALL put `permission` and `dataDir` arguments under `opencode` and SHALL refuse them beside a cleared `opencode` or a cleared leaf of the same name, with the same message.

#### Scenario: Permission and dataDir folded
- **WHEN** the fold receives `{ dataDir: "launch", permission: "allow" }` with `claude-code` in force, and separately `{ opencode: { permission: null }, permission: "allow" }`
- **THEN** the first is `{ opencode: { permission: "allow", dataDir: "launch" } }`, and the second is refused with `opencode.permission is both cleared and set`

### Requirement: Configuration route: command usage names the kinds
The CLI usage SHALL name the three kinds and their default models and efforts (`claude-opus-5-5`, `gpt-6-astra`, and `anthropic/claude-opus-5-5`, all at `medium`) and SHALL say that `ultra` is codex-only.

#### Scenario: Kinds and defaults in the usage
- **WHEN** `orchestrator-ctl --help` is run
- **THEN** the usage contains `claude-opus-5-5 at medium`, `gpt-6-astra at medium`, `anthropic/claude-opus-5-5 at medium`, and `ultra is codex-only`

### Requirement: Configuration route: configure tool OpenCode arguments
The MCP `configure` tool SHALL take `opencode: { model, effort }`, `permission`, and `dataDir` beside the codex arguments, folded the same way, and SHALL forward the route's refusal of an effort the kind lacks (`ultra` for opencode), whose message names the kind.

#### Scenario: Permission cleared through the configure tool
- **WHEN** the `configure` tool is called with `permission: null` on a run whose `opencode.permission` was set to `allow`
- **THEN** `config.opencode.permission` is `{ value: "derived", source: "default" }`

### Requirement: Status report: toolchain and needsConfig
`status` SHALL additionally report `toolchain`, the detection record. `status` SHALL additionally report `needsConfig`, the keys whose value is unresolved. The event stream digest SHALL carry `needsConfig`.

#### Scenario: needsConfig cleared everywhere
- **WHEN** `checkCommand` is unresolved, and then `PUT /v1/config` sets it
- **THEN** `status.needsConfig` and the digest's `needsConfig` are `["checkCommand"]` before the change and the digest's `needsConfig` is `[]` after it

### Requirement: Status report: selection of each live launch
Each entry of `liveLaunches` SHALL carry the launch's `runner`, `model`, and `effort`.

#### Scenario: Run default and task selector side by side
- **WHEN** T1 runs with the run defaults and T2 with a task selector `model: claude-sonnet-5-5`, `effort: high`
- **THEN** `status.liveLaunches` has T1 with `runner: "claude-code"`, `model: "claude-opus-5-5"`, `effort: "medium"`, and T2 with `model: "claude-sonnet-5-5"`, `effort: "high"`

### Requirement: Status report: configuration without a graph
The configuration facts SHALL be present when no graph is loaded.

#### Scenario: Unresolved command before an import
- **WHEN** `checkCommand` is unresolved and `GET /v1/status` is called before any graph is imported
- **THEN** the body carries `needsConfig: ["checkCommand"]`, `config`, and `toolchain` beside `error: graph not loaded`

### Requirement: Start arguments: passed at spawn or through the route
When the daemon lifecycle `start` spawns the daemon it SHALL pass each as a `--set key=value` flag (a per-kind block as a JSON object), which the daemon stores as an override before resolving; when the daemon is already healthy it SHALL apply them through `PUT /v1/config` and SHALL report any key the route refused under `rejected` with the route's reason.

#### Scenario: Start-only key refused on a running daemon
- **WHEN** `start` passes `capacity: 4` and `integrationBranch: develop` to a daemon that is already healthy
- **THEN** the result has `started: false`, `applied: ["capacity"]`, and `rejected` holding `integrationBranch` with a reason naming `start-only`

### Requirement: Start arguments: command set flags
`orchestrator-ctl start` SHALL accept the same keys as repeatable `--set key=value` flags, the per-kind leaves as dotted keys (`claude.model`, `claude.effort`, `claude.commit`, `codex.model`, `codex.effort`, `codex.sandbox`, `codex.commit`, `codex.command`, `opencode.model`, `opencode.effort`, `opencode.commit`, `opencode.command`, `opencode.permission`, `opencode.dataDir`), and the daemon's `--set` SHALL reject an unknown key or an invalid value with a usage error before serving.

#### Scenario: Dotted keys folded under their kind
- **WHEN** `--set runnerKind=codex --set codex.model=gpt-6-pro --set codex.sandbox=read-only --set effort=ultra` is parsed
- **THEN** the overrides are `{ runnerKind: "codex", codex: { model: "gpt-6-pro", sandbox: "read-only", effort: "ultra" } }`

### Requirement: Start arguments: daemon usage
The daemon's usage SHALL list the keys `orchestrator-ctl start` takes as `--set` flags.

#### Scenario: Limit keys in the daemon usage
- **WHEN** the daemon's usage is read
- **THEN** it names `--set key=value`, `budgets.maxLaunchMs`, `health.stuckAfterMs`, and `health.stuckFailAfterMs`

### Requirement: Start arguments: start tool runner arguments
The MCP `start` tool SHALL take `runnerKind` (`claude-code`, `codex`, or `opencode`), `opencode: { model, effort }`, `permission`, and `dataDir` beside the codex arguments, and its argument text SHALL name the opencode defaults (`anthropic/claude-opus-5-5` at `medium`, commit `agent`, permission `derived`, dataDir `shared`).

#### Scenario: OpenCode leaves at start
- **WHEN** the `start` tool is called with `runnerKind: "opencode"`, `permission: "allow"`, and `dataDir: "launch"`
- **THEN** the result's `config.opencode.permission` and `config.opencode.dataDir` are `allow` and `launch` with source `argument`, and `config.opencode.commit` is `{ value: "agent", source: "default" }`

### Requirement: Start arguments: mode note for codex and opencode
Without `mode`, and with no mode configured or chosen by the run, the MCP `start` tool SHALL start a run whose kind in force is `codex` or `opencode` in `spawn`, with a `modeNote` naming the kind and saying that pull-mode workers for it come from `orchestrator-work --runner <kind>`; a `codex` or `opencode` run in `pull` SHALL get a `modeNote` that names the kind and the same work loop. The work loop SHALL carry `--runner <kind>` for `codex` too, although `codex` is the loop's default runner.

#### Scenario: Codex run switched to pull
- **WHEN** a `codex` run started in `spawn` is started again with `mode: "pull"`
- **THEN** the result has `started: false`, `mode: "pull"`, and a `modeNote` reading `runner kind codex in pull mode` and naming `orchestrator-work --runner codex`

### Requirement: Requests from another origin: Host check on a loopback bind
When the bind is a loopback address (`localhost`, `::1`, or an IPv4 address in `127.0.0.0/8`), the server SHALL also answer 403 to a request whose `Host` header is missing or is not one of: the bound address with the listening port; `localhost` with the listening port; with `apiBind: localhost`, `127.0.0.1` and `[::1]` with the listening port; the host and port of `apiBaseUrl` when that key is set.

#### Scenario: Host without the listening port
- **WHEN** a daemon bound to `127.0.0.1` receives a request with `Host: localhost` and no port, or `Host: user@localhost:<port>`
- **THEN** it answers 403 with `code: 'hostHeader'` and the route handler does not run

### Requirement: Requests from another origin: no Host check on another bind
When the bind is not loopback (`0.0.0.0` and `::` included) there SHALL be no `Host` check.

#### Scenario: Binds that are not loopback
- **WHEN** the bind is `0.0.0.0`, `::`, `10.0.0.1`, or `foo.localhost`
- **THEN** the bind is not loopback, and a request with `Host: 10.1.2.3:8080` and no `Origin` on a `0.0.0.0` bind reaches its route

### Requirement: Requests from another origin: Host comparison
The `Host` comparison SHALL ignore case and one trailing dot on the name, SHALL compare an IPv6 address in its bracketed form, and SHALL take a missing port to be the default port of the entry's scheme (`http` for the bound address and `localhost`, the URL's own scheme for `apiBaseUrl`).

#### Scenario: Case, trailing dot, and default port
- **WHEN** a daemon bound to `127.0.0.1` receives `Host: LOCALHOST:<port>` or `Host: localhost.:<port>`, and one with `apiBaseUrl: https://orch.test` receives `Host: orch.test`
- **THEN** each request reaches its route

### Requirement: Requests from another origin: rules applied before the route
The `Origin` rule SHALL be tested before the `Host` rule, and both SHALL be applied before the route is matched, before the request counts as activity for the idle exit, and before the body is read, so a refused request runs no handler and writes nothing. The probes SHALL get no exemption.

#### Scenario: Refused before the handler and the activity count
- **WHEN** a daemon bound to `127.0.0.1` receives a `POST` with a JSON body, `Origin: https://example.com`, and a valid `Host`
- **THEN** it answers 403 with `code: 'originHeader'`, the handler does not run, and the request is not counted as activity

### Requirement: Requests from another origin: the refusal answer
The answer SHALL be JSON `{ error, code }` with `code` `originHeader` or `hostHeader`; the `error` text SHALL name the header, and for `hostHeader` the value received and that `apiBaseUrl` adds a host. No CORS header SHALL be sent and no configuration key SHALL switch the rules off.

#### Scenario: Host refusal text
- **WHEN** a daemon bound to `127.0.0.1` receives a request with `Host: evil.example:<port>`
- **THEN** the answer is JSON with `code: 'hostHeader'` and an `error` that holds `evil.example:<port>` and names `apiBaseUrl`

### Requirement: Configuration route: limit blocks passed by start
`start` SHALL pass the `budgets` and `health` blocks to a daemon it spawns as `--set budgets=<json>` and `--set health=<json>`, and through the route to one already running.

#### Scenario: Blocks stored as overrides
- **WHEN** `start` spawns a daemon with `budgets: { maxLaunchMs: 10800000 }` and `health: { stuckAfterMs: 0 }`
- **THEN** the start result's `applied` is `budgets` and `health`, and the daemon's override document is `{ budgets: { maxLaunchMs: 10800000 }, health: { stuckAfterMs: 0 } }`

### Requirement: Configuration route: limit refusal readable at spawn
A refusal by a daemon that `start` spawns SHALL be readable from the error `start` returns: the daemon SHALL write its usage text before the refusal line, so the tail of its log ends with the refusal.

#### Scenario: Refusal line last in the log
- **WHEN** `start` spawns a daemon for a run with the default limits with `health: { stuckFailAfterMs: 600000 }`
- **THEN** the last line of the daemon log starts `--set health.stuckFailAfterMs:` and holds 600000 and 900000

### Requirement: Configuration command: each leaf named once
A call SHALL name each leaf once: the same leaf (a key, or `block.leaf`), or a block and a leaf under it, named by two of `--set`, `--clear`, `--allow` (the key `allowedTools`) and the per-key flags SHALL be refused before anything is sent. A repeated `--set allowedTools` appends rules and names the key once.

#### Scenario: A block and a leaf under it
- **WHEN** `config --clear health --set health.stuckAfterMs=1` or `config --set capacity=3 --set capacity=4` runs
- **THEN** it fails before any request with a message that the two flags both name the leaf, and the override document is unchanged

#### Scenario: Repeated allowedTools
- **WHEN** `config --set allowedTools=Bash(make:*) --set allowedTools=Bash(docker:*)` runs
- **THEN** the override document's `allowedTools` is `["Bash(make:*)", "Bash(docker:*)"]`

### Requirement: Configuration command: a bad set refused
A `--set` with an unknown key or a bad value SHALL be refused before anything is sent, naming the key.

#### Scenario: Unknown key and bad value
- **WHEN** `config --set nope=1` or `config --set budgets.maxLaunchMs=` runs
- **THEN** it fails naming `nope` as an unknown key, or saying that `budgets.maxLaunchMs` expects milliseconds, and no `operator.config` event is appended

### Requirement: Configuration command: usage names set
The CLI usage SHALL name `--set` on `config` and the three limit keys.

#### Scenario: Limit keys in the CLI usage
- **WHEN** `orchestrator-ctl --help` is run
- **THEN** the usage contains `--set key=value`, `budgets.maxLaunchMs`, `health.stuckAfterMs`, and `health.stuckFailAfterMs`

### Requirement: Status report: profile order and launched tasks
Entries SHALL be ordered by their first task in graph order. A task that has a launch SHALL be in no entry.

#### Scenario: A launched task leaves the list
- **WHEN** the profile hold is on, T1 is held in pull mode, and `PUT /v1/config` sets `model` and `effort`, after which a tick parks a launch for T1
- **THEN** `status.claimable` is `["T1"]` and `status.profiles` is `[]`

### Requirement: Status report: profiles with the hold off
The `profiles` list SHALL be present with the profile hold on or off; with it off every entry SHALL have `held: false` and an empty `missing`.

#### Scenario: Listed with no key set
- **WHEN** no configuration sets `runner.confirmProfile` and the graph holds one task A with no selector
- **THEN** `status.profiles` is one entry with the default profile, `held: false`, `missing: []`, `tasks: 1` and `sample: ["A"]`, and the first tick launches A

### Requirement: Status report: profile hold in force
`status.runner` SHALL carry `confirmProfile`, the profile hold in force. The body of `GET /v1/status` without a graph SHALL carry `runner.confirmProfile` and `profiles: []`.

#### Scenario: Hold reported on the runner block
- **WHEN** a pull-mode run whose configuration sets `runner.confirmProfile: true` has a graph loaded
- **THEN** `GET /v1/status` has `runner` with `mode: "pull"` and `confirmProfile: true`

### Requirement: Live launch guard: the two ending limits
Two limits end a launch: `budgets.maxLaunchMs`, which ends it when its elapsed time is at or above the limit, and `health.stuckFailAfterMs`, which ends it when its idle time is above the limit; a limit of 0 ends nothing. The route SHALL take the elapsed and idle times, and SHALL compare them, through the same functions the time budget and stuck checks use, so time the daemon did not run is left out in both places.

#### Scenario: An entry for the time budget
- **WHEN** a launch is at 9000 ms elapsed under a budget of 10000 and the patch is `{ budgets: { maxLaunchMs: 5000 } }`
- **THEN** the one `wouldEnd` entry carries `elapsedMs: 9000` and no `idleMs`

#### Scenario: Idle equal to the fail limit
- **WHEN** a launch has been idle 4000 ms and the patch is `{ health: { stuckFailAfterMs: 4000 } }`
- **THEN** it is applied, while `{ health: { stuckFailAfterMs: 3999 } }` is refused with `idleMs: 4000`

### Requirement: Live launch guard: the stuck flag limit is never refused
A changed `health.stuckAfterMs` only flags a launch and SHALL never be refused.

#### Scenario: Flag limit lowered below the idle time
- **WHEN** a launch is idle 2000 ms under limits 1000 and 3000 and the patch is `{ health: { stuckAfterMs: 500 } }`
- **THEN** it is applied with `applied: ["health"]`

### Requirement: Live launch guard: every shape of patch
The rule SHALL cover every shape of patch: a lower value, a null leaf that clears a raise, a null `budgets` or `health` block, and a limit that was 0 and is switched on.

#### Scenario: A null health block
- **WHEN** `health.stuckFailAfterMs` 3000 from the file was raised to 10000, a running launch is idle 5000 ms, and the patch is `{ health: null }`
- **THEN** the answer is 409 with an entry `limit: "health.stuckFailAfterMs"`, `value: 3000`, `idleMs: 5000`

### Requirement: Live launch guard: read from the store
The route SHALL read the store only: it SHALL NOT ask the runner for liveness, so it can name a launch the next tick would not end. A `waiting` task's launch SHALL NOT be named.

#### Scenario: A waiting launch left out
- **WHEN** one task is `waiting` on a question and other tasks are running, all idle 2000 ms, and the patch is `{ health: { stuckFailAfterMs: 1500 } }`
- **THEN** the refusal lists the running tasks' launches and not the waiting task's launch

### Requirement: Live launch guard: only launches ended now
The route SHALL name only launches the new limits end now; a value below the age a young launch will reach SHALL be accepted.

#### Scenario: A young launch below the new budget
- **WHEN** a launch is at 4000 ms elapsed under a budget of 100000 and the patch is `{ budgets: { maxLaunchMs: 5000 } }`
- **THEN** the patch is applied: no launch is past 5000 ms now

### Requirement: Live launch guard: the refusal body
The refusal body SHALL be `{ ok: false, error, wouldEnd }`, where each `wouldEnd` entry is `{ taskId, launchId, limit, value, elapsedMs }` for `budgets.maxLaunchMs` or `{ taskId, launchId, limit, value, idleMs }` for `health.stuckFailAfterMs`, `value` being the limit the patch would put in force, with one entry per launch and limit. `error` SHALL be one sentence that names each task and the `endLive` option.

#### Scenario: Refusal through the route
- **WHEN** T1's launch is live and `PUT /v1/config` carries `{ budgets: { maxLaunchMs: 1 } }`
- **THEN** the answer is 409 with `ok: false` and `wouldEnd: [{ taskId: "T1", launchId, limit: "budgets.maxLaunchMs", value: 1 }]`, no `startOnly`, and an `error` holding `T1` and `endLive`

### Requirement: Live launch guard: nothing applied on a refusal
Nothing of a refused patch SHALL be applied, other keys included, and no `operator.config` event SHALL be appended.

#### Scenario: Store and events unchanged
- **WHEN** a lowered budget is refused for a live launch
- **THEN** the stored override document is as before, no `operator.config` event is appended, and after a tick the task is still `running` with its launch `live`

### Requirement: Live launch guard: invalid and start-only patches answered first
A patch that is invalid (the stuck pair rule included) SHALL be answered 400 first, and a start-only key SHALL be answered with its 409 and `startOnly` body before the check for a change that would end a live launch.

#### Scenario: Start-only key before the guard
- **WHEN** a launch is past a lowered budget and the patch is `{ integrationBranch: "x", budgets: { maxLaunchMs: 5000 } }`
- **THEN** the answer is 409 with `startOnly: ["integrationBranch"]` and no `wouldEnd`

### Requirement: Live launch guard: endLive is not a configuration key
`endLive` SHALL NOT be a configuration key: it SHALL NOT be stored, validated as part of the patch, or listed under `applied`.

#### Scenario: endLive with a limit
- **WHEN** `PUT /v1/config` carries `{ budgets: { maxLaunchMs: 1 }, endLive: true }`
- **THEN** the answer has `applied: ["budgets"]`, and the stored override document is `{ budgets: { maxLaunchMs: 1 } }` with no `endLive` key

### Requirement: Live launch guard: a change confirmed with endLive
With `endLive: true` the patch SHALL be applied as without the guard, the `operator.config` event SHALL record `endLive: true`, and the next tick ends the named launches.

#### Scenario: Launch ended by the next tick
- **WHEN** a launch at 9000 ms elapsed and a budget lowered to 5000 with `endLive: true`
- **THEN** the one `operator.config` event holds `endLive: true`, and the next tick ends the launch with reason `timeBudget`

### Requirement: Live launch guard: endLive alone
A body of `endLive` alone SHALL be answered 200 with `applied: []` and SHALL store nothing.

#### Scenario: Nothing recorded
- **WHEN** the body is `{ endLive: true }` while a launch is live
- **THEN** the answer is 200 with `applied: []`, no override document is stored, and no `operator.config` event is appended

### Requirement: Live launch guard: command option --end-live
`orchestrator-ctl config --end-live` SHALL add `endLive: true` to the PUT, and with no key SHALL send the PUT, not the GET; its usage SHALL name `--end-live`.

#### Scenario: --end-live with no key
- **WHEN** `orchestrator-ctl config --end-live` is run with no key
- **THEN** a `PUT /v1/config` is sent and answered 200 with `applied: []`, the stored document is unchanged, and the usage names `--end-live`

### Requirement: Live launch guard: the route only
The guard SHALL cover the route only: a daemon spawned with `--set`, and a changed file, apply their limits on the first tick. The `start` tool SHALL NOT take `endLive`; on a running daemon a refused limit lands under `rejected` with the route's `error` text.

#### Scenario: Limit refused through start
- **WHEN** `start` passes `budgets: { maxLaunchMs: 1 }` to a running daemon whose live launch is past it
- **THEN** the result lists `budgets` under `rejected` with the route's `error` text, which names the task and `endLive`, and the limit in force is unchanged

### Requirement: Profile hold default: stored choice written at start
After the store is open, at every start: when `orchestrator.yaml` states `runner.confirmProfile` as a boolean, the daemon SHALL write the stored choice (kv `runner.confirmProfile`) as `on` or `off` to match the file; else, when the flag is given and the store holds no choice, it SHALL write the flag's value; else it SHALL write nothing. So the file's value SHALL overwrite the stored choice at every start, and a file line that is later removed SHALL leave the last stored choice in force.

#### Scenario: The file turns the hold on
- **WHEN** a fresh run whose `orchestrator.yaml` has `runner: { confirmProfile: true }` is started without `defaultConfirmProfile`
- **THEN** the result has `confirmProfile: true`

### Requirement: Profile hold default: the stored choice belongs to the run
The stored choice SHALL belong to the run: a start without the flag (by `orchestrator-ctl`, by hand or by a revival) SHALL keep it. `orchestrator-ctl`, a daemon started by hand and a cluster daemon SHALL never pass the flag `--default-confirm-profile` by themselves.

#### Scenario: A start without the flag keeps the choice
- **WHEN** a run adopted the hold through `defaultConfirmProfile: true`, was stopped, and is started again without the option
- **THEN** the result has `started: true` and `confirmProfile: true`

### Requirement: Profile hold default: startDaemon option
`startDaemon` SHALL take `defaultConfirmProfile?: boolean` and pass the flag only to a daemon it spawns, independent of `--mode` and `--default-mode`. A running daemon SHALL keep the choice it has.

#### Scenario: No option, no hold
- **WHEN** a fresh run whose file states no `runner.confirmProfile` is started with `startDaemon` and no `defaultConfirmProfile`
- **THEN** the result has `confirmProfile: false`

### Requirement: Profile hold default: confirmProfile in the start result
The start result SHALL carry `confirmProfile`, the hold in force read from the status probe's `runner.confirmProfile`, in every path, also when the daemon is already running and a `mode` is passed (where the result's `mode` stays the passed `mode`). The field SHALL be absent only when the probe fails.

#### Scenario: Running daemon without a mode
- **WHEN** `startDaemon()` is called with no option while the run's daemon runs in `pull` mode with the hold on
- **THEN** the result is `started: false` with `mode: "pull"` and `confirmProfile: true`

### Requirement: Profile hold default: a run from before the hold
A run that existed before "Profile hold default for a spawned daemon" has no stored choice. A run that existed before "Profile hold default for a spawned daemon" SHALL adopt the hold the next time a daemon is spawned for it with the flag `on`, by a start or by a revival, and its `unstarted` tasks are then held.

#### Scenario: Revival adopts the hold
- **WHEN** a run started without the option, with `confirmProfile: false` and tasks T1 and T2 (T2 depending on T1), exits idle and an operator tool revives it
- **THEN** `status` has `runner.confirmProfile: true` and the profile entry holding T2 has `held: true`
