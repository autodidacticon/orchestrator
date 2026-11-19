## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. In `host-integration`, 27 of the 40 requirements are over the limit. This change is part 2 of 2 of the `host-integration` migration (ORC-160, under ORC-139): it splits 12 of them the way OpenSpec 2.1 prescribes, without changing what the spec requires. Part 1 (`openspec-2-host-integration-1`) splits a disjoint set. "Work loop by runner kind" is left to the later migration (OS2).

## What Changes

- MODIFIED, each with its header and every scenario unchanged and its description cut to one behavior of at most 500 characters: "OpenCode host", "Codex plugin hooks", "Codex plugin MCP server", "Work loop silence limit", "Work loop renews the lease", "Run skill handles a Linear project-milestone root", "Work loop silence leaves out a sleep", "Run skill offers a raised limit", "Run skill confirms a lowering with the user", "Run skill: workers are told of a limit change", "Run skill asks for a held profile", "Import skill reports held tasks".
- ADDED: 42 requirements, each holding behavior moved out of one of those descriptions, with a description of at most 500 characters and at least one scenario of its own. ADDED names are new to `host-integration`; most carry their parent's subject as a prefix.
- Moved text keeps its wording. A sentence moves unchanged, or with only its references made explicit (a pronoun, "Else", "these", "such", "both", "the list", "the same bullet" replaced by what it names). Four sentences are split into pieces; each piece keeps the sentence's words and repeats its subject and SHALL where it must stand alone, so no SHALL or MUST is dropped or weakened (which is why the moved descriptions hold 106 occurrences against the original 101):
  - "Run skill asks for a held profile", the "It SHALL say that ..." sentence (918 characters): split at its semicolons, under the owner's rule for every OpenSpec 2.1 migration task, into three pieces that each open "The **Worker profile.** paragraph of each run skill SHALL say that".
  - "OpenCode host", the "Each SHALL be the Codex host's edition ..." sentence (696 characters): it has no semicolon, so it is split at its list of rewritten blocks, the second piece opening "The blocks rewritten in each OpenCode skill SHALL also be".
  - "Import skill reports held tasks", the "Worker profile" bullet sentence (507 characters): it has no semicolon, so it is split at its colon, the second piece opening "The `- **Worker profile.**` bullet of each import skill SHALL say that".
  - "Codex plugin hooks", its first sentence (248 characters): split into its SessionStart and SessionEnd halves, each with `hosts/codex/hooks/hooks.json` SHALL run, because the description holds two SHALLs for three requirements' worth of text and `openspec validate --strict` fails an ADDED requirement whose description has no SHALL or MUST.
- Nothing is removed or renamed. Requirements under the limit are untouched.

## Capabilities

### New Capabilities

### Modified Capabilities

- `host-integration`: 12 long requirements are split into a cut MODIFIED requirement plus ADDED requirements. The behavior is unchanged.

## Moved sentences

Each sentence that left a MODIFIED description, with the ADDED requirement that now holds it:

### OpenCode host

- "`hosts/opencode/package.json` SHALL be private, named for the host and not for the package, and SHALL have the published package as its only dependency, pinned to the exact version the Claude Code plugin pins." → **OpenCode host: package**
- "`hosts/opencode/node_modules` SHALL be ignored by git." → **OpenCode host: package**
- "`hosts/opencode/opencode.json` SHALL be the registration snippet." → **OpenCode host: registration snippet**
- "It SHALL declare `mcp.orchestrator_operator` with `type: "local"`, `command` set to `node`, the launcher, and `mcp`, and a per-server `timeout` in milliseconds above `WAIT_CAP_MS + 30000` (180000), because OpenCode cuts an MCP call at 60 seconds by default and the per-server `timeout` is the only cap opencode 1.18.30 honours." → **OpenCode host: registration snippet**
- "It SHALL have no `mcp.timeout` block, which 1.18.30 drops with a compatibility diagnostic." → **OpenCode host: no mcp.timeout block** (its reference made explicit)
- "OpenCode names the tools `<id>_<tool>`, so they are `orchestrator_operator_<tool>`." → **OpenCode host: registration snippet**
- "`hosts/opencode/README.md` SHALL document merging the snippet into `~/.config/opencode/opencode.json` or a project's `opencode.json` as the primary install, and `opencode mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=<ms below 60000> -- node <hosts/opencode>/bin/orchestrator.mjs mcp` as the alternative, which cannot set `timeout`." → **OpenCode host: README install**
- "It SHALL document verification with `opencode mcp list`, the skills install, the plugin, the start-mode rule, and that the attachment ends when OpenCode closes the server's stdio." → **OpenCode host: README verification and pull mode** (its reference made explicit)
- "It SHALL have a pull-mode section documenting `orchestrator-work --runner opencode --workers 2`, run from a checkout as `node <hosts/codex>/bin/work.mjs --runner opencode`, and SHALL say that a `startupContended` start under `dataDir: shared` is released for relaunch." → **OpenCode host: README verification and pull mode**
- "Each SHALL be the Codex host's edition with the tool prefix `mcp__orchestrator_operator__` replaced by `orchestrator_operator_`, the host name changed, and only these blocks rewritten: the operator tools' permissions in place of Codex approvals (under `opencode run` a tool whose permission is `ask` is rejected automatically, and the remedy is `"orchestrator_operator_*": "allow"`), the OpenCode form of the tracker connectors (`mcp.linear` and `mcp.atlassian` entries whose tools are `linear_<tool>` and `atlassian_<tool>`), the per-server `timeout` in place of `tool_timeout_sec`, the toolchain line and kind lists naming `opencode` (its permission and commit policy), and the pull-mode offer." → split, over 500 characters on its own or with no SHALL to carry it, into pieces held by **OpenCode host: skill editions**; **OpenCode host: more rewritten skill blocks**
- "A host test SHALL hold the two editions to exactly those differences, and SHALL pin each rewritten block to its expected text (a hash of the block as the test normalises it), so a change anywhere in a rewritten block fails the test until the expectation is updated." → **OpenCode host: editions held by a host test** (its reference made explicit)
- "Because an OpenCode session has no session workers, the skills SHALL call `start` with `mode: "spawn"` when no daemon is running and `orchestrator.yaml` sets no `runner.mode`, and without `mode` otherwise." → **OpenCode host: start mode**
- "When the mode in force is `pull` or `mixed` they SHALL say so and SHALL offer `spawn` unless another session holds launches of the run." → **OpenCode host: start mode** (its reference made explicit)
- "When the run holds `opencode` launches they SHALL also offer the work loop that `modeNote` names (`orchestrator-work --runner opencode`, "Work loop by runner kind"), started from a shell." → **OpenCode host: work loop offer** (its reference made explicit)
- "`hosts/opencode/plugins/orchestrator.js` SHALL be the session plugin, installed by linking it into `~/.config/opencode/plugins/` (or a project's `.opencode/plugins/`)." → **OpenCode host: session plugin**
- "It SHALL export exactly one function, since OpenCode calls every exported function as a plugin." → **OpenCode host: session plugin**
- "It SHALL find `hooks/session-start.mjs` beside its own real path, or under `ORCH_OPENCODE_HOST` for a copied install." → **OpenCode host: session plugin**
- "On `session.created` for a session without a `parentID` it SHALL run the script once with `node` and a ten-second timeout." → **OpenCode host: plugin appends the start line** (its reference made explicit)
- "On that session's first `chat.message` it SHALL append the script's line to the user's existing text part, SHALL never push a new part (OpenCode refuses a part without ids), and SHALL leave the message untouched when the script printed nothing." → **OpenCode host: plugin appends the start line** (its reference made explicit)
- "It SHALL show the line through `client.tui.showToast` and SHALL ignore a client without a TUI." → **OpenCode host: plugin toast** (its reference made explicit)
- "It SHALL NOT use `experimental.chat.system.transform`." → **OpenCode host: worker launches that load the plugin** (its reference made explicit)
- "`hosts/opencode/hooks/` SHALL hold byte copies of the Claude Code plugin's `session-start.mjs` and `session-end.mjs`; nothing runs the end script, since OpenCode has no session end event and the operator server ends its own attachment when its stdio closes." → **OpenCode host: hook copies and pure launches**
- "Worker launches pass `--pure` by default, through the `{pure}` slot that `runner.opencode.pure` (default `true`) fills, and then never load the plugin." → **OpenCode host: hook copies and pure launches**
- "With `runner.opencode.pure: false` a worker launch omits `--pure` and loads the plugins of the project's `.opencode/plugins/` and, unless `runner.opencode.ignoreUserConfig` is `true`, the plugins installed under `~/.config/opencode/plugins/`, this one included, so a worker started while a run needs attention gets the start line appended to its brief message." → **OpenCode host: worker launches that load the plugin** (its reference made explicit)
- "`runner.opencode.ignoreUserConfig: true` (default `false`) points `XDG_CONFIG_HOME` at an empty directory, so a plugin installed under `~/.config/opencode/plugins/` does not load." → **OpenCode host: user config ignored**
- "`hosts/opencode/README.md` SHALL say both." → **OpenCode host: user config ignored** (its reference made explicit)

### Codex plugin hooks

- "`hosts/codex/hooks/hooks.json` SHALL run `hooks/session-start.mjs` (matcher `startup|resume|clear`, ten-second timeout) on `SessionStart` and `hooks/session-end.mjs` (three-second timeout) on `SessionEnd`, each with `node` through `${PLUGIN_ROOT}`." → split, over 500 characters on its own or with no SHALL to carry it, into pieces held by **Codex plugin hooks** (stays in the MODIFIED description); **Codex plugin hooks: SessionEnd and the probed shape**
- "This is the shape codex-cli 0.164 was probed running (test/fixtures/codex/plugin-probe): Codex reads the plugin's `hooks/hooks.json`, substitutes `${PLUGIN_ROOT}` with the installed plugin root before the shell runs, runs each hook as a child of the codex process, and adds the SessionStart hook's stdout to the session's context." → **Codex plugin hooks: SessionEnd and the probed shape**
- "A SessionEnd hook gets one second when it declares no timeout, and Codex caps a declared one at three seconds." → **Codex plugin hooks: timeouts and trust**
- "Codex runs a plugin hook only when it is trusted, recorded in `config.toml` as `[hooks.state."<plugin>@<marketplace>:hooks/hooks.json:<event>:<group>:<index>"]` with `trusted_hash` and `trusted_content_hash` by the interactive hook review, or under `--dangerously-bypass-hook-trust`." → **Codex plugin hooks: timeouts and trust**
- "Under `codex exec` an untrusted hook is skipped without a message." → **Codex plugin hooks: timeouts and trust**
- "The host README SHALL say so." → **Codex plugin hooks: timeouts and trust**

### Codex plugin MCP server

- "It SHALL set `startup_timeout_sec: 60` (a first start may fetch through npx), `tool_timeout_sec` above `WAIT_CAP_MS / 1000 + 30` (180), and `env_vars` forwarding exactly `PATH`, `HOME`, `ORCH_HOME`, `ORCH_WAIT_CAP_MS`, `ORCH_REPO`, `ORCH_URL`, `CODEX_HOME`, and `CODEX_API_KEY`, in that order." → **Codex plugin MCP server: timeouts and variables** (its reference made explicit)
- "Codex gives a plugin's server only these and its own baseline (`HOME`, `LANG`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `TMPDIR`, `USER`, and on macOS `__CF_USER_TEXT_ENCODING`), and the daemon the server starts inherits the server's environment and passes it to its codex workers." → **Codex plugin MCP server: environment** (its reference made explicit)
- "`ORCH_URL` lets the server reach a remote daemon." → **Codex plugin MCP server: timeouts and variables**
- "`CODEX_HOME` makes the workers of a spawn-mode daemon started from the plugin use the session's Codex home and its `auth.json`." → **Codex plugin MCP server: environment**
- "`CODEX_API_KEY` is the key variable `codex exec` reads." → **Codex plugin MCP server: timeouts and variables**
- "`OPENAI_API_KEY` SHALL NOT be forwarded, because `codex exec` 0.164 ignores it." → **Codex plugin MCP server: environment**
- "A host test SHALL pin the list." → **Codex plugin MCP server: timeouts and variables** (its reference made explicit)

### Work loop silence limit

- "Else the first limit SHALL be the claim's `health.stuckFailAfterMs` when positive, and after each `GET /v1/status` answer the limit SHALL be that answer's `budgets.stuckFailAfterMs` when it is a positive number; a value of 0 SHALL give 45 minutes, so a hung agent whose lease the loop renews is still bounded." → **Work loop silence limit from the daemon** (its reference made explicit)
- "When `status` cannot be read (an answer that is not 200, a thrown request, or no number there) the loop SHALL keep the limit it had." → **Work loop keeps its silence limit when status cannot be read** (its reference made explicit)

### Work loop renews the lease

- "While the watcher is ending the agent's process group, the loop SHALL renew until the group is gone, so that it can release the launch itself." → **Work loop renews while ending an agent**
- "A claim without lease facts SHALL start no renewal." → **Work loop renewal needs lease facts**

### Run skill handles a Linear project-milestone root

- "It SHALL post only a `comment` whose body opens with "Milestone accepted:" or "Milestone rejected:", as a project status update on the project the `url` names, with the body, a blank line and the marker as the last line, setting no health value (keeping the current health when the tool requires one), and SHALL acknowledge it with `result: { statusUpdateId }`." → **Run skill posts a milestone verdict as a project status update** (its reference made explicit)
- "Before posting it SHALL list the project's recent status updates and, if one holds the effect's marker, acknowledge with that update's id and not post again." → **Run skill posts a milestone verdict once** (its reference made explicit)
- "Every other comment effect for such a root SHALL be acknowledged with `applied: false` and a reason." → **Run skill declines other project-root comments** (its reference made explicit)
- "When the session has no tool that posts a project status update, the skill SHALL acknowledge the accept and reject comments with `applied: false` and a reason that says so, and tell the user once." → **Run skill without a project status update tool**
- "These effects SHALL be answered with `result`, never with `error`, except that a tracker error while posting a status update is an error." → **Run skill answers project-root effects with a result** (its reference made explicit)
- "An effect acknowledged with `applied: false` SHALL be counted in neither number of the tracker count line." → **Run skill answers project-root effects with a result**

### Work loop silence leaves out a sleep

- "A *gap* SHALL be two consecutive notes more than `--gap-after-ms` apart (default 60000); a step exactly at the threshold, and a note earlier than the one before it, SHALL NOT be gaps." → **Work loop sleep gap**
- "When the loop finds a gap it SHALL add the gap's length to the agent's last output time, capped at the present, and SHALL log one line with the length it left out, when that is above zero." → **Work loop sleep gap**
- "The gap SHALL NOT be measured between two looks of the watcher." → **Work loop sleep gap**
- "The loop SHALL NOT read the daemon's gap record, the silence limit SHALL be chosen as before, and the report grace SHALL keep counting wall time." → **Work loop sleep rule leaves the other rules alone**

### Run skill offers a raised limit

- "It SHALL offer `configure` with `budgets: { maxLaunchMs }` for the time budget and with `health: { stuckFailAfterMs }` (`health.stuckFailAfterMs`) for a stuck launch that has a `pid`, say that values are milliseconds, tell the agent to check that `applied` lists `budgets` or `health`, to tell the worker the new limit with `nudge`, and to clear the override with a null leaf once the launch has reported or ended." → **Run skill raised limit: the configure offer** (its reference made explicit)
- "The Claude Code edition SHALL say that a launch held by this session's workers has no `pid` and is bound by its lease, `leaseTtlMs`, a start-time key." → **Run skill raised limit: sentences by edition**
- "The Codex and OpenCode editions SHALL hold the same bullet and SHALL say that a launch held by an `orchestrator-work` loop keeps the silence limit its loop took when it claimed." → **Run skill raised limit: sentences by edition** (its reference made explicit)

### Run skill confirms a lowering with the user

- "The Claude Code, Codex and OpenCode editions SHALL hold the same sentence." → **Run skill lowering sentence in every edition** (its reference made explicit)

### Run skill: workers are told of a limit change

- "The Codex and OpenCode editions SHALL say that an `orchestrator-work` loop follows the new stuck limit from `status`, unless it was started with `--max-silence-ms`, which keeps that value, and SHALL NOT say that the loop keeps the limit of its claim." → **Run skill: a work loop follows a changed limit**
- "The Codex and OpenCode bullets SHALL stay identical after the tool-name substitution." → **Run skill: a work loop follows a changed limit** (its reference made explicit)

### Run skill asks for a held profile

- "It SHALL say that the `start` result's `confirmProfile` tells whether the profile hold is on; that before a graph is loaded, with `confirmProfile` true and `config.model.source` or `config.effort.source` `default`, the session asks the user for the model and effort, naming the value shown as one option; that with a graph the session reads `status.profiles` (again after every import), tells the user every entry with its sources (`modelSource`, `effortSource`) and asks for the keys in `missing` of every entry with `held: true`; that the answer is applied with `configure` (`model` and `effort` for the kind in force, or the `claude`, `codex` or `opencode` object), also when the user accepts the value shown; that the session never chooses from the model of this session nor without the user's answer; and that `orchestrator.yaml` holds a lasting choice and `runner.confirmProfile: false` there turns the hold off." → split, over 500 characters on its own or with no SHALL to carry it, into pieces held by **Run skill Worker profile paragraph: before a graph**; **Run skill Worker profile paragraph: with a graph**; **Run skill Worker profile paragraph: the user chooses**
- "Each monitor list SHALL hold one bullet that starts with `- **profileHeld**`, directly after the `needsConfig` bullet, that sends the session to that paragraph and says the run is not slow or stalled." → **Run skill profileHeld bullet** (its reference made explicit)
- "The Claude Code work skill SHALL hold one bullet in section 1 that starts with `- **Worker profile.**` and says to follow the run skill's paragraph before running workers when `status.profiles` has an entry with `held: true`." → **Work skill Worker profile bullet**

### Import skill reports held tasks

- "Each import skill SHALL hold one bullet in section 1 that starts with `- **Worker profile.**`, directly after the bullet that starts "The orchestrator daemon must be running for this repository": when the `start` result has `confirmProfile` true and `config.model.source` or `config.effort.source` is `default`, the imported tasks will be held, so the session asks the user for the model and effort before the import and applies the answer with `configure`, as the run skill's Worker profile paragraph says." → split, over 500 characters on its own or with no SHALL to carry it, into pieces held by **Import skill Worker profile bullet**; **Import skill asks for the profile before the import**

## Evidence for the new scenarios

Each ADDED scenario states behavior the code or text has at the launch's base (e2e2197):

- OpenCode host: package; registration snippet; no mcp.timeout block: `test/host/opencode-host.test.ts` ("the opencode.json snippet registers the operator server ...", "package.json pins the published package ..."), `hosts/opencode/opencode.json`, `hosts/opencode/package.json`.
- OpenCode host: README install; README verification and pull mode: `hosts/opencode/README.md` ("Pull mode: the work loop"), `test/host/opencode-host.test.ts` ("the README covers registration ...").
- OpenCode host: skill editions; more rewritten skill blocks; editions held by a host test: `test/host/opencode-host.test.ts` (`EDITION_BLOCKS`, "each skill is the Codex edition but for the tool-name substitution and the enumerated host blocks"), `hosts/opencode/skills/run/SKILL.md`.
- OpenCode host: start mode; work loop offer: `hosts/opencode/skills/run/SKILL.md` (section 1).
- OpenCode host: session plugin; plugin appends the start line; plugin toast: `test/host/opencode-host.test.ts` ("session plugin": "exports exactly one function ...", "skips a subagent session and survives a client without a TUI"), `hosts/opencode/plugins/orchestrator.js`.
- OpenCode host: hook copies and pure launches: `test/runner/opencode.test.ts` ("composes the template with the brief on stdin ..."), `src/runner/opencode.ts`.
- OpenCode host: worker launches that load the plugin: `hosts/opencode/plugins/orchestrator.js` (no `experimental.chat.system.transform`).
- OpenCode host: user config ignored: `src/runner/opencode.ts` (`ignoreUserConfig` sets `XDG_CONFIG_HOME` to `.orchestrator/opencode-config`), `test/runner/opencode.test.ts` ("follows toolTimeoutMs, dataDir: launch, and ignoreUserConfig"; the default spawn leaves it `unset`).
- Codex plugin hooks: SessionEnd and the probed shape; Codex plugin MCP server: timeouts and variables; environment: `test/host/codex-host.test.ts` ("the Codex plugin: manifest at the package version, .mcp.json run from the plugin root, hooks through PLUGIN_ROOT ...").
- Codex plugin hooks: timeouts and trust: `hosts/codex/README.md` (the hook trust paragraph).
- Work loop silence limit from the daemon; Work loop keeps its silence limit when status cannot be read: `test/host/work-loop.test.ts` ("the silence limit follows status ..."), `hosts/codex/bin/work.mjs` (the watcher's `status` read and its `catch`).
- Work loop renews while ending an agent; Work loop renewal needs lease facts: `hosts/codex/bin/work.mjs` (`child.on('exit')` stops renewal only when not terminating, `close` stops it; `startRenewal` without `renewEveryMs`), `test/host/work-loop.test.ts` ("work.mjs lease renewal (ORC-85)").
- Work loop sleep gap; Work loop sleep rule leaves the other rules alone: `test/host/work-loop.test.ts` ("the silence clock leaves a sleep of this machine out of the silence"), `hosts/codex/bin/work.mjs` (`watchVerdict` counts the report grace as `now - reportedAt`).
- Run skill posts a milestone verdict as a project status update; posts a milestone verdict once; declines other project-root comments; without a project status update tool; answers project-root effects with a result: `hosts/claude-code/skills/run/SKILL.md`, `hosts/codex/skills/run/SKILL.md`, `hosts/opencode/skills/run/SKILL.md` (the Linear project-milestone root bullet).
- Run skill raised limit: the configure offer; sentences by edition; Run skill lowering sentence in every edition; Run skill: a work loop follows a changed limit: the bullet **a launch needs more time** of the three run skills (the lowering sentence is equal in the three; the Codex and OpenCode bullets are equal after the tool-name substitution).
- Run skill Worker profile paragraph: before a graph; with a graph; the user chooses; Run skill profileHeld bullet: the **Worker profile.** paragraph and the `profileHeld` bullet of the three run skills.
- Work skill Worker profile bullet: `hosts/claude-code/skills/work/SKILL.md` (section 1).
- Import skill Worker profile bullet; Import skill asks for the profile before the import: the **Worker profile.** bullet of `hosts/{claude-code,codex,opencode}/skills/import/SKILL.md`.
