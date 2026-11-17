## ADDED Requirements

### Requirement: Start tool turns the profile hold on

The operator server SHALL pass `defaultConfirmProfile: true` (operator-control "Profile hold default for a spawned daemon") at its two local spawn sites: the `start` tool and the local revival every other tool makes after an idle exit or a crash. The remote path (a remote `ORCH_URL`) SHALL NOT spawn and SHALL NOT change the hold; a remote daemon gets the hold only from its own file. `orchestrator-ctl` SHALL NOT pass it. So a daemon a host's tools spawn holds tasks whose model or effort would come from a built-in default unless the file or the run chose otherwise. The `start` result SHALL carry `confirmProfile`. The `start` description SHALL name `runner.confirmProfile` and `confirmProfile` and say that `orchestrator.yaml` wins; the `status` description SHALL name `profiles` and `runner.confirmProfile`; the `wait` description SHALL name `profileHeld`. There SHALL be no `start` argument that forces or clears the hold.

#### Scenario: A held task waits for configure

- **WHEN** the `start` tool starts a fresh repository in `pull` mode whose file sets no `runner.confirmProfile` and no model, and one task with no selector is imported
- **THEN** `start` returned `confirmProfile: true`, and `status` before the import had `runner.confirmProfile` true and `profiles` `[]`
- **AND** `status.profiles` has one entry with `held: true` and `missing: ["model", "effort"]`, `status.claimable` is `[]`, and the wait digest's `profileHeld` is `[{ runner: "claude-code", missing: ["model", "effort"], tasks: 1 }]`
- **AND** after `configure` with a model and an effort, `status.claimable` holds the task and `profileHeld` is `[]`

#### Scenario: A revival turns the hold on for a run from before the update

- **WHEN** a `pull` run started without the default holds T1 and T2 (T2 depends on T1), exits idle, and a tool call then revives its daemon
- **THEN** `status` answers with `runner.confirmProfile` true and a `profiles` entry with `held: true` whose `sample` holds T2

### Requirement: Configure and start tools: claude object

The `configure` and `start` tools SHALL take a `claude` object with `model` and `effort`, shaped like their `codex` object: nullable leaves and a nullable object in `configure`, neither in `start`, and the effort limited to the levels `claude-code` accepts. It SHALL set `claude.model` and `claude.effort` whichever runner kind is in force, so a held `claude-code` task on a run of another kind can be released through the tools.

#### Scenario: Releasing a held claude-code task on a codex run

- **WHEN** a run is started with `mode: "pull"`, `runnerKind: "codex"`, `codex: { model, effort }` and `claude: { effort: "high" }`, and C1 and C2 (both `runner: claude-code`, C2 depends on C1) are imported
- **THEN** the start result's `applied` holds `claude`, and `status.profiles` has one entry with `runner: "claude-code"`, `held: true`, `missing: ["model"]`, `effortSource: "argument"` and `tasks: 2`
- **AND** after `configure` with `claude: { model }`, `status.claimable` is `["C1"]` and the entry whose `sample` holds C2 has `held: false` and `modelSource: "argument"`
