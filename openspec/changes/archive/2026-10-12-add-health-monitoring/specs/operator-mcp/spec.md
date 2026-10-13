## ADDED Requirements

### Requirement: Nudge tool
The server SHALL expose `nudge`, taking `task` and `message`, forwarding to the nudge route and returning its response as a single JSON text block, in addition to the tools listed under the tool set.

#### Scenario: Nudge through the tool
- **WHEN** the `nudge` tool is called for running task T2 with a message
- **THEN** the daemon records the operator nudge event and T2's launch holds the notice

#### Scenario: Tool list includes nudge
- **WHEN** a client lists tools
- **THEN** `nudge` is present with an input schema requiring `task` and `message`

### Requirement: Wait digest: health fields
The digest returned by `wait` and `events` SHALL include `stuck` and `pausedReason`. Because flagging, unflagging, and budget pauses are recorded as events, `wait` with `until: any` SHALL return when they change. The `resume` tool SHALL accept `overrideBudget`.

#### Scenario: Wait returns on a stuck flag
- **WHEN** `wait` is called with `until: any` and a launch is flagged stuck ten seconds later
- **THEN** the call returns within eleven seconds with the task in the digest's `stuck`

#### Scenario: Digest shows a budget pause
- **WHEN** the run cost budget is reached during a `wait`
- **THEN** the returned digest has `paused` true and `pausedReason` `costBudget`
