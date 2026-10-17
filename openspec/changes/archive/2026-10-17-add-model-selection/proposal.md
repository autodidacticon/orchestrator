## Why

Nothing in the orchestrator chooses a model or an effort level: a spawned agent runs `claude -p` with whatever the account's default happens to be, and a session worker inherits the session's own settings. Before the cloud-native milestones start, workers should run Opus 5.5 at medium effort by default, with a task able to name a different model or effort when its work warrants it, so that cost and behaviour are decided by the run and the issue rather than by the environment the daemon happens to start in.

## What Changes

- A run default for the worker model and effort: `runner.claude.model` (default `claude-opus-5-5`) and `runner.claude.effort` (default `medium`), resolved with provenance through the same layers as the other configuration keys (argument, file, default), overridable at runtime, and reported in `config.json`, `status`, and the `start` result.
- Per-task overrides: a task payload may carry `model` and `effort`; a Linear label `model:<name>` or `effort:<level>` maps to those keys at import. A task's values win over the run default.
- The effective model and effort are fixed when a launch is prepared, stored on the launch, carried in its events and in `status`, and never change for a launch already prepared.
- The default runner command gains `{model}` and `{effort}` slots filled at every spawn beside `{allowedTools}`; a custom `runnerCommand` without the slots runs verbatim and the configuration record marks them as not applied.
- The claim response carries `model` and `effort`, and the bundled work workflow passes them to each worker agent so session workers honour them too.
- `configure`, `PUT /v1/config`, `orchestrator-ctl config`, `start`, and `--set` accept `model` and `effort`; the skills report the worker model and effort in the toolchain line and document the labels.
- Validation: `effort` is one of `low`, `medium`, `high`, `xhigh`, `max`; `model` is a non-empty token of letters, digits, dots, colons, underscores, and hyphens. The daemon keeps no list of valid model names; a wrong name fails the launch at spawn, which health monitoring already reports.

## Capabilities

### New Capabilities
- `model-selection`: how the worker model and effort are resolved for a launch (task payload over run default), validated, fixed at preparation, and exposed to runners, workers, and operators.

### Modified Capabilities
- `toolchain-discovery`: `model` and `effort` join the resolved keys with provenance, the runtime-overridable keys, the configuration record, and the runner command template's slots.
- `graph-import`: `model:` and `effort:` labels map to the `model` and `effort` payload keys; an unrecognised `effort:` label stays a plain label and is reported.
- `pull-runner`: the claim response carries the launch's `model` and `effort`.
- `operator-control`: the configuration route, `orchestrator-ctl config`, the start arguments, and the status configuration block accept and show `model` and `effort`; per-launch health reports them.
- `operator-mcp`: the `start` and `configure` tools accept `model` and `effort`.
- `host-integration`: the work workflow passes the claimed launch's model and effort to its worker agent; the skills' toolchain line names the worker model and effort, and the import skill documents the labels.

## Impact

- Code: `src/config.ts` (schema), `src/runs/resolve.ts` (keys, provenance, overrides parsing), `src/runner/command.ts` and `src/runner/subprocess.ts` (slots), `src/launch/launch.ts` and `src/state/store.ts` plus `src/state/sqlite.ts` (launch fields), `src/loop/orchestrator.ts` (resolution at prepare, claim response, status), `src/import/mapping.ts` (labels), `src/graph/load.ts` (payload validation), `src/operator/routes.ts`, `src/operator/cli.ts`, `src/operator/mcp-server.ts`, `src/runs/lifecycle.ts`, `hosts/claude-code/workflows/work.js`, the `run`, `work`, and `import` skills, README.
- Behaviour change for existing runs: a run without a file or override now spawns agents with `--model claude-opus-5-5 --effort medium` instead of the account default. A `runnerCommand` set by file keeps running verbatim.
- Store: two nullable columns on the launch row; existing rows read as absent (the run default of the time is not reconstructed).
- Dependencies: none new. The Claude Code CLI flags `--model` and `--effort` already exist.
