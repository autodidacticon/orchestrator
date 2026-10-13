## ADDED Requirements

### Requirement: Priority normalisation
The import SHALL pass a record's `priority` into the task payload unchanged, except that a numeric priority of 0, which Linear uses for no priority, SHALL be omitted so that the task sorts as having no priority.

#### Scenario: Linear no-priority omitted
- **WHEN** a child record has `priority: 0`
- **THEN** the mapped task payload has no `priority`

#### Scenario: Other priorities pass through
- **WHEN** two child records have `priority: 1` and `priority: 4`
- **THEN** the mapped payloads carry `priority` 1 and 4 unchanged

### Requirement: Scope from the description
The import SHALL split a description at the first heading matching the configured scope heading, default "Scope", case-insensitively, with the same splitter as acceptance criteria. Each bullet, numbered, or checklist item under that heading up to the next heading SHALL become one glob in the task's `scope`. `description` SHALL be the text before the first of the criteria and scope headings, in whichever order they appear. A description without the scope heading SHALL yield no `scope`.

#### Scenario: Scope parsed
- **WHEN** a description reads "Do the thing.\n\n## Acceptance criteria\n- it works\n\n## Scope\n- src/api/**\n- package.json"
- **THEN** `description` is "Do the thing.", `acceptanceCriteria` is ["it works"], and `scope` is ["src/api/**", "package.json"]

#### Scenario: Headings in either order
- **WHEN** the scope heading precedes the criteria heading
- **THEN** `description` is the text before the scope heading and both lists are parsed

#### Scenario: No scope heading
- **WHEN** a child's description has no scope heading
- **THEN** the mapped task has no `scope` and the import succeeds
