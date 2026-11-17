## ADDED Requirements

### Requirement: Configure tool: endLive
The `configure` tool SHALL take `endLive`, a boolean, and SHALL send it as `endLive: true` beside the patch to `PUT /v1/config`, never inside the patch, so it is neither folded with the runner arguments nor stored. The tool SHALL return the route's 409 with `wouldEnd` unchanged, as an error. The `configure` description SHALL say that a change that would end a live launch is refused without `endLive`, that the 409 lists the launches under `wouldEnd`, and that `endLive` is sent only when the user says so. The `start` tool SHALL NOT take `endLive`.

#### Scenario: The refusal
- **WHEN** `configure` is called with `budgets: { maxLaunchMs: 1 }` while a running task's launch is live
- **THEN** the call is an error whose body is the route's 409 with `wouldEnd` naming that launch

#### Scenario: The confirmed change
- **WHEN** the same call is made with `endLive: true`
- **THEN** the answer is 200 with `applied` holding `budgets`

#### Scenario: Clearing a raise
- **WHEN** `configure` is called with `budgets: { maxLaunchMs: null }` while a launch that is past the file's budget lives under a raise
- **THEN** the call is an error with the route's 409 and `wouldEnd`, and the same call with `endLive: true` is applied

#### Scenario: The tools list
- **WHEN** a client lists the tools
- **THEN** the `configure` input schema lists `endLive` beside its other properties, the `start` input schema does not, and the `configure` description says that a change that would end a live launch is refused without `endLive`
