## MODIFIED Requirements

### Requirement: OpenCode host
`hosts/opencode/` SHALL let an OpenCode session be the operator. It SHALL ship `bin/orchestrator.mjs`, the third copy of the launcher of "Plugin launcher", whose npx fallback is pinned to the version of the published package in `hosts/opencode/package.json`. `hosts/opencode/skills/` SHALL hold `import`, `run`, and `review` skills named `orchestrator-import`, `orchestrator-run`, and `orchestrator-review`.

#### Scenario: OpenCode registration verified
- **WHEN** `OPENCODE_CONFIG` names the snippet with `<hosts/opencode>` filled in and `opencode mcp list` is run
- **THEN** it reports `orchestrator_operator` as `connected` with the launcher command

#### Scenario: operator server answers in an OpenCode session
- **WHEN** `opencode run` runs with the snippet as its config and is asked to call `orchestrator_operator_start` with `mode: "spawn"`
- **THEN** its `tool_use` event names `orchestrator_operator_start`, completed, and the result reports `mode: "spawn"`

#### Scenario: Skill editions held in step
- **WHEN** the Codex edition of a skill is changed in a block the OpenCode edition shares
- **THEN** the host test fails until the OpenCode edition carries the same change

#### Scenario: Rewritten block pinned
- **WHEN** a word is changed inside a rewritten block of an OpenCode skill, outside the phrase that names the block
- **THEN** the host test fails, naming the block, until its pinned hash is updated

#### Scenario: Notice appended once
- **WHEN** the plugin sees `session.created` and then two `chat.message` calls for that session while a run needs attention
- **THEN** the first message's text part ends with the start line, the second is untouched, and one toast shows the line

#### Scenario: Nothing needs attention
- **WHEN** the plugin runs with an `ORCH_HOME` that holds no run
- **THEN** the user's message part is unchanged and no toast is shown

#### Scenario: Worker launch not pure
- **WHEN** `runner.opencode.pure` is `false` and an opencode worker launch is composed
- **THEN** the command carries no `--pure`, so a globally installed session plugin loads into the worker unless `runner.opencode.ignoreUserConfig` is `true`

### Requirement: Codex plugin hooks
`hosts/codex/hooks/hooks.json` SHALL run `hooks/session-start.mjs` (matcher `startup|resume|clear`, ten-second timeout) on `SessionStart` with `node` through `${PLUGIN_ROOT}`.

#### Scenario: Hooks parse
- **WHEN** the host tests read `hosts/codex/hooks/hooks.json`
- **THEN** it declares exactly the two hooks, each command naming its script under `${PLUGIN_ROOT}/hooks/`, SessionStart with timeout 10 and SessionEnd with timeout 3

#### Scenario: SessionStart line through the installed plugin
- **WHEN** `ORCH_E2E_CODEX_HOST=1`, the plugin is installed from the marketplace file into a scratch `CODEX_HOME` whose hooks are not trusted, `ORCH_HOME` holds a run whose daemon exited with two launches parked, and `codex exec --dangerously-bypass-hook-trust` runs without `--ephemeral`
- **THEN** the session's rollout holds one hook additional-context message: the SessionStart line naming that run, with its two parked launches

### Requirement: Codex plugin MCP server
`hosts/codex/.mcp.json` SHALL declare exactly one server, `orchestrator_operator`, with `command: "node"`, `args: ["./bin/orchestrator.mjs", "mcp"]`, and `cwd: "."`, because Codex resolves `cwd: "."` to the installed plugin root and expands no variable in `args`.

#### Scenario: Server runs from the plugin root
- **WHEN** the plugin is installed and `codex mcp get orchestrator_operator --json` is run
- **THEN** its `cwd` is the installed plugin root, its args are `./bin/orchestrator.mjs` and `mcp`, `startup_timeout_sec` is 60, and `tool_timeout_sec` is 180

#### Scenario: Start through the plugin names the repository
- **WHEN** the installed plugin's launcher runs this checkout's build, its tools are pre-approved under the plugin's key, and `codex exec -C <throwaway repository>` is asked to call `start` with `repo` set to that repository
- **THEN** the `start` call's arguments carry the repository and its result has status 200 and names the repository

#### Scenario: Forwarded variables pinned
- **WHEN** the host tests read `hosts/codex/.mcp.json`
- **THEN** `env_vars` is `PATH`, `HOME`, `ORCH_HOME`, `ORCH_WAIT_CAP_MS`, `ORCH_REPO`, `ORCH_URL`, `CODEX_HOME`, `CODEX_API_KEY`

### Requirement: Work loop silence limit
The work loop's silence limit SHALL follow this rule, in this order. `--max-silence-ms` when given SHALL win and SHALL never be replaced; `--max-silence-ms 0` SHALL turn the limit off. Else, when the claim carries no `health` field, the limit SHALL be 45 minutes (the daemon's default `health.stuckFailAfterMs`) and the loop SHALL NOT read `status` for it. The loop SHALL log one line when its limit changes.

#### Scenario: The claim names no threshold
- **WHEN** the loop runs without `--max-silence-ms` against a daemon whose claim carries no `health`
- **THEN** the silence limit is 45 minutes, whatever `status` says

#### Scenario: Silence past the limit
- **WHEN** the loop runs with `--max-silence-ms 5000` and the claimed agent writes nothing for longer while its task runs and the launch is still held
- **THEN** the loop ends the agent's process group, releases the launch with `keep: false` and a reason naming the silence, and claims the next launch

#### Scenario: A raise during silence
- **WHEN** the loop runs without `--max-silence-ms`, claims under `health.stuckFailAfterMs: 4000`, and the operator raises it to 60000 through `PUT /v1/config` while the agent is silent
- **THEN** the loop logs the new limit, and does not end the agent when 4000ms of silence have passed

#### Scenario: Status names 0
- **WHEN** the loop runs without `--max-silence-ms` and `status` answers `budgets.stuckFailAfterMs: 0`
- **THEN** the silence limit is 45 minutes, not off

#### Scenario: A fixed limit is not replaced
- **WHEN** the loop runs with `--max-silence-ms 4000` and the operator raises `health.stuckFailAfterMs` to 60000 while the agent is silent
- **THEN** the loop ends the agent after 4000ms of silence

#### Scenario: Status cannot be read
- **WHEN** the loop's `status` read fails or answers without a number at `budgets.stuckFailAfterMs`
- **THEN** the silence limit stays what it was

### Requirement: Work loop renews the lease
While a claimed launch's agent process lives, `orchestrator-work` SHALL call `POST /v1/launches/:id/renew` with the launch token every `renewEveryMs` from the claim (else a third of `leaseTtlMs`), with one request in flight. It SHALL stop when the agent process exits, even while another process (a grandchild) still holds its output pipes, and when the process fails to spawn. It SHALL stop for good on 401, 404 or 409. A network error SHALL be a missed beat.

#### Scenario: A silent agent keeps its launch
- **WHEN** the loop runs an agent that writes nothing and calls nothing under `leaseTtlMs: 1500` and `--max-silence-ms 6000`
- **THEN** the daemon does not expire the launch; the loop ends the agent at its silence limit and releases the launch (`endReason: "released"`) no sooner than 6000ms after the claim, and the launch's `progressAt` is still its claim time

#### Scenario: A grandchild holds the pipe
- **WHEN** the agent exits without a report, leaving a grandchild that keeps its stdout open, under `leaseTtlMs: 1500` and `--max-silence-ms 20000`
- **THEN** the loop stops renewing at the exit, the daemon ends the launch with `leaseExpired` well before the silence limit, and the loop does not release it

#### Scenario: A killed loop's claim expires
- **WHEN** the loop process is killed with SIGKILL while its detached agent still runs
- **THEN** the daemon ends the launch with `leaseExpired` within `leaseTtlMs` plus a tick, with margin for load, and the attempt is spent because nothing in the worktree changed

#### Scenario: Renewal stops on refusal
- **WHEN** a renewal answers 401, 404 or 409
- **THEN** the loop sends no further renewal for that launch

### Requirement: Run skill handles a Linear project-milestone root
The `run` skill SHALL treat a Linear effect whose `url` is a project URL (its path holds `/project/` and not `/issue/`) as an effect for a project-milestone root. It SHALL never change the project's state: every `setState` effect for such a root SHALL be acknowledged with `ack { id, result: { applied: false, reason } }`. A Linear effect with an issue URL SHALL follow the existing rules.

#### Scenario: Done for a project root
- **WHEN** the outbox lists `setState done` for a root whose `url` holds `/project/`
- **THEN** the skill acknowledges it with `applied: false` and a reason, and the project is unchanged

#### Scenario: In progress for a project root
- **WHEN** the outbox lists `setState inProgress` for a root whose `url` holds `/project/`
- **THEN** the skill acknowledges it with `applied: false` and a reason, and the project is unchanged

#### Scenario: Ready for review comment
- **WHEN** the outbox lists the ready-for-review comment for a root whose `url` holds `/project/`
- **THEN** the skill posts nothing and acknowledges it with `applied: false` and a reason

#### Scenario: Accepted comment
- **WHEN** the outbox lists a comment opening "Milestone accepted:" for a project root
- **THEN** the skill posts a project status update with the body, a blank line and the marker as the last line, and acknowledges with `statusUpdateId`

#### Scenario: Rejected comment
- **WHEN** the outbox lists a comment opening "Milestone rejected:" for a project root
- **THEN** the skill posts a project status update with the body, a blank line and the marker as the last line, and acknowledges with `statusUpdateId`

#### Scenario: Marker already posted
- **WHEN** a recent status update of the project already holds the effect's marker
- **THEN** the skill acknowledges with that update's id and posts no second update

#### Scenario: Issue URL
- **WHEN** a Linear effect has a `url` holding `/issue/`
- **THEN** the skill follows the existing state-type and comment rules

### Requirement: Work loop silence leaves out a sleep
As an exception to "Work loop ends a hung agent" and "Work loop silence limit", the work loop SHALL leave a sleep of its own machine out of an agent's silence. The loop SHALL note its own clock for each running agent at spawn, every second (or every quarter of the threshold when that is shorter), and immediately before each verdict of the watcher. `--gap-after-ms 0` SHALL turn the rule off.

#### Scenario: A sleep longer than the limit
- **WHEN** the agent wrote output, then the machine slept for twice the silence limit, and the loop notes its clock after the wake
- **THEN** the sleep is left out of the silence, the silence is below the limit, the loop logs the length it left out, and the loop does not end the agent
- **AND** the agent is ended when it then stays silent for the limit while the machine is awake

#### Scenario: Silence while awake
- **WHEN** the machine stays awake and the agent writes nothing for longer than the silence limit, with the loop's notes one second apart
- **THEN** no gap is found, the silence equals the wall time, and the loop ends the agent and releases the launch without keep

#### Scenario: A slow look of the watcher is not a sleep
- **WHEN** the machine is awake and a look of the watcher takes more than a minute because the daemon is unreachable
- **THEN** the per-agent timer's notes stay one second apart, no gap is found, and the silence limit applies as before

#### Scenario: The rule turned off
- **WHEN** the loop runs with `--gap-after-ms 0` and the machine sleeps for twice the silence limit
- **THEN** the sleep counts as silence and the loop ends the agent as it did before this rule

### Requirement: Run skill offers a raised limit
Each run skill SHALL hold, in its monitor list after the stuck bullet, a bullet that starts with `- **a launch needs more time**`. It SHALL tell the agent to compare, whenever it reads `status`, each running launch's `elapsedMs` in `liveLaunches` with `budgets.maxLaunchMs` when that is above 0, and to tell the user when less than 15 minutes remain, and to offer the same when the user wants a stuck launch to keep running. The stuck bullet SHALL point to the new bullet.

#### Scenario: The bullet in each edition
- **WHEN** the bullet is cut out of each run skill
- **THEN** it holds `configure`, `health.stuckFailAfterMs`, `budgets.maxLaunchMs`, `elapsedMs`, `applied` and `null`; the Claude Code bullet holds `leaseTtlMs`, and the Codex and OpenCode bullets hold `orchestrator-work` and not "this session's workers"

### Requirement: Run skill confirms a lowering with the user
The bullet `- **a launch needs more time**` of each run skill SHALL say that a lowered, cleared or switched-on limit that a live launch is already past is refused with a 409 whose `wouldEnd` lists the launches it would end and that nothing is applied, that the agent shows `wouldEnd` to the user, and that it sends the call again with `endLive: true` only when the user says so. A session SHALL NOT add `endLive` by itself after a 409.

#### Scenario: The refusal is shown
- **WHEN** the bullet is cut out of each run skill
- **THEN** it holds `wouldEnd` and `endLive` and says to send `endLive` only when the user says so

#### Scenario: The confirmed change
- **WHEN** the user, shown `wouldEnd`, says to go on
- **THEN** the skill has the agent send the same call with `endLive: true`

#### Scenario: Clearing a raise
- **WHEN** the agent clears a raise with a null leaf once a launch has reported, and another live launch relies on the raise
- **THEN** the 409 with `wouldEnd` is shown to the user, and `endLive` is sent only on the user's say

### Requirement: Run skill: workers are told of a limit change
The bullet **a launch needs more time** of each run skill SHALL say that the daemon tells each affected worker of a changed limit through its inbox, as a `nudge` notice the worker sees on its next inbox call, and SHALL NOT tell the session to send a nudge with the new limit. The Claude Code edition SHALL keep its sentence on the lease of this session's workers.

#### Scenario: The session does not send the new limit
- **WHEN** the session raises `budgets.maxLaunchMs` for a launch that needs more time
- **THEN** the skill tells it that the daemon has told the worker through its inbox, and does not tell it to `nudge` the worker

#### Scenario: A loop started with a fixed limit
- **WHEN** the session raises `health.stuckFailAfterMs` for a launch held by an `orchestrator-work` loop
- **THEN** the Codex and OpenCode skills say the loop follows the new limit unless it was started with `--max-silence-ms`

### Requirement: Run skill asks for a held profile
Each run skill (Claude Code, Codex, OpenCode) SHALL hold one paragraph that starts with `**Worker profile.**`, directly after the paragraph that starts "Tell the user who is executing the work". No existing paragraph or bullet SHALL change, and the Codex and OpenCode blocks SHALL be equal after the edition substitutions.

#### Scenario: The paragraph read alone

- **WHEN** the **Worker profile.** paragraph is cut out of any of the three run skills
- **THEN** it holds `confirmProfile`, `status.profiles`, `held`, `missing`, `modelSource`, `configure`, `runner.confirmProfile`, `orchestrator.yaml` and the words "model of this session"

#### Scenario: The work skill bullet

- **WHEN** the **Worker profile.** bullet is cut out of the Claude Code work skill
- **THEN** it holds `status.profiles` and `held: true`

### Requirement: Import skill reports held tasks
Each import skill SHALL hold one paragraph in section 5 that starts with `**Held tasks.**`, directly before "Then offer to run it": the session calls `status` after the import and, when `status.profiles` has an entry with `held: true`, tells the user how many tasks are held and that the daemon will not launch them, asks for the keys in `missing` and applies the answer with `configure`, never choosing from the model of this session.

#### Scenario: The blocks read alone

- **WHEN** the **Worker profile.** bullet and the **Held tasks.** paragraph are cut out of any of the three import skills
- **THEN** the bullet holds `confirmProfile`, `default` and `configure`
- **AND** the paragraph holds `status.profiles`, `held`, `missing`, `configure` and the words "model of this session"

## ADDED Requirements

### Requirement: OpenCode host: package
`hosts/opencode/package.json` SHALL be private, named for the host and not for the package, and SHALL have the published package as its only dependency, pinned to the exact version the Claude Code plugin pins. `hosts/opencode/node_modules` SHALL be ignored by git.

#### Scenario: Package pinned with the Claude Code plugin
- **WHEN** the host test reads `hosts/opencode/package.json`
- **THEN** it is private, its name differs from the published package's, its only dependency is the published package, and that dependency's version equals the one the Claude Code plugin pins

### Requirement: OpenCode host: registration snippet
`hosts/opencode/opencode.json` SHALL be the registration snippet. It SHALL declare `mcp.orchestrator_operator` with `type: "local"`, `command` set to `node`, the launcher, and `mcp`, and a per-server `timeout` in milliseconds above `WAIT_CAP_MS + 30000` (180000), because OpenCode cuts an MCP call at 60 seconds by default and the per-server `timeout` is the only cap opencode 1.18.30 honours. OpenCode names the tools `<id>_<tool>`, so they are `orchestrator_operator_<tool>`.

#### Scenario: Snippet registers the launcher
- **WHEN** the host test reads `hosts/opencode/opencode.json`
- **THEN** `mcp.orchestrator_operator` is `{ type: "local", command: ["node", "<hosts/opencode>/bin/orchestrator.mjs", "mcp"], timeout: 180000 }`, and the timeout is above `WAIT_CAP_MS + 30000`

### Requirement: OpenCode host: no mcp.timeout block
`hosts/opencode/opencode.json` SHALL have no `mcp.timeout` block, which 1.18.30 drops with a compatibility diagnostic.

#### Scenario: No global MCP timeout
- **WHEN** the host test reads `hosts/opencode/opencode.json`
- **THEN** it has no `mcp.timeout` key, and `orchestrator_operator` is the only key under `mcp`

### Requirement: OpenCode host: README install
`hosts/opencode/README.md` SHALL document merging the snippet into `~/.config/opencode/opencode.json` or a project's `opencode.json` as the primary install, and `opencode mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=<ms below 60000> -- node <hosts/opencode>/bin/orchestrator.mjs mcp` as the alternative, which cannot set `timeout`.

#### Scenario: Both installs documented
- **WHEN** `hosts/opencode/README.md` is read
- **THEN** it holds the snippet's `"orchestrator_operator"` entry with `"timeout": 180000` and the command `opencode mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=`

### Requirement: OpenCode host: README verification and pull mode
`hosts/opencode/README.md` SHALL document verification with `opencode mcp list`, the skills install, the plugin, the start-mode rule, and that the attachment ends when OpenCode closes the server's stdio. It SHALL have a pull-mode section documenting `orchestrator-work --runner opencode --workers 2`, run from a checkout as `node <hosts/codex>/bin/work.mjs --runner opencode`, and SHALL say that a `startupContended` start under `dataDir: shared` is released for relaunch.

#### Scenario: Pull-mode section
- **WHEN** `hosts/opencode/README.md` is read
- **THEN** it names `opencode mcp list` and `stdio`, documents `npx orchestrator-work --runner opencode --workers 2` and `node /path/to/orchestrator/hosts/codex/bin/work.mjs --runner opencode`, and says a `startupContended` start under `dataDir: shared` is released with `keep: true`

### Requirement: OpenCode host: skill editions
Each OpenCode skill SHALL be the Codex host's edition with the tool prefix `mcp__orchestrator_operator__` replaced by `orchestrator_operator_`, the host name changed, and only these blocks rewritten: the operator tools' permissions in place of Codex approvals (under `opencode run` a tool whose permission is `ask` is rejected automatically, and the remedy is `"orchestrator_operator_*": "allow"`), and the blocks of "OpenCode host: more rewritten skill blocks".

#### Scenario: No Codex tool prefix
- **WHEN** the host test reads each skill under `hosts/opencode/skills/`
- **THEN** none holds `mcp__orchestrator_operator__`, each holds `orchestrator_operator_`, and the run skill's permission block names `orchestrator_operator_*`

### Requirement: OpenCode host: more rewritten skill blocks
The blocks rewritten in each OpenCode skill SHALL also be the OpenCode form of the tracker connectors (`mcp.linear` and `mcp.atlassian` entries whose tools are `linear_<tool>` and `atlassian_<tool>`), the per-server `timeout` in place of `tool_timeout_sec`, the toolchain line and kind lists naming `opencode` (its permission and commit policy), and the pull-mode offer.

#### Scenario: Pull-mode offer rewritten
- **WHEN** the OpenCode run skill is compared with the Codex edition after the substitutions
- **THEN** the pull-mode offer naming `work.mjs --runner opencode --workers <n>` and the block naming the server's `timeout` in `opencode.json` are among the blocks that differ

### Requirement: OpenCode host: editions held by a host test
A host test SHALL hold the Codex and OpenCode editions of each skill to exactly the differences that "OpenCode host: skill editions" and "OpenCode host: more rewritten skill blocks" allow, and SHALL pin each rewritten block to its expected text (a hash of the block as the test normalises it), so a change anywhere in a rewritten block fails the test until the expectation is updated.

#### Scenario: A difference outside the rewritten blocks
- **WHEN** an OpenCode skill holds a block that differs from the Codex edition after the substitutions and holds none of the pinned phrases
- **THEN** the host test fails, naming the skill and quoting the start of the block

### Requirement: OpenCode host: start mode
Because an OpenCode session has no session workers, the skills SHALL call `start` with `mode: "spawn"` when no daemon is running and `orchestrator.yaml` sets no `runner.mode`, and without `mode` otherwise. When the mode in force is `pull` or `mixed` the OpenCode skills SHALL say so and SHALL offer `spawn` unless another session holds launches of the run.

#### Scenario: Runner mode set in the file
- **WHEN** no daemon is running and the repository's `orchestrator.yaml` sets `runner.mode`
- **THEN** the OpenCode run skill calls `start` without `mode` and respects the file

### Requirement: OpenCode host: work loop offer
When the run holds `opencode` launches the OpenCode skills SHALL also offer the work loop that `modeNote` names (`orchestrator-work --runner opencode`, "Work loop by runner kind"), started from a shell.

#### Scenario: Pull-mode run with opencode launches
- **WHEN** the mode in force is `pull` and the run holds `opencode` launches
- **THEN** the OpenCode run skill offers the work loop the `modeNote` names, started from a shell in the repository as `node <hosts/codex>/bin/work.mjs --runner opencode --workers <n> --run-tag <tag> --capacity <config.capacity>`

### Requirement: OpenCode host: session plugin
`hosts/opencode/plugins/orchestrator.js` SHALL be the session plugin, installed by linking it into `~/.config/opencode/plugins/` (or a project's `.opencode/plugins/`). It SHALL export exactly one function, since OpenCode calls every exported function as a plugin. It SHALL find `hooks/session-start.mjs` beside its own real path, or under `ORCH_OPENCODE_HOST` for a copied install.

#### Scenario: One exported function
- **WHEN** the host test imports `hosts/opencode/plugins/orchestrator.js`
- **THEN** its only export is the function `OrchestratorPlugin`

### Requirement: OpenCode host: plugin appends the start line
On `session.created` for a session without a `parentID` the session plugin SHALL run `hooks/session-start.mjs` once with `node` and a ten-second timeout. On that session's first `chat.message` the session plugin SHALL append the line of `hooks/session-start.mjs` to the user's existing text part, SHALL never push a new part (OpenCode refuses a part without ids), and SHALL leave the message untouched when the script printed nothing.

#### Scenario: Subagent session skipped
- **WHEN** the plugin sees `session.created` for a session whose `parentID` is set, and then a `chat.message` for it, while a run needs attention
- **THEN** the message part is unchanged and no toast is shown

### Requirement: OpenCode host: plugin toast
The session plugin SHALL show the start line through `client.tui.showToast` and SHALL ignore a client without a TUI.

#### Scenario: Client without a TUI
- **WHEN** the plugin runs with a client whose `tui.showToast` throws, while a run needs attention
- **THEN** the first message's text part still ends with the start line and the plugin does not throw

### Requirement: OpenCode host: hook copies and pure launches
`hosts/opencode/hooks/` SHALL hold byte copies of the Claude Code plugin's `session-start.mjs` and `session-end.mjs`; nothing runs the end script, since OpenCode has no session end event and the operator server ends its own attachment when its stdio closes. Worker launches pass `--pure` by default, through the `{pure}` slot that `runner.opencode.pure` (default `true`) fills, and then never load the plugin.

#### Scenario: Default worker launch is pure
- **WHEN** an opencode worker launch is composed with the default settings
- **THEN** the command carries `--pure`

### Requirement: OpenCode host: worker launches that load the plugin
With `runner.opencode.pure: false` a worker launch omits `--pure` and loads the plugins of the project's `.opencode/plugins/` and, unless `runner.opencode.ignoreUserConfig` is `true`, the plugins installed under `~/.config/opencode/plugins/`, the session plugin included, so a worker started while a run needs attention gets the start line appended to its brief message. The session plugin SHALL NOT use `experimental.chat.system.transform`.

#### Scenario: No system transform
- **WHEN** `hosts/opencode/plugins/orchestrator.js` is read
- **THEN** it does not name `experimental.chat.system.transform`

### Requirement: OpenCode host: user config ignored
`runner.opencode.ignoreUserConfig: true` (default `false`) points `XDG_CONFIG_HOME` at an empty directory, so a plugin installed under `~/.config/opencode/plugins/` does not load. `hosts/opencode/README.md` SHALL say both what `runner.opencode.pure: false` does and what `runner.opencode.ignoreUserConfig: true` does.

#### Scenario: Empty config home
- **WHEN** an opencode launch is spawned with `ignoreUserConfig: true`
- **THEN** its `XDG_CONFIG_HOME` is `.orchestrator/opencode-config` in the worktree, an empty directory, while with the default `false` the runner does not set it

### Requirement: Codex plugin hooks: SessionEnd and the probed shape
`hosts/codex/hooks/hooks.json` SHALL run `hooks/session-end.mjs` (three-second timeout) on `SessionEnd` with `node` through `${PLUGIN_ROOT}`. This is the shape codex-cli 0.164 was probed running (test/fixtures/codex/plugin-probe): Codex reads the plugin's `hooks/hooks.json`, substitutes `${PLUGIN_ROOT}` with the installed plugin root before the shell runs, runs each hook as a child of the codex process, and adds the SessionStart hook's stdout to the session's context.

#### Scenario: SessionEnd hook declared
- **WHEN** the host tests read `hosts/codex/hooks/hooks.json`
- **THEN** `SessionEnd` holds one hook, with no matcher, whose command is `node "${PLUGIN_ROOT}/hooks/session-end.mjs"` and whose timeout is 3

### Requirement: Codex plugin hooks: timeouts and trust
A SessionEnd hook gets one second when it declares no timeout, and Codex caps a declared one at three seconds. Codex runs a plugin hook only when it is trusted, recorded in `config.toml` as `[hooks.state."<plugin>@<marketplace>:hooks/hooks.json:<event>:<group>:<index>"]` with `trusted_hash` and `trusted_content_hash` by the interactive hook review, or under `--dangerously-bypass-hook-trust`. Under `codex exec` an untrusted hook is skipped without a message. The host README SHALL say so.

#### Scenario: README names the trust rule
- **WHEN** `hosts/codex/README.md` is read
- **THEN** it says Codex runs a plugin's hooks only once they are trusted, names `trusted_hash` and `trusted_content_hash`, and says that under `codex exec` untrusted hooks are skipped with no message unless `--dangerously-bypass-hook-trust` is passed

### Requirement: Codex plugin MCP server: timeouts and variables
`hosts/codex/.mcp.json` SHALL set `startup_timeout_sec: 60` (a first start may fetch through npx), `tool_timeout_sec` above `WAIT_CAP_MS / 1000 + 30` (180), and `env_vars` forwarding exactly `PATH`, `HOME`, `ORCH_HOME`, `ORCH_WAIT_CAP_MS`, `ORCH_REPO`, `ORCH_URL`, `CODEX_HOME`, and `CODEX_API_KEY`, in that order. `ORCH_URL` lets the server reach a remote daemon. `CODEX_API_KEY` is the key variable `codex exec` reads. A host test SHALL pin the `env_vars` list.

#### Scenario: Timeouts pinned
- **WHEN** the host tests read `hosts/codex/.mcp.json`
- **THEN** `startup_timeout_sec` is 60 and `tool_timeout_sec` is above `WAIT_CAP_MS / 1000 + 30`

### Requirement: Codex plugin MCP server: environment
Codex gives a plugin's server only its `env_vars` and its own baseline (`HOME`, `LANG`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `TMPDIR`, `USER`, and on macOS `__CF_USER_TEXT_ENCODING`), and the daemon the server starts inherits the server's environment and passes it to its codex workers. `CODEX_HOME` makes the workers of a spawn-mode daemon started from the plugin use the session's Codex home and its `auth.json`. `OPENAI_API_KEY` SHALL NOT be forwarded, because `codex exec` 0.164 ignores it.

#### Scenario: No OpenAI key forwarded
- **WHEN** the host tests read `env_vars` in `hosts/codex/.mcp.json`
- **THEN** it is exactly `PATH`, `HOME`, `ORCH_HOME`, `ORCH_WAIT_CAP_MS`, `ORCH_REPO`, `ORCH_URL`, `CODEX_HOME`, `CODEX_API_KEY`, so `OPENAI_API_KEY` is not forwarded

### Requirement: Work loop silence limit from the daemon
When `--max-silence-ms` is not given and the claim carries a `health` field, the first limit SHALL be the claim's `health.stuckFailAfterMs` when positive, and after each `GET /v1/status` answer the limit SHALL be that answer's `budgets.stuckFailAfterMs` when it is a positive number; a value of 0 SHALL give 45 minutes, so a hung agent whose lease the loop renews is still bounded.

#### Scenario: Status raises the claimed limit
- **WHEN** the loop runs without `--max-silence-ms`, claims under `health.stuckFailAfterMs: 7000`, and `status` answers `budgets.stuckFailAfterMs: 60000`
- **THEN** the silence limit is 60000

#### Scenario: A claim of 0 follows status later
- **WHEN** the loop runs without `--max-silence-ms`, claims under `health.stuckFailAfterMs: 0`, and `status` later answers `budgets.stuckFailAfterMs: 9000`
- **THEN** the first limit is 45 minutes and then 9000

### Requirement: Work loop keeps its silence limit when status cannot be read
When `status` cannot be read (an answer that is not 200, a thrown request, or no number at `budgets.stuckFailAfterMs`) the loop SHALL keep the limit it had.

#### Scenario: Status without a number
- **WHEN** the loop runs without `--max-silence-ms` under a limit of 60000 and a `status` read throws, or answers `budgets.stuckFailAfterMs` as a string or a negative number
- **THEN** the silence limit stays 60000

### Requirement: Work loop renews while ending an agent
While the watcher is ending the agent's process group, the loop SHALL renew until the group is gone, so that it can release the launch itself.

#### Scenario: Renewal until the group is gone
- **WHEN** the watcher ends an agent that was silent past `--max-silence-ms` and the agent process exits before its process group closes
- **THEN** the loop keeps renewing until the group's output pipes close, then releases the launch itself without keep

### Requirement: Work loop renewal needs lease facts
A claim without lease facts SHALL start no renewal.

#### Scenario: Claim without a lease
- **WHEN** a claim carries neither `lease` nor `leaseTtlMs`
- **THEN** the loop starts no renewal and sends no `POST /v1/launches/:id/renew` for that launch

### Requirement: Run skill posts a milestone verdict as a project status update
For a project-milestone root the `run` skill SHALL post only a `comment` whose body opens with "Milestone accepted:" or "Milestone rejected:", as a project status update on the project the `url` names, with the body, a blank line and the marker as the last line, setting no health value (keeping the current health when the tool requires one), and SHALL acknowledge it with `result: { statusUpdateId }`.

#### Scenario: Tool that requires a health value
- **WHEN** the session's Linear tool requires a health value to post the accept comment of a project-milestone root
- **THEN** the skill posts the status update with the project's current health

### Requirement: Run skill posts a milestone verdict once
Before posting a project status update the `run` skill SHALL list the project's recent status updates and, if one holds the effect's marker, acknowledge with that update's id and not post again.

#### Scenario: No update holds the marker
- **WHEN** none of the project's recent status updates holds the marker of an accept comment for a project-milestone root
- **THEN** the skill posts one status update and acknowledges with its `statusUpdateId`

### Requirement: Run skill declines other project-root comments
Every other comment effect for a project-milestone root SHALL be acknowledged with `applied: false` and a reason.

#### Scenario: Blocked comment for a project root
- **WHEN** the outbox lists a blocked comment or a question for a root whose `url` holds `/project/`
- **THEN** the skill posts nothing and acknowledges it with `applied: false` and a reason

### Requirement: Run skill without a project status update tool
When the session has no tool that posts a project status update, the skill SHALL acknowledge the accept and reject comments with `applied: false` and a reason that says so, and tell the user once.

#### Scenario: No status update tool
- **WHEN** the session has no Linear tool that posts a project status update and the outbox lists the accept comment for a project-milestone root
- **THEN** the skill acknowledges it with `applied: false` and a reason that says so, and tells the user once

### Requirement: Run skill answers project-root effects with a result
The effects for a project-milestone root SHALL be answered with `result`, never with `error`, except that a tracker error while posting a status update is an error. An effect acknowledged with `applied: false` SHALL be counted in neither number of the tracker count line.

#### Scenario: Tracker error while posting
- **WHEN** posting the status update for an accept comment of a project-milestone root fails with a tracker error
- **THEN** the skill answers that effect with `error`, as for any effect

#### Scenario: Declined effect not counted
- **WHEN** the skill acknowledges a `setState` effect for a project-milestone root with `applied: false`
- **THEN** the effect is counted in neither number of the tracker count line

### Requirement: Work loop sleep gap
A *gap* SHALL be two consecutive notes more than `--gap-after-ms` apart (default 60000); a step exactly at the threshold, and a note earlier than the one before it, SHALL NOT be gaps. When the loop finds a gap it SHALL add the gap's length to the agent's last output time, capped at the present, and SHALL log one line with the length it left out, when that is above zero. The gap SHALL NOT be measured between two looks of the watcher.

#### Scenario: A step at the threshold
- **WHEN** two consecutive notes of the loop's clock are exactly `--gap-after-ms` apart, or a note is earlier than the one before it
- **THEN** no gap is found and nothing is left out of the silence

#### Scenario: Output right after a wake
- **WHEN** the agent writes output after a wake and before the next note, and that note finds a gap
- **THEN** the agent's last output time is capped at the note's time, so the silence is 0, not negative

### Requirement: Work loop sleep rule leaves the other rules alone
The loop SHALL NOT read the daemon's gap record, the silence limit SHALL be chosen as before, and the report grace SHALL keep counting wall time.

#### Scenario: Report grace counts a sleep
- **WHEN** a look of the watcher first finds the agent's launch reported, and the machine then sleeps for longer than the report grace
- **THEN** the sleep counts toward the report grace as wall time, and the loop ends the agent at its next look

### Requirement: Run skill raised limit: the configure offer
The bullet `- **a launch needs more time**` SHALL offer `configure` with `budgets: { maxLaunchMs }` for the time budget and with `health: { stuckFailAfterMs }` (`health.stuckFailAfterMs`) for a stuck launch that has a `pid`, say that values are milliseconds, tell the agent to check that `applied` lists `budgets` or `health`, to tell the worker the new limit with `nudge`, and to clear the override with a null leaf once the launch has reported or ended.

#### Scenario: A stuck launch with a pid
- **WHEN** the user wants a stuck launch that has a `pid` in `status.liveLaunches` to keep running
- **THEN** the bullet has the agent offer `configure` with `health: { stuckFailAfterMs: <ms> }` in milliseconds, check that `applied` lists `health`, and clear it with `health: { stuckFailAfterMs: null }` once the launch has reported or ended

### Requirement: Run skill raised limit: sentences by edition
The Claude Code edition SHALL say that a launch held by this session's workers has no `pid` and is bound by its lease, `leaseTtlMs`, a start-time key. The Codex and OpenCode editions SHALL hold the same bullet `- **a launch needs more time**` and SHALL say that a launch held by an `orchestrator-work` loop keeps the silence limit its loop took when it claimed.

#### Scenario: Claude Code edition names the lease
- **WHEN** the bullet `- **a launch needs more time**` is cut out of the Claude Code run skill
- **THEN** it says that a launch held by this session's workers has no `pid` and is bound by its lease, `leaseTtlMs`, a start-time key

### Requirement: Run skill lowering sentence in every edition
The Claude Code, Codex and OpenCode editions of the run skill SHALL hold the same sentence on a refused lowering, `wouldEnd` and `endLive`.

#### Scenario: Same sentence in three editions
- **WHEN** the sentence that starts "A lowered, cleared or switched-on limit" is cut out of the Claude Code, Codex and OpenCode run skills
- **THEN** the three are equal

### Requirement: Run skill: a work loop follows a changed limit
The Codex and OpenCode editions SHALL say that an `orchestrator-work` loop follows the new stuck limit from `status`, unless it was started with `--max-silence-ms`, which keeps that value, and SHALL NOT say that the loop keeps the limit of its claim. The Codex and OpenCode bullets **a launch needs more time** SHALL stay identical after the tool-name substitution.

#### Scenario: Codex and OpenCode bullets equal
- **WHEN** the bullet **a launch needs more time** is cut out of the Codex and OpenCode run skills and the tool-name substitution is applied to the Codex one
- **THEN** the two are identical and hold `orchestrator-work` and `--max-silence-ms`

### Requirement: Run skill Worker profile paragraph: before a graph
The **Worker profile.** paragraph of each run skill SHALL say that the `start` result's `confirmProfile` tells whether the profile hold is on; that before a graph is loaded, with `confirmProfile` true and `config.model.source` or `config.effort.source` `default`, the session asks the user for the model and effort, naming the value shown as one option.

#### Scenario: Default profile before a graph
- **WHEN** the session starts a run with no graph loaded, `confirmProfile` true and `config.model.source` `default`
- **THEN** the paragraph has it ask the user now which model and effort the workers run with, naming the value shown as one option

### Requirement: Run skill Worker profile paragraph: with a graph
The **Worker profile.** paragraph of each run skill SHALL say that with a graph the session reads `status.profiles` (again after every import), tells the user every entry with its sources (`modelSource`, `effortSource`) and asks for the keys in `missing` of every entry with `held: true`; that the answer is applied with `configure` (`model` and `effort` for the kind in force, or the `claude`, `codex` or `opencode` object), also when the user accepts the value shown.

#### Scenario: The user accepts the value shown
- **WHEN** an entry of `status.profiles` has `held: true` and the user accepts the value the session named
- **THEN** the session still applies it with `configure`, so that its source becomes `argument`

### Requirement: Run skill Worker profile paragraph: the user chooses
The **Worker profile.** paragraph of each run skill SHALL say that the session never chooses from the model of this session nor without the user's answer; and that `orchestrator.yaml` holds a lasting choice and `runner.confirmProfile: false` there turns the hold off.

#### Scenario: Lasting choice
- **WHEN** the **Worker profile.** paragraph of a run skill is read
- **THEN** it says never to choose the profile from the model of this session nor without the user's answer, and names `runner.claude`, `runner.codex` or `runner.opencode` in `orchestrator.yaml` and `runner.confirmProfile: false`

### Requirement: Run skill profileHeld bullet
Each monitor list SHALL hold one bullet that starts with `- **profileHeld**`, directly after the `needsConfig` bullet, that sends the session to the **Worker profile.** paragraph and says the run is not slow or stalled.

#### Scenario: Bullet after needsConfig
- **WHEN** the monitor list of each run skill is read
- **THEN** the bullet that starts `- **profileHeld**` directly follows the `needsConfig` bullet, sends the session to the Worker profile paragraph, and says not to call the run slow or stalled

### Requirement: Work skill Worker profile bullet
The Claude Code work skill SHALL hold one bullet in section 1 that starts with `- **Worker profile.**` and says to follow the run skill's paragraph before running workers when `status.profiles` has an entry with `held: true`.

#### Scenario: Held tasks before workers run
- **WHEN** `status.profiles` has an entry with `held: true` when the Claude Code work skill is followed
- **THEN** the skill has the session follow the run skill's Worker profile paragraph before running workers, since held tasks are never claimable

### Requirement: Import skill Worker profile bullet
Each import skill SHALL hold one bullet in section 1 that starts with `- **Worker profile.**`, directly after the bullet that starts "The orchestrator daemon must be running for this repository".

#### Scenario: Bullet placement
- **WHEN** section 1 of each import skill is read
- **THEN** the bullet that starts `- **Worker profile.**` directly follows the bullet that starts "The orchestrator daemon must be running for this repository"

### Requirement: Import skill asks for the profile before the import
The `- **Worker profile.**` bullet of each import skill SHALL say that when the `start` result has `confirmProfile` true and `config.model.source` or `config.effort.source` is `default`, the imported tasks will be held, so the session asks the user for the model and effort before the import and applies the answer with `configure`, as the run skill's Worker profile paragraph says.

#### Scenario: Default profile at import
- **WHEN** the `start` result has `confirmProfile` true and `config.effort.source` `default` before an import
- **THEN** the session asks the user for the model and effort before the import, naming the value shown as one option, and applies the answer with `configure`
