---
name: import
description: Import an epic or parent issue from Linear or Jira into the orchestrator's run graph for this repository. Use when the user wants to turn a tracker epic, parent issue, project milestone, or list of issues into an orchestrated run.
---

# Import an epic into the run graph

You turn a tracker epic into a graph the orchestrator can run. The mapping is done by the
`import_issues` tool; your job is to fetch the issues with the tracker tools already in this
session and hand over normalized records.

## 1. Check the prerequisites

- A Linear or Atlassian (Jira) MCP server must be connected. Look for tools whose names start
  with `mcp__plugin_linear`, `mcp__linear`, `mcp__plugin_atlassian`, or `mcp__atlassian`. If
  none exist, stop and tell the user: "No Linear or Jira connector is available in this
  session; connect one (for example the Linear or Atlassian plugin) and run the import again."
  Do not call `import_issues`.
- The orchestrator daemon must be running for this repository. Call the `start` tool; it is
  idempotent and returns the run directory, the graph path, and the resolved configuration.
  Report the toolchain in one line: the check command and the integration branch with the
  source of each (for example "detected: npm test on main"). When `needsConfig` names
  `checkCommand`, follow the run skill's section 1b (read `CLAUDE.md`, the README, and the
  root manifests; set it with `configure` when it is stated unambiguously, otherwise ask) before
  continuing, so that the first submission is not held.

## 2. Fetch the root and everything it references

Identify the root from the user's input: an issue key such as `ENG-123`, a URL, or a title.

For **Linear**: fetch the root issue; fetch its child issues (sub-issues); for every child,
read its relations and collect the issues that block it (`blockedBy`). For every blocker that
is not itself a child, fetch that issue too so you know its state. If the root is a project
milestone rather than an issue, treat the issues assigned to the milestone as the children.

For **Jira**: fetch the root (an epic or any parent); fetch the issues whose parent is the root
(or whose epic link is the root); for every child, read the issue links of type "is blocked
by"; fetch each blocker outside the child set.

## 3. Build normalized records

One record per issue you fetched, including the root:

```
{ id, title, description?, state, blockedBy: [ids], parent?: id, labels?, priority?, url? }
```

- `id` is the tracker key (`ENG-123`, `PROJ-45`).
- `state` is one of `open`, `inProgress`, `done`, `cancelled`. Map tracker states: anything
  unstarted or backlog is `open`; started or in review is `inProgress`; completed is `done`;
  cancelled, duplicate, or won't-do is `cancelled`.
- `parent` is the root id for each child.
- `description` is the raw text. Acceptance criteria are parsed from a heading named
  "Acceptance criteria" (configurable with `options.criteriaHeading`). A heading named
  "Scope" (configurable with `options.scopeHeading`) lists the path globs the task's work
  stays within, one per bullet, such as `src/api/**` or `package.json`; the orchestrator
  never runs two tasks with overlapping scopes at the same time. Leave it out when the
  issue does not say.
- `priority` is a number where a lower number is more urgent; the orchestrator uses it to
  break ties between ready tasks with equally long chains behind them. Linear: send the
  issue's `priority` field as is (its 0, meaning none, is dropped). Jira: send the position
  of the issue's priority in the site's priority list, counted from the most urgent as 1.
  Omit it when the tracker has no priority.

## 4. Import

Call `import_issues` with `{ root, issues, tracker, options? }`. Options: `criteriaHeading`,
`scopeHeading`, `inProgress` (`external` by default: issues a human is working on are not
taken over; set `task` to orchestrate them), `gated` (the root milestone waits for human
review, default true).

Always pass `tracker`: `{ kind: "linear" }` when you fetched through the Linear tools,
`{ kind: "atlassian" }` through the Atlassian tools, plus `workspace` naming the Linear
workspace (its URL key) or the Jira site when the connector reports it. The daemon records it
and from then on mirrors the run back to the tracker through the `run` skill: issues move to
in progress, done, or cancelled, and comments appear where a human is needed.

## 5. Report

Show the user the summary: counts of tasks, external nodes, and milestones; the tasks missing
acceptance criteria, which will block at ready until someone adds them; any unknown external
blockers; and whether the graph was accepted by the daemon. If the import was rejected as an
incompatible reload, show the reasons and suggest cancelling the affected tasks first.

Then offer to run it with the `run` skill.
