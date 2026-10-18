## Why

The import turns an epic into a run graph and the sync mirrors the run back, but both know only Linear and Jira. GitHub Issues now carries everything the mapping needs as first-class data (sub-issues, `blockedBy` dependencies, `stateReason` on closed issues, milestones), and the cloud-native plan already makes a GitHub repository the integration origin. Supporting GitHub as a tracker puts code, branches, and work items on one platform with one credential, and lets anyone starting from a GitHub repository use the orchestrator without a separate tracker connector. The daemon never contacts a tracker, so this is mostly a host change: a third branch in two skills, a new `kind`, and one small option.

## What Changes

- `tracker.kind` gains `github`; `workspace` names the repository as `owner/repo`; a new optional `inProgressLabel` names the label that stands for the in-progress state, since GitHub has no started state.
- Task ids for GitHub issues are path-safe and ref-safe: `GH-<number>` for issues in the tracker's repository, `GH-<owner>-<repo>-<number>` for issues referenced from another repository. The issue's URL stays on the payload and is what the drainer acts on.
- The `import` skill gets a GitHub section: prerequisite is `gh auth status` succeeding (or a GitHub MCP server), the root is an issue (`#n`, URL) or a milestone, children come from sub-issues or the milestone, dependencies from `blockedBy`, state from `state` and `stateReason`, in-progress from `inProgressLabel`, priority from `P0`..`P4` or `priority:<n>` labels, acceptance criteria from the body heading as today.
- The `run` skill's outbox drain gets a GitHub branch: `done` closes with reason `completed`, `cancelled` closes with reason `not planned`, `inProgress` reopens a closed issue and adds `inProgressLabel` (skip-acknowledged when no label is configured), comments carry the marker, proposals become sub-issues of the root blocked by the proposing issue, a milestone root is closed when the milestone is done and never commented on.
- Every enumeration of "Linear or Jira" in the skills, the README, the tool descriptions, and the host-integration spec names GitHub too.
- No daemon behaviour change beyond accepting the new `kind` and the optional label and reporting them.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `graph-import`: the `Tracker record` accepts `kind: github`, defines `workspace` as `owner/repo` for it, and carries the optional `inProgressLabel`.
- `host-integration`: `Skills` names GitHub (via the `gh` CLI) as a third connector with its own prerequisite; `Import skill records the tracker` and `Run skill mirrors to the tracker` gain the GitHub mapping for ids, states, labels, reopening, proposals, and milestone roots.

## Impact

- Code: `src/import/mapping.ts` (`trackerSchema`), `src/operator/mcp-server.ts` (tool descriptions), `hosts/claude-code/skills/import/SKILL.md`, `hosts/claude-code/skills/run/SKILL.md`, `README.md`, `test/import/mapping.test.ts`, `test/host/package.test.ts`.
- Behaviour for existing Linear and Jira users: none.
- Known limitation carried in the spec: the daemon derives effects for a milestone root only when the root record has a `url` or `trackerState`; a GitHub milestone root gets the milestone URL so its `done` is mirrored as closing the milestone. The separate bug that a synthesized root without a URL still derives effects is noted, not fixed here.
- Not in scope: a GitHub MCP connector shipped with the plugin (the `gh` CLI is the prerequisite), GitHub Projects fields, task lists in issue bodies as a dependency fallback, and an end-to-end test against a live repository.
