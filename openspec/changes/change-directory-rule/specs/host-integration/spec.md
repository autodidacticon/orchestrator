## ADDED Requirements

### Requirement: Import skill scope guidance for OpenSpec
The import skill of every host SHALL say that, in a repository with an `openspec/` root, a task that changes a spec lists its change directory `openspec/changes/<name>/**` in Scope, not `openspec/specs/<capability>/spec.md`. When an issue's Scope lists a file under `openspec/specs/`, the skill SHALL tell the user and suggest the change directory; the description is still sent as is.

#### Scenario: Import skill names the change directory
- **WHEN** the import skill of `hosts/claude-code`, `hosts/codex` or `hosts/opencode` is read
- **THEN** its Scope guidance names `openspec/changes/<name>/**` in place of `openspec/specs/<capability>/spec.md`

#### Scenario: Issue scope names a main spec file
- **WHEN** an issue being imported into a repository with an `openspec/` root lists `openspec/specs/worker-runners/spec.md` in its Scope
- **THEN** the skill tells the user and suggests `openspec/changes/<name>/**`, and imports the description unchanged
