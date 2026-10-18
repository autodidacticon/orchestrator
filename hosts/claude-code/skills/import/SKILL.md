---
name: import
description: Import an epic or parent issue from Linear, Jira, or GitHub Issues into the orchestrator's run graph for this repository. Use when the user wants to turn a tracker epic, parent issue, project milestone, GitHub milestone, or list of issues into an orchestrated run.
---

# Import an epic into the run graph

You turn a tracker epic into a graph the orchestrator can run. The mapping is done by the
`import_issues` tool; your job is to fetch the issues with the tracker tools already in this
session and hand over normalized records.

## 1. Check the prerequisites

- A tracker connector must be available: a Linear or Atlassian (Jira) MCP server (tools whose
  names start with `mcp__plugin_linear`, `mcp__linear`, `mcp__plugin_atlassian`, or
  `mcp__atlassian`), a GitHub MCP server, or the `gh` CLI for GitHub Issues: run
  `gh auth status` with Bash and treat success as the connector. If none is available, stop
  and tell the user: "No tracker connector is available in this session; connect the Linear or
  Atlassian plugin, a GitHub MCP server, or log in with `gh auth login`, and run the import
  again." Do not call `import_issues`. When more than one is available, use the one the
  user's root belongs to (a GitHub URL or `#123` means GitHub).
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

For **GitHub**: the root is an issue (`#123`, `owner/repo#123`, or its URL) or a milestone
(by name or URL). Query the GraphQL API through `gh api graphql` (or the GitHub MCP server).
For an issue root fetch its `subIssues` as the children; for a milestone root fetch the issues
in the milestone. For every child read `blockedBy` and collect the blockers; fetch each blocker
outside the child set for its state. One query shape covers every issue:

```
query($owner:String!, $repo:String!, $n:Int!) { repository(owner:$owner, name:$repo) { issue(number:$n) {
  number url title body state stateReason
  labels(first:50) { nodes { name } }
  milestone { number url title state }
  parent { number url repository { nameWithOwner } }
  subIssues(first:100) { nodes { number url title body state stateReason labels(first:50) { nodes { name } } repository { nameWithOwner } } }
  blockedBy(first:50) { nodes { number url state stateReason repository { nameWithOwner } } }
} } }
```

If the root has no sub-issues (or the milestone no issues), say so and stop: this skill does
not parse task lists or "blocked by" text in issue bodies, and an empty epic is not imported.
A re-import after the run has published tasks needs no special handling: send the tracker's
current states as they are. The daemon accepts a published task becoming a closed (done)
external node; a task the tracker shows reopened is not reopened by import but with `reopen`.
Repositories on plans without sub-issues or dependencies need the parent to be a milestone.

## 3. Build normalized records

One record per issue you fetched, including the root:

```
{ id, title, description?, state, blockedBy: [ids], parent?: id, labels?, priority?, url? }
```

- `id` is the tracker key (`ENG-123`, `PROJ-45`).
- `state` is one of `open`, `inProgress`, `done`, `cancelled`. A `done` or `cancelled` child
  becomes an external node that already counts as satisfied: it neither holds the milestone
  nor blocks a dependant. Map tracker states: anything
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
  GitHub: the number from a label `P0`..`P4` or `priority:<n>`, otherwise omit it; the label
  stays in `labels`. Omit it when the tracker has no priority.
- GitHub records differ in three ways. `id` is `GH-<number>` for an issue in the tracker's
  repository, `GH-<owner>-<repo>-<number>` for an issue in another repository, and `GH-M<number>`
  for a milestone root (GitHub's own key, `owner/repo#123`, is not usable: ids travel through
  URL paths and git branch names); always set `url`, which is what the run skill acts on.
  `state` is `open` for an open issue, `inProgress` for an open issue carrying the in-progress
  label when one is configured, `done` for a closed issue whose `stateReason` is `COMPLETED`,
  and `cancelled` for `NOT_PLANNED` or `DUPLICATE`. `parent` is the root's id for every child.
- `labels` are passed through. Two label shapes choose the worker for the task: `model:<name>`
  (for example `model:claude-sonnet-5-5`) and `effort:<level>` (`low`, `medium`, `high`,
  `xhigh`, or `max`). Without them a task runs with the run's defaults (`claude-opus-5-5` at
  `medium`, changeable with `configure`). A label whose value is not recognised is left as a
  plain label and reported under `ignoredLabels`.

## 4. Import

Call `import_issues` with `{ root, issues, tracker, options? }`. Options: `criteriaHeading`,
`scopeHeading`, `inProgress` (`external` by default: issues a human is working on are not
taken over; set `task` to orchestrate them), `gated` (the root milestone waits for human
review, default true).

Always pass `tracker`: `{ kind: "linear" }` when you fetched through the Linear tools,
`{ kind: "atlassian" }` through the Atlassian tools, `{ kind: "github" }` through `gh` or a
GitHub MCP server, plus `workspace` naming the Linear workspace (its URL key), the Jira site,
or the GitHub repository as `owner/repo`. For GitHub also pass `inProgressLabel` when the
repository uses a label for work in progress: GitHub has no started state, so this label is
both how an open issue reads as in progress at import and what the run skill adds when a task
starts. When no label was given and the repository has one that looks like it (`in-progress`,
`in progress`, `status: in progress`), offer it to the user before importing; without one, in
progress is simply not mirrored. The daemon records the tracker and from then on mirrors the
run back through the `run` skill: issues move to in progress, done, or cancelled, and comments
appear where a human is needed.

## 5. Report

Show the user the summary: counts of tasks, external nodes, and milestones; any
`ignoredLabels` (say which issue's `model:` or `effort:` label was not recognised and that the
task will use the run default); the tasks missing
acceptance criteria, which will block at ready until someone adds them; any unknown external
blockers; and whether the graph was accepted by the daemon. If the import was rejected as an
incompatible reload, show the reasons and suggest cancelling the affected tasks first.

Then offer to run it with the `run` skill.
