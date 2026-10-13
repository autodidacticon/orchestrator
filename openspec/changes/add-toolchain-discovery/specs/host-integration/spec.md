## ADDED Requirements

### Requirement: Skills report the toolchain
After `start` returns, the `run`, `import`, and `work` skills SHALL report the resolved toolchain to the user in one line naming the check command, the integration branch, the source of each, and, for a run whose daemon spawns agents, the toolchains whose commands agents may run (for example "detected: npm test on main; agents may run npm and node"). When `needsConfig` names `checkCommand`, in the `start` result or in a later `wait` digest, the skill SHALL look for the test command in `CLAUDE.md`, the README, and the manifests in the repository root; when one is stated unambiguously it SHALL set it through `configure` and report the command and where it found it; otherwise it SHALL propose its best reading, or say it found none, and SHALL set what the user confirms. It SHALL NOT leave `checkCommand` unresolved while a task is `submitted` without having asked the user. In the `run` skill, when an agent asks a `needsAccess` question naming a command, the skill SHALL offer to add a rule through `configure` for subsequent launches, SHALL say that the live agent cannot gain the rule, and SHALL offer to run the command on the agent's behalf and answer with the result. The sibling change `add-daemon-lifecycle` decides the plugin's default runner mode; when launches are worked by session subagents the allow-list part of the report SHALL be omitted.

#### Scenario: Detected toolchain reported
- **WHEN** the run skill calls `start` in a Node repository and the result shows `checkCommand` detected as `npm test` on `main`
- **THEN** the skill tells the user "detected: npm test on main" with the sources before looping on `wait`

#### Scenario: Unresolved command found in CLAUDE.md
- **WHEN** `start` returns `needsConfig: ["checkCommand"]` and `CLAUDE.md` says "run tests with `make check`"
- **THEN** the skill calls `configure` with `checkCommand: "make check"` and reports that it took the command from `CLAUDE.md`

#### Scenario: Unresolved command with nothing documented
- **WHEN** `start` returns `needsConfig: ["checkCommand"]` and neither `CLAUDE.md`, the README, nor a manifest names a test command
- **THEN** the skill asks the user for the command and calls `configure` only with what the user gives

#### Scenario: Access question answered without a restart
- **WHEN** `wait` returns a `needsAccess` question from T2 asking to run `docker compose up`
- **THEN** the skill offers to add `Bash(docker:*)` for later launches, says T2's live agent cannot gain it, and offers to run the command and answer T2 with the result
