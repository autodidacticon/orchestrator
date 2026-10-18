## MODIFIED Requirements

### Requirement: Wait tool
`wait` SHALL take `afterSeq`, an optional `timeoutMs` defaulting to sixty seconds and capped at ninety seconds so that the call stays under the host's tool-call timeout: Claude Code's foreground limit, Codex's `mcp_servers.<id>.tool_timeout_sec`. It SHALL also take an optional `until` filter of `question`, `review`, `finished`, `stalled`, or `any`. It SHALL return the events since `afterSeq`, the latest sequence number, and the digest. When `until` is set it SHALL return early only when the digest satisfies the filter, otherwise at the timeout.

#### Scenario: Wait for a question
- **WHEN** `wait` is called with `until: question` and an agent blocks ten seconds later
- **THEN** the call returns within eleven seconds with the question in `openQuestions`

#### Scenario: Cap enforced
- **WHEN** `wait` is called with `timeoutMs` of ten minutes
- **THEN** it returns within ninety seconds
