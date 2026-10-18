## MODIFIED Requirements

### Requirement: Runner kinds and defaults
The configuration SHALL carry `runner.kind`, one of `claude-code` and `codex`, defaulting to `claude-code`, and one block per kind: `runner.claude` and `runner.codex`. `runner.kind` SHALL resolve through the configuration layers as the key `runnerKind`: an argument (a `start` argument, a `--set` flag, or a runtime override) beats the file, which beats the default; it SHALL NOT be detected, pinned, or start-only, and a change SHALL apply to launches prepared afterwards. A value outside the kinds SHALL be refused at configuration time naming `runner.kind` in the file and `runnerKind` as an argument. Each kind SHALL have its own default model: `claude-opus-5-5` for `claude-code` and `gpt-6-astra` for `codex`; both default to effort `medium`. `runner.codex` SHALL carry `command` (unset by default, so the runner's built-in template applies), `model`, `effort`, `sandbox` (`read-only`, `workspace-write`, or `danger-full-access`, default `workspace-write`), `commit` (`agent` or `daemon`, unset by default), `networkAccess` (unset by default), `ignoreUserConfig` (default true), `ephemeral` (default true), `mcpApproval`, `toolTimeoutSec`, and `startupTimeoutSec`; the semantics of the policy keys belong to the Codex runner. The run default `model` and `effort` SHALL be those of the kind in force, so a run under `codex` never resolves a Claude model. Every operator surface SHALL expose the kind and the per-kind keys. These are `orchestrator-ctl start --set runnerKind=... --set codex.<leaf>=...`, `orchestrator-ctl config --runner-kind --sandbox --commit`, the MCP `start` and `configure` tools (`runnerKind`, `codex`, `sandbox`, `commit`), and `PUT /v1/config`. Each surface that names a default SHALL name both kinds' defaults.

#### Scenario: Claude Code by default
- **WHEN** the daemon starts with no file and no overrides
- **THEN** `config.runnerKind` is `{ value: "claude-code", source: "default" }` and `config.model` is `{ value: "claude-opus-5-5", source: "default", applied: true }`

#### Scenario: The file selects Codex
- **WHEN** `orchestrator.yaml` sets `runner.kind: codex` and nothing else under `runner`
- **THEN** `config.runnerKind` is `{ value: "codex", source: "file" }`, `config.model` is `{ value: "gpt-6-astra", source: "default", applied: true }`, `config.effort` is `{ value: "medium", source: "default", applied: true }`, and `config.codex.sandbox` is `{ value: "workspace-write", source: "default" }`

#### Scenario: The file sets the Codex model
- **WHEN** the file sets `runner.kind: codex` and `runner.codex.model: gpt-6-pro`
- **THEN** `config.model` is `{ value: "gpt-6-pro", source: "file", applied: true }`

#### Scenario: Selected at runtime
- **WHEN** `PUT /v1/config` carries `runnerKind: "codex"` on a running daemon
- **THEN** the response is 200, `config.json` shows `runnerKind` `{ value: "codex", source: "argument" }` with the `codex` leaves, and launches prepared afterwards resolve the Codex model

#### Scenario: Selected from the operator surfaces
- **WHEN** the operator runs `orchestrator-ctl config --runner-kind codex`, or calls the MCP `configure` tool with `runnerKind: "codex"`
- **THEN** `config.runnerKind` is `{ value: "codex", source: "argument" }` in either case

#### Scenario: Unknown kind refused
- **WHEN** `PUT /v1/config` carries `runnerKind: "cursor"`, or the file sets `runner.kind: cursor`
- **THEN** the route answers 400 naming `runnerKind`, and the file fails to load naming `runner.kind`

#### Scenario: Each kind keeps its own model
- **WHEN** the operator sets `runnerKind` to `codex` and `model` to `gpt-6-astra` in one patch, then clears `runnerKind`
- **THEN** under `codex` the model is `gpt-6-astra` with source `argument`, and after the clear the model is the Claude Code default with source `default`
