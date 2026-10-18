## Context

`resolveLayers` (ORC-42) resolves `runner.kind` and per-kind model and effort, but every launch still runs through the one `ClaudeCodeRunner` built in `src/main.ts`, and the launch row only records `model` and `effort`. `recordUsage` may run for a launch observed dead after a restart, so the row is the only durable fact a usage parser can be chosen from.

## Decisions

- **The kind is fixed at preparation, like model and effort.** `selectionFor` reads the kind in force and the chosen kind's own block (`config.runner.claude` or `config.runner.codex`) for the default model and effort, so a codex launch never inherits the Claude model. The per-task `runner` payload key is left to a later change.
- **Effort is checked per kind before the fallback.** The task's effort (validated against the union at graph load) is kept when the kind accepts it, else mapped by `EFFORT_FALLBACK[kind]`, else the kind's default. `effortRequested` is recorded on `launch.created` only when it differs, so existing payloads are unchanged.
- **`runnerOf(launch)` reads `launch.runner ?? 'claude-code'`.** Rows written before this change keep working everywhere (dispatch, brief, claim filter, counts).
- **MultiRunner routes by the row; `killByLaunchId` fans out.** Recovery has only the id in the runner signature; each runner's kill by marker is idempotent, so asking every registered runner is safe and keeps the interface unchanged. An unregistered kind throws at spawn naming the kind; `liveness` answers `unknown` and `readUsage` nothing for it.
- **The claim filter is optional and validated in `claim()`.** No filter keeps the old behaviour (any kind, oldest first). A named task of another kind is 409 with `runner` in the body, distinct from the 409 for a launch that is not claimable. The idempotent re-claim of a held launch returns before the filter.
- **`claimableByKind` counts every kind, zeros included,** so a worker can compare its own kind's count without a missing-key case. The digest carries it beside the existing `claimable` count.

## Risks / Trade-offs

- A spawn that throws (including the no-runner case) leaves the launch `launching`, as any spawn error did before; recovery revokes it on the next boot. When the Codex runner lands the codex slot is filled and the path is only reachable by a misconfigured daemon.
- The allow list a claude-code launch is spawned with still comes from the run-level resolution; when the kind in force is codex that list is empty. Mixed fleets are a later change.
- Mixed fleets double the CLIs a machine needs; `status` does not detect a missing CLI.
