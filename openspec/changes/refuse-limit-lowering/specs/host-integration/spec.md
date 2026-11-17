## ADDED Requirements

### Requirement: Run skill confirms a lowering with the user
The bullet `- **a launch needs more time**` of each run skill SHALL say that a lowered, cleared or switched-on limit that a live launch is already past is refused with a 409 whose `wouldEnd` lists the launches it would end and that nothing is applied, that the agent shows `wouldEnd` to the user, and that it sends the call again with `endLive: true` only when the user says so. The Claude Code, Codex and OpenCode editions SHALL hold the same sentence. A session SHALL NOT add `endLive` by itself after a 409.

#### Scenario: The refusal is shown
- **WHEN** the bullet is cut out of each run skill
- **THEN** it holds `wouldEnd` and `endLive` and says to send `endLive` only when the user says so

#### Scenario: The confirmed change
- **WHEN** the user, shown `wouldEnd`, says to go on
- **THEN** the skill has the agent send the same call with `endLive: true`

#### Scenario: Clearing a raise
- **WHEN** the agent clears a raise with a null leaf once a launch has reported, and another live launch relies on the raise
- **THEN** the 409 with `wouldEnd` is shown to the user, and `endLive` is sent only on the user's say
