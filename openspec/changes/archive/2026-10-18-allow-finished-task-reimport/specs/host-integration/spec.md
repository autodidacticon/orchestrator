## MODIFIED Requirements

### Requirement: Import skill records the tracker
The `import` skill SHALL pass `tracker` to `import_issues`, with `kind` `linear`, `atlassian`, or `github` according to the connector it fetched from and `workspace` naming the Linear workspace, the Jira site, or the GitHub repository as `owner/repo`. For GitHub it SHALL build records as follows: the root is an issue named by number or URL, or a milestone; children are the root's sub-issues, or the milestone's issues; `blockedBy` comes from the issue's `blockedBy` dependencies, with every blocker outside the child set fetched for its state; ids are `GH-<number>` for issues in the tracker's repository and `GH-<owner>-<repo>-<number>` otherwise, a milestone root is `GH-M<number>`, and every record carries its `url`; `state` is `open` for an open issue, `inProgress` for an open issue carrying `inProgressLabel` when one is configured, `done` for a closed issue with reason `COMPLETED`, and `cancelled` for `NOT_PLANNED` or `DUPLICATE`; `priority` is the number from a `P0`..`P4` or `priority:<n>` label and is otherwise omitted; `labels` and `description` pass through. When a repository has a label that looks like an in-progress marker and none is configured, the skill SHALL offer it. When the root has no sub-issues or milestone issues the skill SHALL say so and SHALL NOT import an empty epic. A re-import after the run has published tasks SHALL send the tracker's current states as they are: the daemon accepts a published task becoming a done external, and a task the tracker shows reopened is not reopened by import but by `reopen`.

#### Scenario: Linear import names its tracker
- **WHEN** the import skill fetches an epic through the Linear tools
- **THEN** its `import_issues` call carries `tracker.kind` `linear`

#### Scenario: GitHub epic with a cross-repository blocker
- **WHEN** issue `acme/app#40` has sub-issues `#41` (open, labelled `in-progress`) and `#42` (closed, `COMPLETED`), `#41` is blocked by `acme/infra#7` (open), and the tracker is `{ kind: github, workspace: "acme/app", inProgressLabel: "in-progress" }`
- **THEN** the records are root `GH-40`, `GH-41` with state `inProgress` and `blockedBy: ["GH-acme-infra-7"]`, `GH-42` with state `done`, and `GH-acme-infra-7` with state `open`, each carrying its URL, and the mapped graph has `GH-41` as a task, `GH-42` and `GH-acme-infra-7` as external nodes

#### Scenario: Milestone root
- **WHEN** the user names the milestone "M1" of `acme/app`
- **THEN** the root record is `GH-M<number>` with the milestone's URL and state, and the milestone's issues are its children

#### Scenario: Priority from a label
- **WHEN** a child carries the labels `P1` and `backend`
- **THEN** its record has `priority: 1` and `labels: ["P1", "backend"]`
