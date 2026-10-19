## MODIFIED Requirements

### Requirement: Skills report the toolchain
After `start` returns, the `run`, `import`, and `work` skills SHALL report the resolved toolchain to the user in one line. The line SHALL name the check command, the integration branch, the worker kind with its model and effort (`config.runnerKind`, `config.model`, `config.effort`), and the source of each. The default named SHALL be the one of the kind in force: `claude-opus-5-5` at `medium` for `claude-code`, `gpt-6-astra` at `medium` for `codex`, `anthropic/claude-opus-5-5` at `medium` for `opencode`. For a `claude-code` run whose daemon spawns agents, the line SHALL also name the toolchains whose commands agents may run (for example "detected: npm test on main; workers claude-opus-5-5 at medium (default); agents may run npm and node"). For a `codex` run the line SHALL name the kind, the sandbox, and the commit policy, and SHALL have no allow-list part (for example "detected: npm test on main; workers codex gpt-6-astra at medium (file); sandbox workspace-write, daemon commits"). For an `opencode` run the line SHALL name the kind, the permission, and the commit policy, and SHALL have no allow-list part (for example "detected: npm test on main; workers opencode anthropic/claude-opus-5-5 at medium (default); permission derived, agent commits"). When `needsConfig` names `checkCommand`, in the `start` result or in a later `wait` digest, the skill SHALL look for the test command in `CLAUDE.md`, the README, and the manifests in the repository root; when one is stated unambiguously it SHALL set it through `configure` and report the command and where it found it; otherwise it SHALL propose its best reading, or say it found none, and SHALL set what the user confirms. It SHALL NOT leave `checkCommand` unresolved while a task is `submitted` without having asked the user. In the `run` skill, when an agent asks a `needsAccess` question naming a command, the skill SHALL offer a configuration change through `configure` for subsequent launches, SHALL say that the live agent cannot gain it, and SHALL offer to run the command on the agent's behalf and answer with the result. The change SHALL be the one for the launch's kind: an `allowedTools` rule for `claude-code`, a wider `sandbox` for `codex`, and `permission: "allow"` for `opencode`, whose `derived` permission rejects a command outside the derived rules automatically. The `import` skill SHALL document the `runner:<kind>`, `model:<name>`, and `effort:<level>` labels as the way an issue chooses its worker kind, model, and effort, and SHALL report any `ignoredLabels` from the import summary to the user. The `import` skill's labels SHALL name the three kinds. The `run` skill SHALL document `runner.kind`, `runner.codex.*`, `runner.opencode.*`, and `budgets.prices`. When launches are worked by session subagents the allow-list part of the report SHALL be omitted; when the runner command does not apply `model` or `effort` the model part SHALL be omitted.

#### Scenario: Detected toolchain reported
- **WHEN** the run skill calls `start` in a Node repository and the result shows `checkCommand` detected as `npm test` on `main` with the default runner kind, model, and effort
- **THEN** the skill tells the user "detected: npm test on main; workers claude-opus-5-5 at medium" with the sources before looping on `wait`

#### Scenario: Codex toolchain reported
- **WHEN** the run skill calls `start` in a Node repository whose `orchestrator.yaml` sets `runner.kind: codex`, and the result shows `checkCommand` detected as `npm test` on `main` with the Codex default model and effort
- **THEN** the skill tells the user "detected: npm test on main; workers codex gpt-6-astra at medium (file); sandbox workspace-write, daemon commits", with no allow-list part

#### Scenario: Unresolved command found in CLAUDE.md
- **WHEN** `start` returns `needsConfig: ["checkCommand"]` and `CLAUDE.md` says "run tests with `make check`"
- **THEN** the skill calls `configure` with `checkCommand: "make check"` and reports that it took the command from `CLAUDE.md`

#### Scenario: Unresolved command with nothing documented
- **WHEN** `start` returns `needsConfig: ["checkCommand"]` and neither `CLAUDE.md`, the README, nor a manifest names a test command
- **THEN** the skill asks the user for the command and calls `configure` only with what the user gives

#### Scenario: Access question answered without a restart
- **WHEN** `wait` returns a `needsAccess` question from T2 asking to run `docker compose up`
- **THEN** the skill offers to add `Bash(docker:*)` for later launches, says T2's live agent cannot gain it, and offers to run the command and answer T2 with the result

#### Scenario: OpenCode access question
- **WHEN** `wait` returns a `needsAccess` question from T3, an `opencode` launch whose command was rejected under `permission: derived`
- **THEN** the skill offers `configure` with `permission: "allow"` for later opencode launches, says T3's live agent cannot gain it, and offers to run the command and answer T3 with the result

#### Scenario: OpenCode toolchain reported
- **WHEN** the run or import skill calls `start` on a run whose `config.runnerKind` is `opencode` with the defaults
- **THEN** the skill tells the user "detected: npm test on main; workers opencode anthropic/claude-opus-5-5 at medium (default); permission derived, agent commits", with no allow-list part
