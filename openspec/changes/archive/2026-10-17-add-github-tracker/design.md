## Context

`import_issues` takes normalized records `{ id, title, description?, state, blockedBy[], parent?, labels?, priority?, url? }` plus a `tracker` of `{ kind: linear | atlassian, workspace? }`; the session builds the records with its own tracker tools (`hosts/claude-code/skills/import/SKILL.md`). The daemon records the tracker, derives vendor-agnostic effects (`setState inProgress | done | cancelled`, `comment`) into an outbox, and the `run` skill drains them with the same tools (`hosts/claude-code/skills/run/SKILL.md` section 2a), mapping states by type. `status` and the `outbox` policy report the recorded tracker.

GitHub, checked against the account's GraphQL schema: `Issue` has `parent`, `subIssues`, `blockedBy`, `blocking`, `stateReason` (`COMPLETED`, `NOT_PLANNED`, `DUPLICATE`, `REOPENED`), `issueType`, `milestone`; mutations include `addSubIssue`, `addBlockedBy`, `closeIssue`, `reopenIssue`, `addLabelsToLabelable`, `addComment`, `createIssue`. The `gh` CLI (2.102) offers `issue close --reason {completed|not planned|duplicate}`, `issue reopen`, `issue edit --add-label`, `issue comment`, and `issue create --parent <number|URL>`, and is installed and authenticated on this machine.

## Goals / Non-Goals

**Goals:**
- Import a GitHub issue or milestone with its sub-issues and dependencies into a run graph with the existing mapping.
- Mirror run state back to GitHub issues through the existing outbox, with no daemon changes beyond the record.
- Keep the Linear and Jira paths byte-for-byte unchanged.

**Non-Goals:**
- GitHub Projects fields for state or priority.
- Parsing task lists or "blocked by" text from issue bodies as a fallback for organisations without sub-issues or dependencies.
- Shipping or requiring a GitHub MCP server; the `gh` CLI through Bash is the prerequisite, an MCP server is accepted when present.
- An end-to-end test against a live repository.

## Decisions

**Path-safe, ref-safe ids; fidelity lives in `url`.** Task ids travel through URL path segments (`/v1/tasks/:id/...`, captured as `[^/]+`, with clients that do not encode), git branch names (`task/<id>/l<n>`), milestone tags, and commit trailers. GitHub's natural key `owner/repo#123` breaks the first two: `/` fails the capture and `#` is a URL fragment. The id is therefore `GH-<number>` for issues in the tracker's repository and `GH-<owner>-<repo>-<number>` for an issue referenced from another repository (an external blocker). The payload's `url` carries the exact issue, and every `gh issue` command accepts a URL, so the drainer never needs the GitHub key in the id. Rejected: fixing encoding at the route and client layer, which widens the change for no gain; `owner-repo-123` for every id, which is long and still ambiguous when names contain hyphens.

**One label for in-progress, used on both sides.** GitHub has no started state. The tracker record gains `inProgressLabel?`. At import an open issue carrying the label is `inProgress`; at sync `setState inProgress` adds the label, and with no label configured the drainer acknowledges the effect as skipped so it does not retry. The outbox already reports the tracker record in `policy.tracker`, so the drainer reads the label from there. Rejected: a Projects status field, which requires a project and a GraphQL field id per project; assignee-as-in-progress, which conflates ownership with state.

**Reopen before labelling.** A reopened task derives `setState inProgress` again. On GitHub a closed issue cannot meaningfully carry an in-progress label, so the drainer reopens it first (`gh issue reopen`), then labels. `done` closes with reason `completed`, `cancelled` closes with reason `not planned`; the drainer never uses `duplicate`.

**State from `state` and `stateReason`.** `OPEN` is `open`, or `inProgress` when the label is present. `CLOSED` with `COMPLETED` is `done`; `NOT_PLANNED` or `DUPLICATE` is `cancelled`. `REOPENED` only appears on open issues and maps with them.

**Milestone roots get the milestone URL.** A GitHub Milestone is a natural epic. The root record is `{ id: GH-M<number>, state from the milestone's open/closed, url: <milestone URL> }`; children are the issues in the milestone. Because the daemon derives effects only for nodes with `url` or `trackerState`, giving the root its URL is what makes its `done` mirror legitimately: the drainer closes the milestone and skips `comment` effects for it, since milestones take no comments. The existing bug that a synthesized root without a URL still derives effects is out of scope.

**Priority from labels.** GitHub has no priority field. The import skill maps a label `P0`..`P4` or `priority:<n>` to a numeric `priority` and otherwise omits it, so the existing priority normalisation applies unchanged. The label itself stays in `labels`, like the `model:` and `effort:` selectors.

**Proposals become sub-issues.** On acceptance the run skill creates the issue with `gh issue create --parent <root URL>`, adds the dependency on the proposing issue with the `addBlockedBy` mutation (the CLI has no flag for it), and passes `GH-<new number>` as `nodeId`.

**Prerequisite is a working `gh`, not a tool-name prefix.** The import skill's check becomes: Linear or Atlassian MCP tools present, or `gh auth status` succeeding through Bash, or a GitHub MCP server. The refusal message names all three.

## Risks / Trade-offs

- [Sub-issues and dependencies are recent GitHub features and may be absent on some plans] → the skill reports a root with no sub-issues as "no children found" rather than importing an empty epic, and names task lists as the thing it does not parse.
- [Label-based in-progress is a convention, not a state] → it is optional, configurable, and skipped cleanly when unset; the mirror still closes issues correctly without it.
- [Ids `GH-<n>` lose the repository] → `workspace` records it and `url` is exact; the id is for the run, not for GitHub.
- [`gh` runs under the user's token in the session] → the same trust model as the Linear and Atlassian connectors; agents never get `gh` in their allow list.
- [GraphQL rate limits on large epics] → one query per child plus one per outside blocker; well under limits at the scale of a run.

## Migration Plan

Schema change is additive (`github` in the enum, an optional field); existing runs and stores are unaffected. Reaches installed plugins with the next release.

## Open Questions

- Whether `inProgressLabel` should default to a conventional name such as `in-progress` when the repository already has that label. Left unset by default; the skill offers to set it when it sees such a label.
