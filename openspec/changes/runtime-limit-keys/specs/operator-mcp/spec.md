## ADDED Requirements

### Requirement: Configure and start tools: limit keys
The `configure` tool SHALL take `budgets: { maxLaunchMs }` and `health: { stuckAfterMs, stuckFailAfterMs }`, each leaf an integer from 0 to `Number.MAX_SAFE_INTEGER` or null and each block an object or null, and forward them through the configuration route. The `start` tool SHALL take the same objects without null. Both objects SHALL be strict: a leaf the schema does not hold SHALL be refused by the tool, not dropped. The `configure` description SHALL name the keys and say that the values are milliseconds, that 0 disables a limit, that a change applies on the next tick, and that a null falls back to the file or the default.

#### Scenario: Configure raises a stuck limit
- **WHEN** `configure` is called with `health: { stuckFailAfterMs: 5400000 }`
- **THEN** the answer's `applied` holds `health` and its config gives the leaf as `{ value: 5400000, source: "argument" }`

#### Scenario: A mistyped leaf is refused
- **WHEN** `configure` is called with `health: { stuckFailAfterMS: 1 }`
- **THEN** the call is an error naming the leaf and nothing is sent

#### Scenario: The tools list the limit keys
- **WHEN** a client lists the tools
- **THEN** the input schemas of `configure` and `start` list `budgets` and `health`, and the `configure` description says that 0 disables a limit and that a change applies on the next tick
