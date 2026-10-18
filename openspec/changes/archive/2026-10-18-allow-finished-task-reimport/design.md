## Context

`classifyReload` in `src/graph/diff.ts` marks a started task (status `running`, `waiting`, `submitted`, or `done`) whose `kind` changed as `kindChangedStarted`, and the whole reload is refused. The import maps a closed tracker issue to an external node with `done: true` (done or cancelled). After the run publishes a task and the sync closes its issue, the next import therefore turns that task into a done external, which the classifier refuses.

## Goals / Non-Goals

**Goals:** accept the one kind change that the run's own progress produces. **Non-Goals:** any other relaxation of reload compatibility; changing how externals are scheduled.

## Decisions

**Narrow exception, checked on both sides.** The exception applies only when the old kind is `task`, the new kind is `external`, the entry status is `done`, and the new node's `done` is true. The entry is left as it is, so the task's history, launches, and cost remain; dependants and milestones already treat it as satisfied, and the external node's `done: true` agrees. A done task becoming an external with `done: false` stays refused, because the entry and the node would disagree about whether dependants may proceed. External back to task while the entry is done stays refused, because the entry's `done` would then describe a task the graph says is unstarted. Rejected: letting the import skill keep the run's tasks as tasks, which hides the tracker's truth and needs every connector to carry the workaround.

## Risks / Trade-offs

- [A reopened task later in the tracker is not reflected] → reopening is a human action in the orchestrator (`reopen`), not something the import infers; the skill says so.
