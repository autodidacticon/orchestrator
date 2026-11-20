## ADDED Requirements

### Requirement: Worker tools: brief false on a remote claim
With `brief: false`, `claim` SHALL leave out only the parsed `brief`, also on a remote claim, whose answer keeps `briefMarkdown`; a remote worker writes its brief from `briefMarkdown`. The `claim` tool description SHALL say that `brief: false` leaves out only the parsed brief, that a local answer still carries `briefPath`, and that a remote answer, which has no `briefPath`, still carries `briefMarkdown`.

#### Scenario: Remote claim without the brief
- **WHEN** `claim` is called with `access: "remote"` and `brief: false` and the daemon answers a remote launch
- **THEN** the tool removes only `brief` from the daemon's answer, so the result keeps every other field of it, `briefMarkdown` among them

#### Scenario: Claim description
- **WHEN** the server lists its tools
- **THEN** the `claim` description says that `brief: false` leaves out only the parsed brief and that a remote answer still carries `briefMarkdown`
