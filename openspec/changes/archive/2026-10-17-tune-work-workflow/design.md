## Context

`hosts/claude-code/workflows/work.js` fans out `workers` loops. Each cycle calls `agent(claimPrompt, { label: 'claim:<workerId>', phase: 'Claim', schema, effort: 'low' })`, inheriting the session's model, then on a claim calls `agent(workerPrompt, { label: 'work:<taskId>', phase: 'Work', schema, model, effort })` with the launch's model and effort from the claim response. The claimer's prompt is five fixed tool calls and a boolean; its only cost driver is which model evaluates it and how often it is started. The `wait` tool caps `timeoutMs` at 90000.

## Goals / Non-Goals

**Goals:**
- Make the claimer cheap by default and configurable, without changing what it does.
- Start fewer claimers per idle minute without delaying pickup of a newly parked launch.
- Make the session view readable: one worker id visible on both agents of a loop.

**Non-Goals:**
- Removing the claimer or moving the claim loop into the session.
- Changing the stop rule, the worker prompt, or any daemon route.
- Changing the model or effort the worker runs with; those come from the claim response.

## Decisions

**Fixed cheap default, overridable by argument.** `claimModel` defaults to `claude-haiku-5-5` and `claimEffort` to `low`. They are workflow args rather than daemon config because the claimer is a host concern: the daemon neither knows nor cares what polls it. The skills pass them only when the user names a different model; otherwise the defaults apply. Rejected: inheriting the session model (today), which bills frontier tokens for JSON copying; and reading the run default `config.model`, which is the worker's model and has nothing to do with polling.

**The id is pinned, not the alias.** `claude-haiku-5-5` rather than `haiku`, for the same reason the worker default is pinned in model-selection: the claimer's cost should not move when a new model ships.

**Three polls per claimer, 90 second waits.** Inside one claimer invocation the prompt instructs: claim; on 404, `wait` with `until: "any"` and `timeoutMs: 90000`, then `status`; evaluate the stop rule; if not stopping and polls remain, claim again. Three polls bound a claimer at about five minutes, inside the agent runtime's comfort, and mean an idle loop starts one claimer per five minutes instead of one per thirty seconds. Pickup latency is unchanged because `wait` returns as soon as any event lands, including `launch.claimable`. Rejected: an unbounded poll loop inside one agent, which would make a stuck claimer invisible to the workflow; and polling without `wait`, which would hammer the daemon.

**Labels carry the worker id on both sides.** `claim <workerId>` and `work <workerId> <taskId>`. The space-separated form reads as a sentence in the progress tree and sorts by worker. The log lines already use the worker id.

**Cap workers at capacity inside the workflow.** The skills already say "no larger than capacity", but a user can pass more. The workflow takes `capacity` as an argument (the skills read it from `status`) and clamps `workers` to it, logging when it did. Rejected: having the workflow call `status` itself, which a script cannot do.

**Claimer failure stays a stop.** An agent that returns nothing (`null`) ends its loop, as today. With a cheaper model this becomes slightly more likely; the structured-output schema retries on mismatch, and the loop's other workers are unaffected.

**Worktrees are outside the repository, and `acceptEdits` knows it.** Found while running the real-session test: `acceptEdits` auto-approves edits only inside the working directory and `--add-dir` directories, and the workers' worktrees live under `ORCH_HOME`. The headless test now passes `--add-dir` for its `ORCH_HOME`, and both skills tell the user about the prompt. This predates the change (the test last passed on an older CLI) and is a property of pull mode as such; it is documented here because this is where it surfaced.

## Risks / Trade-offs

- [A cheaper model fumbles a tool call or the stop rule] → the schema forces a well-formed return and the rule is spelled out as a formula; a wrong `stop: true` ends one loop early, which the skills already handle by re-running the workflow with the same run tag.
- [Longer polls hide a dead claimer for up to five minutes] → the loop count is bounded and the workflow's progress view shows the claimer running; the daemon's view is unaffected since nothing is claimed while polling.
- [Fewer claimers means a question raised during a poll is seen later] → questions are surfaced by the session's own `wait` loop, not by the claimer, so no change.

## Migration Plan

Edit the workflow and skills, bump nothing in the daemon. Reaches installed plugins after the next release and `claude plugin update`; a session already running the old workflow keeps it until re-run.

## Open Questions

- Whether to expose `claimModel` and `claimEffort` as daemon config so a run can pin them durably. Left out until a second host needs them.
