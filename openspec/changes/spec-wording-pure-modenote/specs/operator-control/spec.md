## MODIFIED Requirements

### Requirement: Start arguments
The daemon lifecycle `start` SHALL accept `checkCommand`, `integrationBranch`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, `claude`, `codex`, and `opencode` beside `mode`. When it spawns the daemon it SHALL pass each as a `--set key=value` flag (a per-kind block as a JSON object), which the daemon stores as an override before resolving; when the daemon is already healthy it SHALL apply them through `PUT /v1/config` and SHALL report any key the route refused under `rejected` with the route's reason. The result SHALL carry `config`, `toolchain`, and `needsConfig` as read from `GET /v1/config` after the daemon is healthy. `orchestrator-ctl start` SHALL accept the same keys as repeatable `--set key=value` flags, the per-kind leaves as dotted keys (`claude.model`, `claude.effort`, `claude.commit`, `codex.model`, `codex.effort`, `codex.sandbox`, `codex.commit`, `codex.command`, `opencode.model`, `opencode.effort`, `opencode.commit`, `opencode.command`, `opencode.permission`, `opencode.dataDir`), and the daemon's `--set` SHALL reject an unknown key or an invalid value with a usage error before serving. The daemon's usage SHALL list these keys. The MCP `start` tool SHALL take `runnerKind` (`claude-code`, `codex`, or `opencode`), `opencode: { model, effort }`, `permission`, and `dataDir` beside the codex arguments, and its argument text SHALL name the opencode defaults (`anthropic/claude-opus-5-5` at `medium`, commit `agent`, permission `derived`, dataDir `shared`). Without `mode`, and with no mode configured or chosen by the run, it SHALL start a run whose kind in force is `codex` or `opencode` in `spawn`, with a `modeNote` naming the kind and saying that pull-mode workers for it come from `orchestrator-work --runner <kind>`; a `codex` or `opencode` run in `pull` SHALL get a `modeNote` that names the kind and the same work loop. The work loop SHALL carry `--runner <kind>` for `codex` too, although `codex` is the loop's default runner.

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
