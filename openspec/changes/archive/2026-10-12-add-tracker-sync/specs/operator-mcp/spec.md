## MODIFIED Requirements

### Requirement: Tool set
The server SHALL expose at least `start`, `stop`, `status`, `runs`, `import_issues`, `import_graph`, `wait`, `review`, `answer`, `cancel`, `reopen`, `unblock`, `accept`, `reject`, `pause`, `resume`, and `logs`, which form the base set, plus every tool another requirement of this capability adds. Mutating tools SHALL require the same arguments as the corresponding CLI commands. Every tool result SHALL be a single JSON text block. The implementation SHALL keep one list of tool names that the tests compare against the server's advertised tools, so that adding a tool is one change in one place.

#### Scenario: Tool list
- **WHEN** a client lists tools
- **THEN** every tool of the base set is present with an input schema, and every advertised tool is in the implementation's list of names

## ADDED Requirements

### Requirement: Outbox tools
The server SHALL expose `outbox`, taking optional `after` and `limit` and forwarding to the daemon's `outbox` route, and `ack`, taking an effect `id` and exactly one of `result` or `error`, forwarding to the `ack` route when `result` is given and to the `nack` route when `error` is given. A call with neither or both SHALL return an error without reaching the daemon. Both tools SHALL return the route's response as a single JSON text block.

#### Scenario: Tool list includes the outbox tools
- **WHEN** a client lists tools
- **THEN** `outbox` and `ack` are present with input schemas alongside the base set

#### Scenario: Acknowledge with an error
- **WHEN** `ack` is called with `id` 7 and `error` "rate limited"
- **THEN** the daemon records the rejection for effect 7 and the tool returns the route's response

#### Scenario: Neither result nor error
- **WHEN** `ack` is called with only `id`
- **THEN** the tool returns an error naming the missing argument and nothing is sent to the daemon
