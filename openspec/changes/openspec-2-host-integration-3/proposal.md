## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. In `host-integration`, 2 of the 157 requirements are still over the limit: "Codex host" (3633 characters) and "Work loop by runner kind" (5670 characters). This change splits each of them the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (task ORC-174 / GH-174, under ORC-139).

## What Changes

- Two requirements are MODIFIED. Each keeps its header and every scenario, names and text unchanged. Its description is cut to one behavior of at most 500 characters:

  | Requirement | Before | After | Scenarios kept | ADDED from it |
  |---|---|---|---|---|
  | Codex host | 3633 | 340 | 5 | 13 |
  | Work loop by runner kind | 5670 | 495 | 9 | 19 |

- 32 requirements are ADDED, one for each behavior moved out of those descriptions. Each is named after the MODIFIED requirement its text comes from, then a colon and the behavior it holds, a name `host-integration` does not have yet. Each has a description of at most 500 characters (the longest is 480) that holds SHALL or MUST, and one scenario of its own with a WHEN and a THEN step. Each scenario states behavior the code has at the base commit 8fd000d; the file that shows it is named under "Where each new scenario comes from".
- No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped or weakened: the two original descriptions hold 65 (30 and 35); the cut descriptions hold 6 (3 and 3) and the ADDED descriptions 59 (27 and 32), 65 in all.
- No other requirement of `host-integration` changes, and no file outside this change directory changes.

### Splits and lead-ins

No sentence of the two originals is longer than 500 characters on its own (the longest, item 8's first sentence of "Work loop by runner kind", is 424), so no sentence is split at its semicolons, between list items or at another clause joint. Every moved sentence is moved whole.

- The list of "Work loop by runner kind" has no lead-in: its items follow the opening paragraph and each carries its own SHALL. Each item moved is split between its sentences only where the item with its sentences would pass 500 characters, and its "- " list marker is dropped, since an ADDED description is a paragraph and not a list. No lead-in is added.
- One moved sentence has no SHALL or MUST of its own: item 8, sentence 2 of "Work loop by runner kind" ("A review is a node in `awaitingReview` ..."). It defines the review of item 8's first sentence, which with it would be 634 characters, so it cannot stay there. It is carried by the SHALL sentence that follows it in the original, item 8, sentence 3 ("The log line SHALL name the kind."), in **Work loop by runner kind: reviews and the stop log**, so no SHALL is added at a joint. Both sentences have their references made explicit there, since the stop sentence they qualify is in another requirement: "A review is" becomes "A review in the stop rule of a loop is", and "The log line SHALL" becomes "The log line of a loop that stops SHALL".
- One other sentence with no SHALL, item 5, sentence 3 ("No env file is written."), stays after the SHALL sentence it follows, in **Work loop by runner kind: opencode environment**.
- Paragraph 4, sentence 1 of "Codex host" ends "with the behaviour of "Skills" except as follows". It stays with the two exceptions that follow it (sentences 2 and 3) in **Codex host: skills**; each later exception moves to its own ADDED requirement with its subject made explicit ("The Codex skills"), so it reads right alone.
- Every other change is a reference made explicit: "It", "They", "Their", "Both adapters", "The environment", "Either way", "A review" or "The log line" replaced by what it names. Each one is listed below.

### Moved sentences

Sentences are numbered from 1 in each paragraph of "Codex host" (paragraphs 1 to 4), and in the opening paragraph and each list item (items 1 to 11) of "Work loop by runner kind". *Unchanged* means word for word. *Explicit* means only a reference was made explicit; the replaced words are named. Every sentence either stays in its MODIFIED description or moves to exactly one ADDED requirement.

#### Codex host

Stays in the MODIFIED description (340 characters), unchanged: sentences 1 to 3 of the opening paragraph.

Moved:

- paragraph 1, sentence 4, unchanged: "`hosts/codex/package.json` SHALL be private, named for the host and not for the package, and SHALL have the published package as its only dependency, pinned to the exact version the Claude Code plugin pins." → **Codex host: host package**
- paragraph 1, sentence 5, unchanged: "`hosts/codex/node_modules` SHALL be ignored by git." → **Codex host: host package**
- paragraph 2, sentence 1, unchanged: "`hosts/codex/` SHALL be installable as the Codex plugin of "Codex plugin manifest"." → **Codex host: installable plugin**
- paragraph 2, sentence 2, unchanged: "`hosts/codex/config.toml` SHALL be the manual registration template." → **Codex host: registration template**
- paragraph 2, sentence 3, explicit ("It SHALL declare" becomes "`hosts/codex/config.toml` SHALL declare"): "It SHALL declare `[mcp_servers.orchestrator_operator]` with `command = "node"`, `args` set to the launcher and `mcp`, `startup_timeout_sec = 30`, and a `tool_timeout_sec` of at least `ceil(WAIT_CAP_MS / 1000) + 30`." → **Codex host: registration template**
- paragraph 2, sentence 4, unchanged: "The id SHALL use an underscore, so the tools are `mcp__orchestrator_operator__<tool>`." → **Codex host: registration template**
- paragraph 3, sentence 1, unchanged: "`hosts/codex/README.md` SHALL lead with the plugin install: `codex plugin marketplace add autodidacticon/orchestrator` and `codex plugin add orchestrator-codex@orchestrator`." → **Codex host: README plugin install**
- paragraph 3, sentence 2, explicit ("It SHALL say" becomes "`hosts/codex/README.md` SHALL say"): "It SHALL say that the plugin's operator server runs in the plugin root, so the tools take `repo` and the skills pass it, and SHALL document the approval keys `codex exec` needs for a plugin's server, under `plugins."orchestrator-codex@orchestrator".mcp_servers.orchestrator_operator`." → **Codex host: README plugin install**
- paragraph 3, sentence 3, explicit ("It SHALL tell" becomes "`hosts/codex/README.md` SHALL tell"): "It SHALL tell users who have `orchestrator@orchestrator` installed in Codex to remove it with `codex plugin remove orchestrator@orchestrator`." → **Codex host: README removal of the old plugin**
- paragraph 3, sentence 4, explicit ("It SHALL keep" becomes "`hosts/codex/README.md` SHALL keep"): "It SHALL keep the template block as the manual alternative, and `codex mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=<ms below 60000> -- node <hosts/codex>/bin/orchestrator.mjs mcp` as the alternative for a registration that keeps Codex's 60-second default tool timeout." → **Codex host: README manual registration**
- paragraph 3, sentence 5, explicit ("It SHALL document" becomes "`hosts/codex/README.md` SHALL document"): "It SHALL document verification with `codex mcp get orchestrator_operator`, and the approval keys `codex exec` needs for a manually registered server." → **Codex host: README manual registration**
- paragraph 4, sentence 1, unchanged: "`hosts/codex/skills/` SHALL hold `import`, `run`, and `review` skills, named `orchestrator-import`, `orchestrator-run`, and `orchestrator-review`, with the behaviour of "Skills" except as follows." → **Codex host: skills**
- paragraph 4, sentence 2, explicit ("They SHALL NOT" becomes "The Codex skills SHALL NOT"): "They SHALL NOT reference `${CLAUDE_PLUGIN_ROOT}`." → **Codex host: skills**
- paragraph 4, sentence 3, explicit ("They SHALL have" becomes "The Codex skills SHALL have"): "They SHALL have no Workflow or subagent section and SHALL name no Claude model as a default." → **Codex host: skills**
- paragraph 4, sentence 4, explicit ("They SHALL look" becomes "The Codex skills SHALL look"): "They SHALL look for the test command in `AGENTS.md`, with `CLAUDE.md` only as the fallback when there is no `AGENTS.md`." → **Codex host: skill test command and toolchain**
- paragraph 4, sentence 5, explicit ("Their toolchain line" becomes "The Codex skills' toolchain line"): "Their toolchain line SHALL always name the runner kind." → **Codex host: skill test command and toolchain**
- paragraph 4, sentence 6, explicit ("They SHALL pass" becomes "The Codex skills SHALL pass"): "They SHALL pass `repo` on every operator call, as "Skills pass the repository" defines." → **Codex host: skills pass repo**
- paragraph 4, sentence 7, explicit ("they SHALL call `start` with" becomes "the Codex skills SHALL call `start` with"): "When no daemon is running and `orchestrator.yaml` sets no `runner.mode`, they SHALL call `start` with `mode: "spawn"`, so that the daemon runs the agents headless; otherwise they SHALL call `start` without `mode`, because an explicit mode overrides the file and is applied to a running daemon." → **Codex host: skill start mode**
- paragraph 4, sentence 8, explicit ("they SHALL say so" becomes "the Codex skills SHALL say so"): "When the mode in force is `pull` or `mixed` they SHALL say so, SHALL name the work loop (`orchestrator-work`, "Work loop by runner kind") as the way codex launches are worked in those modes, and SHALL offer `spawn` unless another session holds launches of the run." → **Codex host: skills in pull or mixed mode**
- paragraph 4, sentence 9, explicit ("They SHALL say" becomes "The Codex skills SHALL say"): "They SHALL say that under `codex exec` the operator tools run only when approvals are pre-granted (`approval_policy = "never"`, `default_tools_approval_mode = "approve"`, and per-tool `approval_mode = "approve"`), and that an interactive session prompts instead." → **Codex host: approvals under codex exec**
- paragraph 4, sentence 10, unchanged: "The `import` skill SHALL name the Codex form of the tracker connectors' tools (`mcp__linear__`, `mcp__atlassian__`)." → **Codex host: import skill connectors**

#### Work loop by runner kind

Stays in the MODIFIED description (495 characters), unchanged: sentences 1 to 3 of the opening paragraph.

Moved:

- list item 1, sentence 1, explicit ("It SHALL take" becomes "The work loop SHALL take"; its "- " list marker is dropped): "It SHALL take `--runner <codex|opencode>`, with `codex` as the default so that an invocation without the flag behaves as before, and SHALL refuse any other kind." → **Work loop by runner kind: runner flag**
- list item 1, sentence 2, unchanged: "`--help` SHALL name the flag and its default." → **Work loop by runner kind: runner flag**
- list item 1, sentence 3, explicit ("It SHALL take" becomes "The work loop SHALL take"): "It SHALL take `--workers`, `--run-tag` and `--capacity`, and SHALL clamp the worker count to the capacity when one is given, logging the clamp." → **Work loop by runner kind: worker and daemon flags**
- list item 1, sentence 4, explicit ("It SHALL take" becomes "The work loop SHALL take"): "It SHALL take `--max-silence-ms` (see "Work loop ends a hung agent"), and `--help` SHALL name it." → **Work loop by runner kind: worker and daemon flags**
- list item 1, sentence 5, explicit ("It SHALL find" becomes "The work loop SHALL find"): "It SHALL find the daemon by `--url`, `ORCH_URL`, or the run directory of `--repo` (default: the current directory)." → **Work loop by runner kind: worker and daemon flags**
- list item 2, sentence 1, explicit ("It SHALL find" becomes "The work loop SHALL find"; its "- " list marker is dropped): "It SHALL find the kind's runner module (`src/runner/<kind>.ts` under tsx in a checkout, else `dist/src/runner/<kind>.js`) and SHALL keep everything that differs by kind in one adapter per kind: the claim's settings block, `prepare` (the shim's inputs and the environment additions), `compose` (the shell command), whether a turn began, `parseUsage` and `classifyFailure`." → **Work loop by runner kind: kind adapters**
- list item 2, sentence 2, explicit ("Both adapters" becomes "Both adapters of the work loop, codex and opencode,"): "Both adapters SHALL use the functions the runner modules export, so that a claimed launch and a spawned one are composed by the same code." → **Work loop by runner kind: adapters use the runner modules**
- list item 3, sentence 1, explicit ("It SHALL run" becomes "The work loop SHALL run"; its "- " list marker is dropped): "It SHALL run one loop per worker in one process, starting the n-th loop's first claim (n-1)·300 ms late." → **Work loop by runner kind: loops in one process**
- list item 3, sentence 2, unchanged: "Each loop SHALL claim over `POST /v1/claims` with `workerId <runTag>-<n>`, `access: "local"` and `runner` set to the chosen kind." → **Work loop by runner kind: loops in one process**
- list item 4, sentence 1, unchanged but for its "- " list marker, which is dropped: "For a codex claim the loop SHALL write the shim env file from the claim's `codex.env` and run `codex exec` in the claimed worktree, composed by `composeCodexCommand(launch, policy)` from the claim's `codex.settings`, `codex.maxWaitMs`, `model` and `effort`." → **Work loop by runner kind: codex claim**
- list item 5, sentence 1, unchanged but for its "- " list marker, which is dropped: "For an opencode claim the loop SHALL build the per-launch config with `openCodeConfig(opencode.settings, opencode.allowedTools, opencode.maxWaitMs)`, write it through `prepareOpenCodeLaunch` (`.orchestrator/opencode.json`, 0600), and run `opencode run` in the claimed worktree, composed by `composeOpenCodeCommand(launch, policy)` from `opencode.settings`, `model` and `effort`." → **Work loop by runner kind: opencode config**
- list item 5, sentence 2, explicit ("The environment SHALL" becomes "The environment of `opencode run` for an opencode claim SHALL"): "The environment SHALL carry the claim's `opencode.env` (from which the shim, an MCP child that inherits it, takes `ORCH_API`, `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_RETRY_WINDOW_MS` and `ORCH_COMMIT_POLICY`) and the additions `prepareOpenCodeLaunch` returns: `OPENCODE_CONFIG_CONTENT`, and `XDG_DATA_HOME` or `XDG_CONFIG_HOME` when the settings ask for them." → **Work loop by runner kind: opencode environment**
- list item 5, sentence 3, unchanged: "No env file is written." → **Work loop by runner kind: opencode environment**
- list item 6, sentence 1, explicit ("Either way the loop" becomes "For a codex or an opencode claim the loop"; its "- " list marker is dropped): "Either way the loop process's own `ORCH_*` variables SHALL be dropped from the child environment." → **Work loop by runner kind: child environment and prompt file**
- list item 6, sentence 2, unchanged: "Stdin SHALL be a short preamble followed by the brief, redirected from `.orchestrator/<kind>-work-prompt.md`." → **Work loop by runner kind: child environment and prompt file**
- list item 6, sentence 3, unchanged: "The preamble SHALL name the launch, say that the orchestrator MCP server's tools carry its credentials (for opencode by their names `orchestrator_heartbeat`, `orchestrator_report`, `orchestrator_block`, `orchestrator_inbox`, `orchestrator_log`), say to stop on a 401, and say to retry rather than write a fallback report file." → **Work loop by runner kind: preamble**
- list item 6, sentence 4, explicit ("It SHALL carry" becomes "The preamble SHALL carry"): "It SHALL carry the claim's `pending` question or answer when there is one." → **Work loop by runner kind: preamble**
- list item 7, sentence 1, unchanged but for its "- " list marker, which is dropped: "After the agent exits, the loop SHALL post the usage (codex: summed over `turn.completed` lines; opencode: summed over `step_finish` events by `parseOpenCodeUsage`) to `POST /v1/launches/:id/usage` with its worker id." → **Work loop by runner kind: usage after exit**
- list item 7, sentence 2, unchanged: "When the loop did not end the agent itself and the launch is still held and running or waiting, the loop SHALL release it: with `keep: true` when the agent failed to start (codex: no turn began; opencode: no event, that is `exitBeforeTurn` or `startupContended`), and without keep when it ran but did not report." → **Work loop by runner kind: release after exit**
- list item 7, sentence 3, unchanged: "The release reason SHALL name the failure `classifyCodexFailure` or `classifyOpenCodeFailure` gave." → **Work loop by runner kind: release after exit**
- list item 7, sentence 4, unchanged: "After a `startupContended` release the loop SHALL wait between 0.5 and 1.5 s before it claims again." → **Work loop by runner kind: contended back-off**
- list item 8, sentence 1, unchanged but for its "- " list marker, which is dropped: "A loop SHALL stop when the run is finished or stalled; or when nothing is claimable for its kind (`claimableByKind.<kind>` is 0), nothing is being prepared for it (`preparingByKind.<kind>` is 0; a status without the field counts as 0), no launch of that kind is live, no task is awaiting the verifier (`status.verifying` is empty), and a question or review waits on a human; or when that quiet has lasted `--idle-exit-ms`." → **Work loop by runner kind: stop rule**
- list item 8, sentence 2, explicit ("A review is" becomes "A review in the stop rule of a loop is"): "A review is a node in `awaitingReview` that is not in `verifying`; a submitted task awaiting its check waits on no human, and its result can make a dependent claimable or send the task back for another launch." → **Work loop by runner kind: reviews and the stop log**
- list item 8, sentence 3, explicit ("The log line SHALL" becomes "The log line of a loop that stops SHALL"): "The log line SHALL name the kind." → **Work loop by runner kind: reviews and the stop log**
- list item 8, sentence 4, explicit ("It SHALL also stop" becomes "A loop SHALL also stop"): "It SHALL also stop after `--max-failures` launches in a row that ended without the agent running or reporting; a contended start counts, and so does an agent the loop ended as hung." → **Work loop by runner kind: failures in a row**
- list item 9, sentence 1, unchanged but for its "- " list marker, which is dropped: "While nothing is claimable a loop SHALL long-poll `GET /v1/events` instead of spinning." → **Work loop by runner kind: long-poll**
- list item 9, sentence 2, unchanged: "The poll SHALL be filtered to the `launch.claimable`, `launch.ended` and `launch.released` kinds, so that other loops' claim events do not wake it." → **Work loop by runner kind: long-poll**
- list item 10, sentence 1, unchanged but for its "- " list marker, which is dropped: "On SIGINT or SIGTERM the process SHALL end its agents' process groups (SIGTERM, then SIGKILL after a grace period) and release their launches with `keep: true`." → **Work loop by runner kind: signals**
- list item 11, sentence 1, unchanged but for its "- " list marker, which is dropped: "The Codex host's run skill SHALL document the loop as the way to work a `pull` or `mixed` codex run, and the OpenCode host's run skill and README SHALL document `--runner opencode` as the way to work a `pull` or `mixed` opencode run." → **Work loop by runner kind: run skills document the loop**

### Where each new scenario comes from

At the base commit 8fd000d:

- "Host package checked": `test/host/codex-host.test.ts` ("package.json pins the published package at the Claude Code plugin's version, and the launcher reads it").
- "Plugin manifest read": `test/host/codex-host.test.ts` ("the Codex plugin: manifest at the package version, .mcp.json run from the plugin root, ...").
- "Template parsed": `test/host/codex-host.test.ts` ("the config template registers the operator server through the launcher with a tool timeout above the wait cap").
- "README names the plugin install and its approval keys", "README names the removal": `test/host/codex-host.test.ts` ("the Codex plugin: manifest at the package version, ...", the README words).
- "README keeps the manual alternatives": `test/host/codex-host.test.ts` ("the skill edition is Codex-specific: ...", the README words).
- "Codex skill editions", "CLAUDE.md only beside AGENTS.md", "Import skill names the Codex tool prefixes": `test/host/codex-host.test.ts` ("the skill edition is Codex-specific: no plugin root, no workflow or subagents, no Claude model names, AGENTS.md first").
- "Each skill says to pass repo": `test/host/codex-host.test.ts` ("the skills tell the model to pass repo, the session's working directory, on every operator call").
- "No daemon and no mode in the file", "Pull mode offers spawn or the loop", "Approval refusal explained": `hosts/codex/skills/run/SKILL.md` (the approvals paragraph and "## 1. Start").
- "Runner kind parsed": `test/host/work-loop.test.ts` ("--runner defaults to codex and accepts opencode; another kind is refused", "--help names --runner <codex|opencode> with codex as the default").
- "Daemon found from the run directory": `hosts/codex/bin/work.mjs` (`runWork` calls `resolveUrl({ repo })` without `--url` or `ORCH_URL`), `src/operator/cli.ts` (`resolveUrl`).
- "Kind module resolved": `test/host/work-loop.test.ts` ("packageModules resolves the kind module").
- "Claimed opencode command composed as spawned": `test/host/work-loop.test.ts` ("composeOpenCodeCommand in the loop": "is the command the OpenCode runner spawns, with the brief swapped for the loop prompt").
- "Staggered claims": `hosts/codex/bin/work.mjs` (`loop` sleeps `(n - 1) * 300` ms; `cycle` posts `{ workerId, access: 'local', runner: kind }`).
- "Codex claim prepared": `hosts/codex/bin/work.mjs` (`makeAdapter` codex `prepare` calls `writeCodexShimEnv`, `compose` calls `composeCodexCommand`; the child is spawned with `cwd: c.worktree`).
- "Per-launch opencode config written": `src/runner/opencode.ts` (`prepareOpenCodeLaunch` writes `.orchestrator/opencode.json` with mode 0600), `test/host/work-loop.test.ts` ("a claimed opencode launch runs the composed opencode run with the per-launch config, ...": cwd and argv).
- "Shim identity from the environment": `test/host/work-loop.test.ts` (same test: `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_API`, no `XDG_DATA_HOME` or `XDG_CONFIG_HOME`).
- "Loop ORCH variables dropped": `hosts/codex/bin/work.mjs` (`agentProcessEnv` drops every `ORCH_*` of the loop's environment), `test/host/work-loop.test.ts` (same test: no `ORCH_URL`, stdin equals the prompt file and ends with the brief).
- "Preamble with a pending question": `test/slice/codex-work.test.ts` ("the preamble names the launch, the 401 rule, and the fallback-file rule"), `test/host/work-loop.test.ts` ("the opencode preamble names the orchestrator_<tool> names ...").
- "OpenCode usage posted by the worker": `test/host/work-loop.test.ts` ("a claimed opencode launch runs ..., and its usage is posted with source worker").
- "Ran but did not report": `hosts/codex/bin/work.mjs` (`work`: a held launch whose agent started is released without keep, reason `<kind> exited without a report[: <reason>]`).
- "Back-off after a contended start": `hosts/codex/bin/work.mjs` (`cycle` sleeps `500 + Math.floor(Math.random() * 1000)` after `contended`).
- "Quiet with an open question", "A verifying task is not a review": `test/slice/codex-work.test.ts` ("stops on finished or stalled, on quiet with a human wait, or after the idle window"), `test/host/work-loop.test.ts` ("the stop rule reads the chosen kind").
- "Contended starts count as failures": `hosts/codex/bin/work.mjs` (`cycle` counts every result but `started`, and logs "<n> launches in a row ended without <kind> running or reporting; this loop stops").
- "Filtered wait for events": `hosts/codex/bin/work.mjs` (`WAKE_KINDS` and the `GET /v1/events?...&kinds=${WAKE_KINDS}&wait=${opts.pollMs}` call).
- "Stopped while an agent runs": `hosts/codex/bin/work.mjs` (`onSignal` calls `killGroup`, `KILL_GRACE_MS = 5000`; `work` releases a held launch with keep and reason "the <kind> work loop was stopped").
- "Run skills name the loop": `hosts/codex/skills/run/SKILL.md`, `hosts/opencode/skills/run/SKILL.md`, `hosts/opencode/README.md`.

## Capabilities

### New Capabilities

### Modified Capabilities

- `host-integration`: "Codex host" and "Work loop by runner kind" have their descriptions cut to one behavior each; the moved behaviors become 32 ADDED requirements. What the spec requires is unchanged.

## Impact

Only `openspec/changes/openspec-2-host-integration-3/`. No code changes.
