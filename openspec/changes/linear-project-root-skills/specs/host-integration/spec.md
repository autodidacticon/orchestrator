## ADDED Requirements

### Requirement: Run skill handles a Linear project-milestone root
The `run` skill SHALL treat a Linear effect whose `url` is a project URL (its path holds `/project/` and not `/issue/`) as an effect for a project-milestone root. It SHALL never change the project's state: every `setState` effect for such a root SHALL be acknowledged with `ack { id, result: { applied: false, reason } }`. It SHALL post only a `comment` whose body opens with "Milestone accepted:" or "Milestone rejected:", as a project status update on the project the `url` names, with the body, a blank line and the marker as the last line, setting no health value (keeping the current health when the tool requires one), and SHALL acknowledge it with `result: { statusUpdateId }`. Before posting it SHALL list the project's recent status updates and, if one holds the effect's marker, acknowledge with that update's id and not post again. Every other comment effect for such a root SHALL be acknowledged with `applied: false` and a reason. When the session has no tool that posts a project status update, the skill SHALL acknowledge the accept and reject comments with `applied: false` and a reason that says so, and tell the user once. These effects SHALL be answered with `result`, never with `error`, except that a tracker error while posting a status update is an error. An effect acknowledged with `applied: false` SHALL be counted in neither number of the tracker count line. A Linear effect with an issue URL SHALL follow the existing rules.

#### Scenario: Done for a project root
- **WHEN** the outbox lists `setState done` for a root whose `url` holds `/project/`
- **THEN** the skill acknowledges it with `applied: false` and a reason, and the project is unchanged

#### Scenario: In progress for a project root
- **WHEN** the outbox lists `setState inProgress` for a root whose `url` holds `/project/`
- **THEN** the skill acknowledges it with `applied: false` and a reason, and the project is unchanged

#### Scenario: Ready for review comment
- **WHEN** the outbox lists the ready-for-review comment for a root whose `url` holds `/project/`
- **THEN** the skill posts nothing and acknowledges it with `applied: false` and a reason

#### Scenario: Accepted comment
- **WHEN** the outbox lists a comment opening "Milestone accepted:" for a project root
- **THEN** the skill posts a project status update with the body, a blank line and the marker as the last line, and acknowledges with `statusUpdateId`

#### Scenario: Rejected comment
- **WHEN** the outbox lists a comment opening "Milestone rejected:" for a project root
- **THEN** the skill posts a project status update with the body, a blank line and the marker as the last line, and acknowledges with `statusUpdateId`

#### Scenario: Marker already posted
- **WHEN** a recent status update of the project already holds the effect's marker
- **THEN** the skill acknowledges with that update's id and posts no second update

#### Scenario: Issue URL
- **WHEN** a Linear effect has a `url` holding `/issue/`
- **THEN** the skill follows the existing state-type and comment rules

### Requirement: Import skill records a Linear project-milestone root
The `import` skill SHALL state that for a Linear project-milestone root the root record's `url` is the project's URL, its `id` is a short key the user confirms that is safe in a URL path and a git branch name, and its `state` is `open`.

#### Scenario: Project milestone root
- **WHEN** the user imports a Linear project milestone
- **THEN** the root record carries the project's URL as `url`, and the milestone's issues are the children
