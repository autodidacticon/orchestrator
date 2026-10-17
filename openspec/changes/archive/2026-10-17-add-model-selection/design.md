## Context

A launch runs in one of two ways. In spawn mode the daemon runs `DEFAULT_CLAUDE_COMMAND` (or a `runnerCommand` from the file or an override) through the subprocess runner, filling `{brief}`, `{mcpConfig}`, `{allowedTools}`, and the other slots at spawn. In pull mode the daemon parks the launch and a worker claims it; in the Claude Code plugin the bundled workflow `work.js` runs one `agent()` per claim. Neither path names a model or an effort, so the account default or the session's settings decide. The Claude Code CLI accepts `--model <alias|id>` and `--effort low|medium|high|xhigh|max`, and the workflow's `agent()` accepts `model` and `effort` options.

Configuration already resolves in layers with provenance (`src/runs/resolve.ts`: argument over file over pinned over detected over default), with durable overrides under one kv document, a `config.json` mirror, `PUT /v1/config`, `configure`, `orchestrator-ctl config`, and `start --set`. Task payloads already carry declarative keys the daemon reads (`scope`, `priority`, `labels`) and the import maps Linear fields onto them.

## Goals / Non-Goals

**Goals:**
- Every launch has a definite model and effort, decided by the run and the task, not by the environment.
- Default Opus 5.5 at medium effort; a task may name another model or effort.
- The same values reach spawned agents, session workers, and a future cluster worker loop through one representation.
- Operators see and change the defaults with the surfaces that already exist.

**Non-Goals:**
- Validating model names against a catalogue, or mapping aliases to ids.
- Choosing a model per phase of a task, or re-deciding for a retry (a retry is a new launch and resolves again from the same inputs).
- Milestone-level or label-derived cost policies beyond the two selectors.
- The claimer agent's model (the sibling discussion about retiring the claimer is separate).

## Decisions

**Resolve once, at preparation, and store on the launch.** `prepareLaunch` computes `model` and `effort` as task payload over run default and writes them on the launch row before anything else reads them. The spawn runner fills the template slots from the launch, and the claim response reads the launch. A `configure` change therefore applies to launches prepared afterwards and never to one already parked or live, which is the rule the brief text and the allow list already follow. Rejected: resolving at spawn or at claim, which would let a parked launch's model change under an operator who read it in `status`; and resolving in the brief composer, which would put a runner concern into agent-facing text.

**Two top-level override keys, `model` and `effort`, stored in the file under `runner.claude`.** This mirrors `allowedTools`: file users write `runner.claude.model`, while the route, the tools, the CLI, and `--set` use the flat key. Provenance per key is `argument`, `file`, or `default`; there is no detection and no pin, and neither key is start-only. Rejected: a nested `runner.claude` object on the route, which no other key uses.

**The default is the pinned id `claude-opus-5-5`, not the alias `opus`.** An alias follows the newest release, so a run's cost and behaviour would move when a model ships. The id is reproducible and the user can set the alias by file or argument when they want tracking.

**Validation is shape-only.** `effort` is the CLI's five levels. `model` matches `^[A-Za-z0-9][A-Za-z0-9._:-]*$`, which admits every alias and id Anthropic has published and excludes anything that could break out of the shell template (the template is run through `/bin/sh -c`, so the slot is filled unquoted and the token rule is what keeps it safe, the same reasoning as `isSafeRule`). The daemon keeps no list of models; a wrong name makes `claude` exit at once, the runner sees the process dead, and health monitoring records a failed attempt with the exit visible in the launch log. Rejected: a model allow list in config, which would need maintenance on every release and give nothing the launch failure does not.

**Task selectors are payload keys, validated at load.** `model` and `effort` on a node are validated like `scope`: a present value with the wrong shape fails graph validation naming the node. The import maps labels `model:<value>` and `effort:<value>` (prefix match, case-insensitive on the prefix) to those keys and keeps the label in `labels`. A label whose value fails the shape rule is left as a plain label and listed in the import summary under `ignoredLabels`, so a typo in Linear degrades to the run default with a visible note rather than refusing the import. Rejected: refusing the import, which would block a whole project on one label; and silently dropping the label, which hides the typo.

**Template slots `{model}` and `{effort}`, with `applied` per key.** `DEFAULT_CLAUDE_COMMAND` becomes `claude -p --output-format json --mcp-config {mcpConfig} --strict-mcp-config --permission-mode acceptEdits --allowedTools {allowedTools} --model {model} --effort {effort} --no-session-persistence < {brief}`. A `runnerCommand` without a slot runs verbatim and the configuration record marks that key `applied: false`, exactly as for `allowedTools`. The record's `model` and `effort` leaves carry `{ value, source, applied }`.

**Pull mode carries the values in the claim response; the workflow passes them through.** The claim response gains `model` and `effort`; `work.js` passes `{ model: c.model, effort: c.effort }` to the worker `agent()` call. Session workers then honour the task's choice the same way spawned agents do. The future cluster worker loop reads the same two fields.

**Events and status.** The `launch.created` event, the first durable record of a launch, carries `model` and `effort` in its payload; `status.liveLaunches[]` reports them; the `start` result and `status.config` show the run defaults with provenance.

## Risks / Trade-offs

- [Every task now costs Opus unless marked down] → the per-task `effort:` and `model:` labels are the lever; the skills name the default in the toolchain line so the operator sees it at start.
- [A model name the account cannot use fails every launch of that task] → the failure is immediate, visible in the launch log and the `launch.failed` reason, and bounded by `maxAttempts`; the run skill already surfaces failed attempts.
- [Session workers run with a model the session's plan may not include] → the workflow passes the value through unchanged; if `agent()` refuses it the worker returns nothing and the loop records a failed outcome, as today for any dead worker agent.
- [Existing launch rows have no model or effort] → read as absent; `status` shows them absent; nothing reconstructs the default of the time.
- [`runnerCommand` set by file loses the new flags] → by design; the record shows `applied: false` and the skills' line omits the model when it is not applied.

## Migration Plan

No store migration: the launch row is a JSON document and the two fields are optional. A run started after the change spawns with the new flags; a run already holding a `runnerCommand` override is unchanged. Rollback is reverting the code; stored overrides for `model` and `effort` are then unknown keys and are ignored by the strict override schema, which logs and drops them at start.

## Open Questions

- Whether the claimer agent in `work.js` should take a cheaper model by default. Left to the sibling discussion on retiring the claimer; not changed here.
