## Context

`mapIssues` in `src/import/mapping.ts` builds an external node for every child whose state is `done`, `cancelled`, or `inProgress`, with `done: rec.state === 'done'`. The milestone depends on every child, and a task may be blocked by any of them. The run skill's GitHub branch (`hosts/claude-code/skills/run/SKILL.md` section 2a) adds `inProgressLabel` on `setState inProgress` and closes on `done` and `cancelled` without touching labels.

## Goals / Non-Goals

**Goals:** a cancelled child never holds a milestone or a dependant; a closed GitHub issue does not carry the in-progress label.

**Non-Goals:** changing how cancelled issues are reported (they stay external nodes with `trackerState: cancelled`); label handling for Linear or Jira, which have real states.

## Decisions

**`done: true` for cancelled, not exclusion.** Dropping cancelled children from the graph would lose them from the review and from any `blockedBy` edge that names them; marking them done keeps the node and satisfies both the milestone and dependants. The external node's `done` flag means "nothing more will happen here", which is as true of a cancelled issue as of a finished one. `trackerState` preserves the distinction for humans.

**Remove the label on close, in the skill only.** The daemon's effects stay vendor-agnostic; the GitHub branch of the drainer is where label semantics live. Removing a label the issue does not carry is a no-op in `gh`, so the skill removes unconditionally.

## Risks / Trade-offs

- [A cancelled blocker lets a dependant start that a human meant to hold] → the dependant's brief shows the dependency's report as cancelled through `trackerState`; a human who wants the hold should leave the issue open.
