## Why

In pull mode the bundled workflow starts one claimer agent per worker loop per cycle. The claimer makes no decision: it calls `claim`, on 404 waits 30 seconds and reads `status`, and evaluates a boolean the prompt spells out. Yet it runs on the session's model, so a run with sixteen workers polling every half minute spends frontier-model tokens on a loop a script would run for free, and the session view fills with `claim:<worker>` agents that are hard to relate to the `work:<task>` agents beside them. The claimer stays for now, because a Workflow script cannot call a tool itself, but it should cost as little as possible and be visible as what it is.

## What Changes

- The claimer runs on a fixed cheap model at low effort by default (`claude-haiku-5-5`, `low`), configurable through the workflow arguments `claimModel` and `claimEffort`, which the `work` and `run` skills pass through when the user asks.
- One claimer invocation polls up to three times before returning: each poll is a `claim`, then on 404 a `wait` of up to 90 seconds (the tool's cap) and a `status`. A claimer only returns without a launch when its polls are exhausted or the stop rule holds, which cuts claimer launches per idle minute by about nine times.
- Labels relate claims to work: the claimer is labelled `claim <workerId>` and the worker `work <workerId> <taskId>`, so both agents of one loop share the worker id and the task id appears where the work is.
- The worker count is capped at the run's `capacity` inside the workflow, from a `capacity` argument the skills pass from `status`, so a loop cannot sit polling for a slot that the daemon will never fill.
- The `work` and `run` skills document the arguments and the default claimer model, and the host package test asserts the defaults and the pass-through.
- No daemon change.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `host-integration`: the `Work skill and workflow` requirement gains the claimer's model and effort defaults and arguments, the multi-poll claimer with the 90 second wait, the worker cap at capacity, and the label scheme.

## Impact

- Code: `hosts/claude-code/workflows/work.js` (args, claimer prompt, `agent()` options, labels, cap), `hosts/claude-code/skills/work/SKILL.md` and `hosts/claude-code/skills/run/SKILL.md` (arguments and the one-line note), `test/host/package.test.ts`.
- Behaviour: claimers cost roughly an order of magnitude less and appear far less often; a claimed launch is picked up within the same latency as before because the first `claim` of a poll is immediate. The stop rule is unchanged.
- Reaches the other sessions after a plugin release and `claude plugin update`.
- Out of scope: retiring the claimer (the session as claimer), which trades subagent tokens for session context and needs a slimmer claim response first; a non-LLM claimer, which needs a Workflow runtime that can call tools.
