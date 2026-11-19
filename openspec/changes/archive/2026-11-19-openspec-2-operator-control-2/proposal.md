## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. In `operator-control`, 24 of the 44 requirements are over the limit. This change is part 2 of 2 of the `operator-control` migration (ORC-157, under ORC-139): it splits 12 of them (19135 characters and 142 occurrences of SHALL or MUST in all) the way OpenSpec 2.1 prescribes, without changing what the spec requires. Part 1 (`openspec-2-operator-control-1`) splits the other 12 in a change of its own; the two parts touch disjoint requirements.

## What Changes

- 12 requirements are MODIFIED. Each keeps its header and every scenario, names and text unchanged. Its description is cut to one behavior of at most 500 characters:

  | Requirement | Before | After | Scenarios kept | ADDED from it |
  |---|---|---|---|---|
  | Exit record | 1704 | 466 | 5 | 6 |
  | Container mode | 1497 | 344 | 5 | 5 |
  | Session attachments | 1656 | 334 | 8 | 6 |
  | Configuration route | 3127 | 366 | 13 | 9 |
  | Status report: configuration | 718 | 424 | 6 | 3 |
  | Start arguments | 1994 | 328 | 5 | 5 |
  | Requests from another origin are refused | 1542 | 184 | 8 | 5 |
  | Configuration route: limit keys | 776 | 424 | 2 | 2 |
  | Configuration command: set flags | 822 | 337 | 3 | 3 |
  | Status report: profiles | 812 | 398 | 3 | 3 |
  | Configuration route: a change that would end a live launch | 2801 | 320 | 10 | 13 |
  | Profile hold default for a spawned daemon | 1686 | 233 | 4 | 5 |

- 65 requirements are ADDED, each holding behavior moved out of one of those descriptions. Each has a name `operator-control` does not have yet (prefixed with its parent's subject, or "Live launch guard:" for "Configuration route: a change that would end a live launch"), a description of at most 500 characters (the longest is 496), and at least one scenario of its own with a WHEN and a THEN step, stating behavior the code has at the base (the file is named for each below).
- No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped or weakened: the 12 original descriptions hold 142; the cut descriptions hold 22 and the ADDED descriptions 125 (147). The count rises because a split sentence repeats its subject and its SHALL in each clause.
- Requirements that are not over the limit are not touched, and no file outside this change directory changes.
- Four sentences are longer than 500 characters on their own, so each is split at its semicolons; each clause keeps its words, with the sentence's subject repeated where it must stand alone:
  - "Session attachments", the sentence beginning "The daemon SHALL expose `POST /v1/attachments` with `{ id, p..." (711 characters): split at its two semicolons into its three routes; "The daemon SHALL expose" is repeated as the subject of the second and third clauses, the joining "and" before the third is dropped, and each clause ends with a period. Its pieces are listed under the requirement below.
  - "Configuration route", the sentence beginning "The daemon SHALL expose `GET /v1/config`, returning the reso..." (568 characters): split at its semicolon (the one outside the parentheses) into its `GET` and `PUT` routes; "The daemon SHALL expose" is repeated as the subject of the second clause, the joining "and" is dropped, and the first clause ends with a period. Its pieces are listed under the requirement below.
  - "Configuration route", the sentence beginning "It SHALL set keys with `--check-command`, `--capacity`, `--a..." (793 characters): split at the two semicolons inside the `--data-dir` parenthesis: the flag list keeps "(the key `opencode.dataDir`" and closes that parenthesis where the first semicolon stood, and its "It" is made explicit as "`orchestrator-ctl config`"; the two clauses on the `--data-dir` value each open with "For `--data-dir`," as their subject and end with a period; the semicolon inside the `--clear` parenthesis is kept. Its pieces are listed under the requirement below.
  - "Status report: configuration", the sentence beginning "`status` SHALL additionally report `config`, every configura..." (514 characters): split at its two semicolons into its three reported facts; "`status` SHALL additionally report" is repeated as the subject of the second and third clauses, the joining "and" before the third is dropped, and each clause ends with a period. Its pieces are listed under the requirement below.

## Capabilities

### New Capabilities

### Modified Capabilities

- `operator-control`: 12 long requirements are split into a cut MODIFIED requirement plus ADDED requirements. The behavior is unchanged.

## Moved sentences

Every sentence of each original description is listed: it stays in the MODIFIED description or moves to exactly one ADDED requirement. "Unchanged" means word for word; where a reference is made explicit, the change is stated.

### Exit record

- "On every graceful exit, whether by the `shutdown` route, by signal, or by idle exit, the daemon SHALL write `exit: { at, reason, reap, digest, by?, unflushedBatches?, storeClosed?, rejected? }` into `daemon.json` after the orchestrator has stopped and before the process ends." stays, unchanged.
- "`reason` is `stop`, `signal`, or `idle`." stays, unchanged.
- "`digest` is the event-stream digest taken before the store closes." stays, unchanged.
- "`by`, present for a `stop`, names the caller as recorded by the `shutdown` route." stays, unchanged.
- "The record SHALL be written after the store's close returns." moves to **Exit record: written after the store closes**, unchanged.
- "When the close reports lost batches, the record SHALL carry their count as `unflushedBatches`." moves to **Exit record: written after the store closes**, unchanged.
- "When the sink rejected a batch, the record SHALL carry its cause as `rejected`." moves to **Exit record: written after the store closes**, unchanged.
- "When the shutdown grace period elapses before the close returns, the record SHALL carry `storeClosed: false` and `unflushedBatches` set to the pending count read before the record is written, even when that count is 0." moves to **Exit record: shutdown grace elapsed**, unchanged.
- "When the journal turns fatal after a shutdown began and before the close returns, the record SHALL carry `storeClosed: false` and the fatal condition's `unflushedBatches` before the daemon exits 1." moves to **Exit record: journal fatal during a shutdown**, unchanged.
- "A fatal condition with no shutdown under way leaves no record and reads as a crash." moves to **Exit record: journal fatal during a shutdown**, unchanged.
- "A record without these fields is clean." moves to **Exit record: clean record**, with "these fields" made explicit as "`unflushedBatches`, `storeClosed`, and `rejected`".
- "A clean record SHALL be written only after the store closed with nothing unflushed." moves to **Exit record: clean record**, unchanged.
- "A daemon that starts SHALL write `daemon.json` without `exit`." moves to **Exit record: start and crash**, unchanged.
- "A dead pid whose `daemon.json` has no `exit` SHALL be read as a crash." moves to **Exit record: start and crash**, unchanged.
- "`runs` SHALL report, for every run whose daemon is not alive, the exit record or that none exists." moves to **Exit record: start and crash**, unchanged.
- "The revival refusal after a `stop` SHALL name the caller when one was recorded, and SHALL name the lost batches when the record is not clean." moves to **Exit record: revival refusal**, unchanged.

### Container mode

- "The daemon SHALL run as a long-lived foreground process." stays, unchanged.
- "On SIGTERM or SIGINT it SHALL stop the tick loop, finish the in-flight tick and verifier job, close the API server and its open connections, write the exit record with reason `signal`, and exit 0." stays, unchanged.
- "When that takes longer than 8 seconds it SHALL write the exit record and exit 0 anyway; a check abandoned that way restarts from `queued` on the next start, as after a crash." moves to **Container mode: shutdown deadline**, with "that" made explicit as "stopping on SIGTERM or SIGINT", and "it" as "the daemon".
- "The daemon SHALL write `daemon.pid` and `daemon.json` in its data directory itself, whether or not a client spawned it; in a container nothing reads them." moves to **Container mode: daemon files**, unchanged.
- "When `ORCH_LOG_FORMAT` is `json`, every line the daemon logs on stderr SHALL be one JSON object with `ts`, `level`, and `msg` first, followed by the data fields; a data field named `ts`, `level`, or `msg` is dropped." moves to **Container mode: JSON log format**, unchanged.
- "Any other value SHALL keep the text format." moves to **Container mode: JSON log format**, unchanged.
- "`daemon.idleExitMs: 0` keeps the daemon running however long it is idle (see "Idle exit")." stays, unchanged.
- "When `ORCH_URL` names a host other than `localhost`, `*.localhost`, `127.0.0.0/8`, or `::1`, the client-side `start` and revival SHALL NOT spawn a local daemon: revival returns nothing to revive when the URL answers a probe and otherwise fails naming the URL as unreachable, and `start` refuses." moves to **Container mode: remote daemon URL**, unchanged.
- "The operator MCP server SHALL use such a URL directly, without registering an attachment, since the pids it would register are not the daemon's." moves to **Container mode: operator server on a remote daemon URL**, with "such a URL" made explicit as "an `ORCH_URL` that names a host other than `localhost`, `*.localhost`, `127.0.0.0/8`, or `::1`".
- "The bind address, advertised URL, probes, image, and manifests a container needs are specified in specs/cluster-runtime." moves to **Container mode: daemon files**, unchanged.

### Session attachments

- Split (711 characters): "The daemon SHALL expose `POST /v1/attachments` with `{ id, pids }`, where `pids` is the registering process's own pid followed by its ancestor pids up to six levels, stopping before pid 1, recording the attachment durably and appending `attachment.started` on first sight (registering a live attachment again SHALL refresh its chain); `POST /v1/attachments/:id/end` with `{ reason }`, recording the end; and `POST /v1/attachments/ended` with `{ pids, reason }`, where `pids` is the posting hook's own pid followed by its ancestors, recording the end of every live attachment for which the nearest pid in `pids` that is also in the attachment's chain is the hook's parent or grandparent (`pids[1]` or `pids[2]`)."
  - "The daemon SHALL expose `POST /v1/attachments` with `{ id, pids }`, where `pids` is the registering process's own pid followed by its ancestor pids up to six levels, stopping before pid 1, recording the attachment durably and appending `attachment.started` on first sight (registering a live attachment again SHALL refresh its chain)." stays in the MODIFIED description
  - "The daemon SHALL expose `POST /v1/attachments/:id/end` with `{ reason }`, recording the end." moves to **Session attachments: end by id**
  - "The daemon SHALL expose `POST /v1/attachments/ended` with `{ pids, reason }`, where `pids` is the posting hook's own pid followed by its ancestors, recording the end of every live attachment for which the nearest pid in `pids` that is also in the attachment's chain is the hook's parent or grandparent (`pids[1]` or `pids[2]`)." moves to **Session attachments: end by ancestry**
- "pid 1 SHALL never match." moves to **Session attachments: end by ancestry**, unchanged.
- "An attachment whose nearest shared pid is further up the posted chain, as for a session nested under a shell or another process inside the attachment's session, SHALL stay live." moves to **Session attachments: a nested session stays attached**, unchanged.
- "An operator request MAY carry the header `x-orch-attachment` naming the caller's attachment; when that id is not a live attachment the daemon SHALL still perform the operation and SHALL add the response header `x-orch-attachment: unknown`." moves to **Session attachments: attachment header**, unchanged.
- "A claim MAY carry `attachment`, stored on the launch's worker record." moves to **Session attachments: reconcile releases**, unchanged.
- "At every reconcile the daemon SHALL end any attachment whose first pid is dead, SHALL release with `keep` and reason `sessionEnded` every live claimed launch whose worker carries an ended attachment, SHALL append `attachment.ended`, and SHALL remove the record." moves to **Session attachments: reconcile releases**, unchanged.
- "`status` SHALL report `attachments` as `[{ id, pids, since, launches }]` for live attachments." moves to **Session attachments: status**, unchanged.
- "The end routes SHALL respond once the end is recorded, before any release." moves to **Session attachments: end by id**, unchanged.

### Configuration route

- Split (568 characters): "The daemon SHALL expose `GET /v1/config`, returning the resolved configuration with value and source per key, the `toolchain` detection record, the overrides in force, and `needsConfig`; and `PUT /v1/config`, taking any of `checkCommand`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, `claude`, `codex`, and `opencode` (the per-kind leaves; `opencode` holds `model`, `effort`, `commit`, `command`, `permission`, and `dataDir`), each a value or null to clear, applying the runtime override rules of the toolchain-discovery specification."
  - "The daemon SHALL expose `GET /v1/config`, returning the resolved configuration with value and source per key, the `toolchain` detection record, the overrides in force, and `needsConfig`." stays in the MODIFIED description
  - "The daemon SHALL expose `PUT /v1/config`, taking any of `checkCommand`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, `claude`, `codex`, and `opencode` (the per-kind leaves; `opencode` holds `model`, `effort`, `commit`, `command`, `permission`, and `dataDir`), each a value or null to clear, applying the runtime override rules of the toolchain-discovery specification." moves to **Configuration route: PUT keys**
- "It SHALL validate the whole body before applying anything, answer 400 naming an invalid key and 409 naming a start-only key, and otherwise record an `operator.config` event carrying the patch and the override document in one transaction, rewrite `config.json`, append `config.resolved`, wake the loop, and return the new `config` block with the keys it `applied`." moves to **Configuration route: PUT validation and recording**, with "It" made explicit as "`PUT /v1/config`".
- "The CLI SHALL expose `orchestrator-ctl config`." stays, unchanged.
- "Without flags it SHALL print the block, including `runnerKind` and the `claude`, `codex`, and `opencode` leaves with their sources." stays, unchanged.
- Split (793 characters): "It SHALL set keys with `--check-command`, `--capacity`, `--allow <rule>` (repeatable), `--runner-command`, `--runner-kind <kind>`, `--model`, `--effort`, `--sandbox <mode>` (the key `codex.sandbox`), `--permission <derived|allow>` (the key `opencode.permission`), `--data-dir <shared|launch>` (the key `opencode.dataDir`; on `config` a value of `shared` or `launch` SHALL be read as the leaf, and any other value SHALL keep naming the store location when no daemon URL is given; when `--url` or `ORCH_URL` addresses the daemon, any other value SHALL be refused before anything is sent, with a message naming both meanings and the two accepted values), `--commit <agent|daemon>`, and `--clear <key>` (repeatable; a per-kind key such as `codex.sandbox` or `opencode.permission` clears one leaf)."
  - "`orchestrator-ctl config` SHALL set keys with `--check-command`, `--capacity`, `--allow <rule>` (repeatable), `--runner-command`, `--runner-kind <kind>`, `--model`, `--effort`, `--sandbox <mode>` (the key `codex.sandbox`), `--permission <derived|allow>` (the key `opencode.permission`), `--data-dir <shared|launch>` (the key `opencode.dataDir`), `--commit <agent|daemon>`, and `--clear <key>` (repeatable; a per-kind key such as `codex.sandbox` or `opencode.permission` clears one leaf)." moves to **Configuration route: command key flags**
  - "For `--data-dir`, on `config` a value of `shared` or `launch` SHALL be read as the leaf, and any other value SHALL keep naming the store location when no daemon URL is given." moves to **Configuration route: command data-dir value**
  - "For `--data-dir`, when `--url` or `ORCH_URL` addresses the daemon, any other value SHALL be refused before anything is sent, with a message naming both meanings and the two accepted values." moves to **Configuration route: command data-dir value**
- "`--runner-kind` SHALL take `claude-code`, `codex`, or `opencode`." moves to **Configuration route: command runner kind and commit policy**, unchanged.
- "`--commit` SHALL set the commit policy of `--runner-kind` when it is given in the same call, else of the kind in force." moves to **Configuration route: command runner kind and commit policy**, unchanged.
- "A call that clears a key and sets a leaf under it (`--clear codex --sandbox read-only`, `--clear codex.sandbox --sandbox read-only`) SHALL be refused before anything is sent, naming both, and so SHALL `--clear runnerKind` together with `--commit` unless `--runner-kind` names the kind the policy binds to; the daemon refuses the same patch shapes." moves to **Configuration route: a cleared key and its leaf in one call**, unchanged.
- "The operator-surface fold (`foldRunnerArgs`) SHALL put `permission` and `dataDir` arguments under `opencode` and SHALL refuse them beside a cleared `opencode` or a cleared leaf of the same name, with the same message." moves to **Configuration route: fold of the OpenCode arguments**, unchanged.
- "The CLI usage SHALL name the three kinds and their default models and efforts (`claude-opus-5-5`, `gpt-6-astra`, and `anthropic/claude-opus-5-5`, all at `medium`) and SHALL say that `ultra` is codex-only." moves to **Configuration route: command usage names the kinds**, unchanged.
- "The MCP `configure` tool SHALL take `opencode: { model, effort }`, `permission`, and `dataDir` beside the codex arguments, folded the same way, and SHALL forward the route's refusal of an effort the kind lacks (`ultra` for opencode), whose message names the kind." moves to **Configuration route: configure tool OpenCode arguments**, unchanged.

### Status report: configuration

- Split (514 characters): "`status` SHALL additionally report `config`, every configuration key as `{ value, source }` with nested blocks per leaf, `runnerKind` (the kind in force), `allowedTools` carrying `parts` and `applied`, `model` and `effort` (those of the kind in force) each carrying `applied`, and the `claude`, `codex`, and `opencode` leaves (among them `codex.sandbox`, `opencode.permission`, `opencode.dataDir`, and each kind's `commit`); `toolchain`, the detection record; and `needsConfig`, the keys whose value is unresolved."
  - "`status` SHALL additionally report `config`, every configuration key as `{ value, source }` with nested blocks per leaf, `runnerKind` (the kind in force), `allowedTools` carrying `parts` and `applied`, `model` and `effort` (those of the kind in force) each carrying `applied`, and the `claude`, `codex`, and `opencode` leaves (among them `codex.sandbox`, `opencode.permission`, `opencode.dataDir`, and each kind's `commit`)." stays in the MODIFIED description
  - "`status` SHALL additionally report `toolchain`, the detection record." moves to **Status report: toolchain and needsConfig**
  - "`status` SHALL additionally report `needsConfig`, the keys whose value is unresolved." moves to **Status report: toolchain and needsConfig**
- "Each entry of `liveLaunches` SHALL carry the launch's `runner`, `model`, and `effort`." moves to **Status report: selection of each live launch**, unchanged.
- "The event stream digest SHALL carry `needsConfig`." moves to **Status report: toolchain and needsConfig**, unchanged.
- "The configuration facts SHALL be present when no graph is loaded." moves to **Status report: configuration without a graph**, unchanged.

### Start arguments

- "The daemon lifecycle `start` SHALL accept `checkCommand`, `integrationBranch`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, `claude`, `codex`, and `opencode` beside `mode`." stays, unchanged.
- "When it spawns the daemon it SHALL pass each as a `--set key=value` flag (a per-kind block as a JSON object), which the daemon stores as an override before resolving; when the daemon is already healthy it SHALL apply them through `PUT /v1/config` and SHALL report any key the route refused under `rejected` with the route's reason." moves to **Start arguments: passed at spawn or through the route**, with the first "it" made explicit as "the daemon lifecycle `start`".
- "The result SHALL carry `config`, `toolchain`, and `needsConfig` as read from `GET /v1/config` after the daemon is healthy." stays, unchanged.
- "`orchestrator-ctl start` SHALL accept the same keys as repeatable `--set key=value` flags, the per-kind leaves as dotted keys (`claude.model`, `claude.effort`, `claude.commit`, `codex.model`, `codex.effort`, `codex.sandbox`, `codex.commit`, `codex.command`, `opencode.model`, `opencode.effort`, `opencode.commit`, `opencode.command`, `opencode.permission`, `opencode.dataDir`), and the daemon's `--set` SHALL reject an unknown key or an invalid value with a usage error before serving." moves to **Start arguments: command set flags**, unchanged.
- "The daemon's usage SHALL list these keys." moves to **Start arguments: daemon usage**, with "these keys" made explicit as "the keys `orchestrator-ctl start` takes as `--set` flags".
- "The MCP `start` tool SHALL take `runnerKind` (`claude-code`, `codex`, or `opencode`), `opencode: { model, effort }`, `permission`, and `dataDir` beside the codex arguments, and its argument text SHALL name the opencode defaults (`anthropic/claude-opus-5-5` at `medium`, commit `agent`, permission `derived`, dataDir `shared`)." moves to **Start arguments: start tool runner arguments**, unchanged.
- "Without `mode`, and with no mode configured or chosen by the run, it SHALL start a run whose kind in force is `codex` or `opencode` in `spawn`, with a `modeNote` naming the kind and saying that pull-mode workers for it come from `orchestrator-work --runner <kind>`; a `codex` or `opencode` run in `pull` SHALL get a `modeNote` that names the kind and the same work loop." moves to **Start arguments: mode note for codex and opencode**, with "it" made explicit as "the MCP `start` tool".
- "The work loop SHALL carry `--runner <kind>` for `codex` too, although `codex` is the loop's default runner." moves to **Start arguments: mode note for codex and opencode**, unchanged.

### Requests from another origin are refused

- "The API server SHALL answer 403 to any request that carries an `Origin` header, whatever its value (`null` and an empty value included), on every bind, for every method and every path." stays, unchanged.
- "When the bind is a loopback address (`localhost`, `::1`, or an IPv4 address in `127.0.0.0/8`), the server SHALL also answer 403 to a request whose `Host` header is missing or is not one of: the bound address with the listening port; `localhost` with the listening port; with `apiBind: localhost`, `127.0.0.1` and `[::1]` with the listening port; the host and port of `apiBaseUrl` when that key is set." moves to **Requests from another origin: Host check on a loopback bind**, unchanged.
- "When the bind is not loopback (`0.0.0.0` and `::` included) there SHALL be no `Host` check." moves to **Requests from another origin: no Host check on another bind**, unchanged.
- "The `Host` comparison SHALL ignore case and one trailing dot on the name, SHALL compare an IPv6 address in its bracketed form, and SHALL take a missing port to be the default port of the entry's scheme (`http` for the bound address and `localhost`, the URL's own scheme for `apiBaseUrl`)." moves to **Requests from another origin: Host comparison**, unchanged.
- "The `Origin` rule SHALL be tested before the `Host` rule, and both SHALL be applied before the route is matched, before the request counts as activity for the idle exit, and before the body is read, so a refused request runs no handler and writes nothing." moves to **Requests from another origin: rules applied before the route**, unchanged.
- "The probes SHALL get no exemption." moves to **Requests from another origin: rules applied before the route**, unchanged.
- "The answer SHALL be JSON `{ error, code }` with `code` `originHeader` or `hostHeader`; the `error` text SHALL name the header, and for `hostHeader` the value received and that `apiBaseUrl` adds a host." moves to **Requests from another origin: the refusal answer**, unchanged.
- "No CORS header SHALL be sent and no configuration key SHALL switch the rules off." moves to **Requests from another origin: the refusal answer**, unchanged.

### Configuration route: limit keys

- "`PUT /v1/config` SHALL take `budgets: { maxLaunchMs }` and `health: { stuckAfterMs, stuckFailAfterMs }`, each leaf a value or null and each block a value or null, applying toolchain-discovery "Runtime limit overrides"." stays, unchanged.
- "A refusal SHALL be a 400 whose `key` is the dotted key (`budgets.maxLaunchMs`, `health.stuckAfterMs`, `health.stuckFailAfterMs`, or the unknown leaf)." stays, unchanged.
- "`applied` SHALL name the block, `budgets` or `health`." stays, unchanged.
- "`start` SHALL pass the blocks to a daemon it spawns as `--set budgets=<json>` and `--set health=<json>`, and through the route to one already running." moves to **Configuration route: limit blocks passed by start**, with "the blocks" made explicit as "the `budgets` and `health` blocks".
- "A refusal by a daemon that `start` spawns SHALL be readable from the error `start` returns: the daemon SHALL write its usage text before the refusal line, so the tail of its log ends with the refusal." moves to **Configuration route: limit refusal readable at spawn**, unchanged.

### Configuration command: set flags

- "`orchestrator-ctl config` SHALL take `--set key=value` (repeatable) for every key `start --set` takes, including `budgets.maxLaunchMs`, `health.stuckAfterMs` and `health.stuckFailAfterMs`, parse it as `start` does, and merge it per leaf into the one `PUT /v1/config` built from the other flags." stays, unchanged.
- "A call SHALL name each leaf once: the same leaf (a key, or `block.leaf`), or a block and a leaf under it, named by two of `--set`, `--clear`, `--allow` (the key `allowedTools`) and the per-key flags SHALL be refused before anything is sent." moves to **Configuration command: each leaf named once**, unchanged.
- "A repeated `--set allowedTools` appends rules and names the key once." moves to **Configuration command: each leaf named once**, unchanged.
- "Different leaves of one block SHALL merge." stays, unchanged.
- "A `--set` with an unknown key or a bad value SHALL be refused before anything is sent, naming the key." moves to **Configuration command: a bad set refused**, unchanged.
- "The CLI usage SHALL name `--set` on `config` and the three limit keys." moves to **Configuration command: usage names set**, unchanged.

### Status report: profiles

- "`status` SHALL carry `profiles`, listing every `unstarted` task node grouped into one entry per distinct `{ runner, model, effort, modelSource, effortSource }` (model-selection "Profile sources of a task")." stays, unchanged.
- "Each entry SHALL carry `held` (a boolean), `missing` (a list holding `model`, `effort`, both or neither, in that order), `tasks` (the count) and `sample` (at most 5 task ids, in graph order)." stays, unchanged.
- "Entries SHALL be ordered by their first task in graph order." moves to **Status report: profile order and launched tasks**, unchanged.
- "A task that has a launch SHALL be in no entry." moves to **Status report: profile order and launched tasks**, unchanged.
- "The list SHALL be present with the profile hold on or off; with it off every entry SHALL have `held: false` and an empty `missing`." moves to **Status report: profiles with the hold off**, with "The list" made explicit as "The `profiles` list".
- "`status.runner` SHALL carry `confirmProfile`, the profile hold in force." moves to **Status report: profile hold in force**, unchanged.
- "The body of `GET /v1/status` without a graph SHALL carry `runner.confirmProfile` and `profiles: []`." moves to **Status report: profile hold in force**, unchanged.

### Configuration route: a change that would end a live launch

- "`PUT /v1/config` SHALL refuse with 409 a patch that would end a live launch, unless the body holds `endLive: true` (or `"true"`)." stays, unchanged.
- "A patch would end a launch when, for a `live` launch that holds the lease of a `running` task, the limits in force after the patch end it now and the limits in force before the patch do not." stays, unchanged.
- "Two limits end a launch: `budgets.maxLaunchMs`, which ends it when its elapsed time is at or above the limit, and `health.stuckFailAfterMs`, which ends it when its idle time is above the limit; a limit of 0 ends nothing." moves to **Live launch guard: the two ending limits**, unchanged.
- "The route SHALL take the elapsed and idle times, and SHALL compare them, through the same functions the time budget and stuck checks use, so time the daemon did not run is left out in both places." moves to **Live launch guard: the two ending limits**, unchanged.
- "A changed `health.stuckAfterMs` only flags a launch and SHALL never be refused." moves to **Live launch guard: the stuck flag limit is never refused**, unchanged.
- "The rule SHALL cover every shape of patch: a lower value, a null leaf that clears a raise, a null `budgets` or `health` block, and a limit that was 0 and is switched on." moves to **Live launch guard: every shape of patch**, unchanged.
- "The route SHALL read the store only: it SHALL NOT ask the runner for liveness, so it can name a launch the next tick would not end." moves to **Live launch guard: read from the store**, unchanged.
- "A `waiting` task's launch SHALL NOT be named." moves to **Live launch guard: read from the store**, unchanged.
- "The route SHALL name only launches the new limits end now; a value below the age a young launch will reach SHALL be accepted." moves to **Live launch guard: only launches ended now**, unchanged.
- "The refusal body SHALL be `{ ok: false, error, wouldEnd }`, where each `wouldEnd` entry is `{ taskId, launchId, limit, value, elapsedMs }` for `budgets.maxLaunchMs` or `{ taskId, launchId, limit, value, idleMs }` for `health.stuckFailAfterMs`, `value` being the limit the patch would put in force, with one entry per launch and limit." moves to **Live launch guard: the refusal body**, unchanged.
- "`error` SHALL be one sentence that names each task and the `endLive` option." moves to **Live launch guard: the refusal body**, unchanged.
- "Nothing of the patch SHALL be applied, other keys included, and no `operator.config` event SHALL be appended." moves to **Live launch guard: nothing applied on a refusal**, with "the patch" made explicit as "a refused patch".
- "A patch that is invalid (the stuck pair rule included) SHALL be answered 400 first, and a start-only key SHALL be answered with its 409 and `startOnly` body before this check." moves to **Live launch guard: invalid and start-only patches answered first**, with "this check" made explicit as "the check for a change that would end a live launch".
- "`endLive` SHALL NOT be a configuration key: it SHALL NOT be stored, validated as part of the patch, or listed under `applied`." moves to **Live launch guard: endLive is not a configuration key**, unchanged.
- "With `endLive: true` the patch SHALL be applied as without the guard, the `operator.config` event SHALL record `endLive: true`, and the next tick ends the named launches." moves to **Live launch guard: a change confirmed with endLive**, unchanged.
- "A body of `endLive` alone SHALL be answered 200 with `applied: []` and SHALL store nothing." moves to **Live launch guard: endLive alone**, unchanged.
- "`orchestrator-ctl config --end-live` SHALL add `endLive: true` to the PUT, and with no key SHALL send the PUT, not the GET; its usage SHALL name `--end-live`." moves to **Live launch guard: command option --end-live**, unchanged.
- "The guard SHALL cover the route only: a daemon spawned with `--set`, and a changed file, apply their limits on the first tick." moves to **Live launch guard: the route only**, unchanged.
- "The `start` tool SHALL NOT take `endLive`; on a running daemon a refused limit lands under `rejected` with the route's `error` text." moves to **Live launch guard: the route only**, unchanged.

### Profile hold default for a spawned daemon

- "The daemon SHALL take `--default-confirm-profile on|off`." stays, unchanged.
- "Any other value SHALL end the start with an error that holds `--default-confirm-profile must be on or off, not <value>`, whatever the file says and before the store is opened." stays, unchanged.
- "After the store is open, at every start: when `orchestrator.yaml` states `runner.confirmProfile` as a boolean, the daemon SHALL write the stored choice (kv `runner.confirmProfile`) as `on` or `off` to match the file; else, when the flag is given and the store holds no choice, it SHALL write the flag's value; else it SHALL write nothing." moves to **Profile hold default: stored choice written at start**, unchanged.
- "So the file's value SHALL overwrite the stored choice at every start, and a file line that is later removed SHALL leave the last stored choice in force." moves to **Profile hold default: stored choice written at start**, unchanged.
- "The stored choice SHALL belong to the run: a start without the flag (by `orchestrator-ctl`, by hand or by a revival) SHALL keep it." moves to **Profile hold default: the stored choice belongs to the run**, unchanged.
- "`orchestrator-ctl`, a daemon started by hand and a cluster daemon SHALL never pass the flag by themselves." moves to **Profile hold default: the stored choice belongs to the run**, with "the flag" made explicit as "the flag `--default-confirm-profile`".
- "`startDaemon` SHALL take `defaultConfirmProfile?: boolean` and pass the flag only to a daemon it spawns, independent of `--mode` and `--default-mode`." moves to **Profile hold default: startDaemon option**, unchanged.
- "A running daemon SHALL keep the choice it has." moves to **Profile hold default: startDaemon option**, unchanged.
- "The start result SHALL carry `confirmProfile`, the hold in force read from the status probe's `runner.confirmProfile`, in every path, also when the daemon is already running and a `mode` is passed (where the result's `mode` stays the passed `mode`)." moves to **Profile hold default: confirmProfile in the start result**, unchanged.
- "The field SHALL be absent only when the probe fails." moves to **Profile hold default: confirmProfile in the start result**, unchanged.
- "A run that existed before this requirement has no stored choice." moves to **Profile hold default: a run from before the hold**, with "this requirement" made explicit as "Profile hold default for a spawned daemon".
- "It SHALL adopt the hold the next time a daemon is spawned for it with the flag `on`, by a start or by a revival, and its `unstarted` tasks are then held." moves to **Profile hold default: a run from before the hold**, with "It" made explicit as "A run that existed before "Profile hold default for a spawned daemon"".

## Sources of the new scenarios

Each ADDED requirement's scenarios state behavior the code has at the base commit a90a776; the file that shows it:

- **Exit record: written after the store closes**: test/runs/lifecycle.test.ts ("exit record store fields") and src/main.ts (`recordExit` after `opened.close()`)
- **Exit record: shutdown grace elapsed**: test/runs/lifecycle.test.ts ("a grace exit before the store closed is never clean") and src/main.ts (the `SHUTDOWN_GRACE_MS` timer)
- **Exit record: journal fatal during a shutdown**: src/main.ts (`onFatal` and `fatalDuringShutdown`)
- **Exit record: clean record**: test/runs/lifecycle.test.ts ("a shutdown through the route records its caller ..." and "a close with nothing unflushed adds nothing")
- **Exit record: start and crash**: test/runs/lifecycle.test.ts ("exits on its own when idle, records why, and is revived with its state intact")
- **Exit record: revival refusal**: test/runs/lifecycle.test.ts ("a shutdown through the route records its caller ...")
- **Container mode: shutdown deadline**: src/main.ts (`SHUTDOWN_GRACE_MS = 8_000` and its timer in the shutdown)
- **Container mode: daemon files**: test/slice/container.test.ts ("SIGTERM during a verifier check ...")
- **Container mode: JSON log format**: test/runs/log.test.ts
- **Container mode: remote daemon URL**: test/runs/remote.test.ts
- **Container mode: operator server on a remote daemon URL**: src/operator/mcp-server.ts (the client's `url()`, which returns `remoteDaemonUrl` without calling `ensureAttached`)
- **Session attachments: end by id**: test/slice/claim.test.ts ("a dead or ended attachment releases its launches with keep ...")
- **Session attachments: end by ancestry**: test/slice/claim.test.ts ("a dead or ended attachment releases its launches with keep ...") and test/loop/attachments-nested.test.ts ("matches only when the nearest shared pid, never 1, ...")
- **Session attachments: a nested session stays attached**: test/loop/attachments-nested.test.ts
- **Session attachments: attachment header**: test/slice/claim.test.ts ("a dead or ended attachment releases its launches with keep ...")
- **Session attachments: reconcile releases**: test/slice/claim.test.ts ("a dead or ended attachment releases its launches with keep ...")
- **Session attachments: status**: test/slice/claim.test.ts ("a dead or ended attachment releases its launches with keep ...")
- **Configuration route: PUT keys**: test/slice/config.test.ts ("prints the block without flags, adds rules with --allow, sets and clears keys, and relays a refusal")
- **Configuration route: PUT validation and recording**: test/slice/config.test.ts ("prints the block without flags, ...") and test/runs/lifecycle.test.ts ("passes configuration arguments as --set flags, ... and rejects start-only keys there")
- **Configuration route: command key flags**: test/slice/config.test.ts ("prints the block without flags, ...")
- **Configuration route: command data-dir value**: test/slice/operator.test.ts ("config --data-dir refuses a mistyped leaf when the daemon is addressed by url, ...")
- **Configuration route: command runner kind and commit policy**: test/slice/config.test.ts ("selects the runner kind, the codex sandbox, and the commit policy, ...")
- **Configuration route: a cleared key and its leaf in one call**: src/operator/cli.ts (the `--clear runnerKind with --commit` refusal) and test/runs/fold.test.ts
- **Configuration route: fold of the OpenCode arguments**: test/runs/fold.test.ts ("folds --commit under opencode, and --permission and --dataDir under opencode whatever the kind")
- **Configuration route: command usage names the kinds**: test/slice/config.test.ts ("selects the runner kind, ..." and "selects opencode with --permission and --data-dir, ...")
- **Configuration route: configure tool OpenCode arguments**: test/slice/operator-mcp.test.ts ("defaults a plugin-started opencode run to spawn ..., and takes the opencode leaves on configure")
- **Status report: toolchain and needsConfig**: test/slice/config.test.ts ("holds a submitted task without spending an attempt, reports needsConfig everywhere, and publishes once the command is set")
- **Status report: selection of each live launch**: test/loop/selection.test.ts ("a task selector wins over the run default, ...")
- **Status report: configuration without a graph**: src/operator/routes.ts (the `GET /v1/status` body without a graph spreads `configFacts(orch)`; the digest without a graph carries `needsConfig`)
- **Start arguments: passed at spawn or through the route**: test/runs/lifecycle.test.ts ("passes configuration arguments as --set flags, applies them through the route on a running daemon, and rejects start-only keys there")
- **Start arguments: command set flags**: test/slice/config.test.ts ("start accepts --set runnerKind=codex and the dotted codex keys")
- **Start arguments: daemon usage**: test/slice/config.test.ts ("config --set stores any key in the one PUT, ...") and src/main.ts (`USAGE`)
- **Start arguments: start tool runner arguments**: test/slice/operator-mcp.test.ts ("defaults a plugin-started opencode run to spawn ...")
- **Start arguments: mode note for codex and opencode**: test/slice/operator-mcp.test.ts ("defaults a plugin-started codex run to spawn, ...")
- **Requests from another origin: Host check on a loopback bind**: test/agent/server.test.ts ("on a 127.0.0.1 bind, the bound address and localhost with the port pass; other Hosts get 403 hostHeader")
- **Requests from another origin: no Host check on another bind**: test/agent/server.test.ts ("isLoopbackBind follows the stated rule" and "on a 0.0.0.0 bind there is no Host check, but Origin is still refused")
- **Requests from another origin: Host comparison**: test/agent/server.test.ts ("on a 127.0.0.1 bind, ..." and "on a loopback bind, the apiBaseUrl host passes beside the bound address")
- **Requests from another origin: rules applied before the route**: test/agent/server.test.ts ("a POST with an Origin header is answered 403 before the handler and before requestBegan")
- **Requests from another origin: the refusal answer**: test/agent/server.test.ts ("on a 127.0.0.1 bind, ...")
- **Configuration route: limit blocks passed by start**: test/runs/lifecycle.test.ts ("passes the limit blocks to a spawned daemon, and a pair refusal at spawn is readable from the error")
- **Configuration route: limit refusal readable at spawn**: test/runs/lifecycle.test.ts ("passes the limit blocks to a spawned daemon, and a pair refusal at spawn is readable from the error")
- **Configuration command: each leaf named once**: test/slice/config.test.ts ("config --set stores any key in the one PUT, and a leaf named twice is refused before anything is sent")
- **Configuration command: a bad set refused**: test/slice/config.test.ts ("config --set stores any key in the one PUT, ...")
- **Configuration command: usage names set**: test/slice/config.test.ts ("config --set stores any key in the one PUT, ...")
- **Status report: profile order and launched tasks**: test/slice/profile-hold.test.ts ("criterion 14: a pull-mode slice holds the task out of claimable until model and effort are set")
- **Status report: profiles with the hold off**: test/loop/profile-hold.test.ts ("criterion 1: with no key nothing is held; ...")
- **Status report: profile hold in force**: test/slice/profile-hold.test.ts ("criterion 14: ...")
- **Live launch guard: the two ending limits**: test/loop/health.test.ts ("health: a limit change that would end a live launch") and src/loop/orchestrator.ts (`wouldEnd` uses `elapsedMs`, `idleMsOf`, `exceedsTimeBudget` and `exceedsStuckFail`)
- **Live launch guard: the stuck flag limit is never refused**: test/loop/health.test.ts ("health: a limit change that would end a live launch")
- **Live launch guard: every shape of patch**: test/loop/health.test.ts ("health: a limit change that would end a live launch") ("clearing a raised stuck fail limit with a null health block is refused")
- **Live launch guard: read from the store**: test/loop/health.test.ts ("health: a limit change that would end a live launch") ("never refused: a waiting task, ...") and src/loop/orchestrator.ts (`wouldEnd` lists the store's `live` launches and asks no runner)
- **Live launch guard: only launches ended now**: test/loop/health.test.ts ("health: a limit change that would end a live launch") and src/loop/orchestrator.ts (`wouldEnd`)
- **Live launch guard: the refusal body**: test/slice/config.test.ts ("a limit change that would end a live launch is refused with wouldEnd unless endLive confirms it; ...")
- **Live launch guard: nothing applied on a refusal**: test/loop/health.test.ts ("health: a limit change that would end a live launch") ("a lowered time budget a live launch is past is refused with wouldEnd; nothing is applied")
- **Live launch guard: invalid and start-only patches answered first**: test/loop/health.test.ts ("health: a limit change that would end a live launch") ("a start-only key is refused first, with its own body")
- **Live launch guard: endLive is not a configuration key**: test/slice/config.test.ts ("a limit change that would end a live launch is refused ...")
- **Live launch guard: a change confirmed with endLive**: test/loop/health.test.ts ("health: a limit change that would end a live launch") ("with endLive the lowering is applied, recorded on the event, not stored, and the next tick ends the launch")
- **Live launch guard: endLive alone**: test/slice/config.test.ts ("a limit change that would end a live launch is refused ...")
- **Live launch guard: command option --end-live**: test/slice/config.test.ts ("a limit change that would end a live launch is refused ...")
- **Live launch guard: the route only**: src/runs/lifecycle.ts (`applyOverrides` puts each key of a refused runtime patch under `rejected` with the route's `error`) and src/operator/mcp-server.ts (the `start` tool has no `endLive` argument)
- **Profile hold default: stored choice written at start**: test/runs/lifecycle.test.ts ("writes the stored profile hold from orchestrator.yaml at every start, and keeps the last one when the line is removed")
- **Profile hold default: the stored choice belongs to the run**: test/runs/lifecycle.test.ts ("adopts --default-confirm-profile once, ...") and src/runs/lifecycle.ts (the flag is passed only from `opts.defaultConfirmProfile`)
- **Profile hold default: startDaemon option**: test/runs/lifecycle.test.ts ("adopts --default-confirm-profile once, ...")
- **Profile hold default: confirmProfile in the start result**: test/runs/lifecycle.test.ts ("adopts --default-confirm-profile once, ...")
- **Profile hold default: a run from before the hold**: test/slice/operator-mcp.test.ts ("a revival through a tool turns the profile hold on for a run that has no stored choice")

## Notes

- "Start arguments" says the daemon's usage SHALL list the keys `orchestrator-ctl start` takes as `--set` flags. At the base, the daemon's `USAGE` (src/main.ts) lists the claude, codex and limit keys but not the `opencode.*` leaves, and names `runnerKind` as "claude-code or codex". The sentence is moved unchanged (with its reference made explicit), and the new scenario of **Start arguments: daemon usage** states only what the code shows (the limit keys). The gap is reported as a follow-up, not fixed here.
- "Container mode" says the operator MCP server SHALL use a remote `ORCH_URL` without registering an attachment. At the base, `url()` in src/operator/mcp-server.ts returns the remote URL without calling `ensureAttached`, but `call()` registers the attachment with that URL when a response carries `x-orch-attachment: unknown`, which a remote daemon answers to an attachment it does not hold. The sentence is moved with only its reference made explicit, and the new scenario of **Container mode: operator server on a remote daemon URL** states only that no attachment is registered before the call. The gap is reported as a follow-up, not fixed here.

## Impact

Spec text only. No code, test, or other spec changes. The change is archived after the milestone review.
