## MODIFIED Requirements

### Requirement: Wait tool
`wait` SHALL take `afterSeq`, an optional `timeoutMs` defaulting to sixty seconds and capped at ninety seconds so that the call stays under the host's tool-call timeout: Claude Code's foreground limit, Codex's `mcp_servers.<id>.tool_timeout_sec`. It SHALL also take an optional `until` filter of `question`, `review`, `finished`, `stalled`, or `any`. It SHALL return the events since `afterSeq`, the latest sequence number, and the digest. When `until` is set it SHALL return early only when the digest satisfies the filter, otherwise at the timeout. Every poll a `wait` makes SHALL go to the daemon of the repository the call was bound to, for the whole duration of the call. Every poll SHALL send `cutSubmitted=true`, so that a milestone's submitted transition event comes with the cuts of the review index and an `omitted` list; the tool SHALL take no argument for it, and its description SHALL say that a submitted event comes cut and that `review` holds the rest. A daemon that ignores the parameter returns the event whole.

#### Scenario: Wait for a question
- **WHEN** `wait` is called with `until: question` and an agent blocks ten seconds later
- **THEN** the call returns within eleven seconds with the question in `openQuestions`

#### Scenario: Cap enforced
- **WHEN** `wait` is called with `timeoutMs` of ten minutes
- **THEN** it returns within ninety seconds

#### Scenario: Wait keeps its daemon
- **WHEN** a `wait` with `repo` A has returned from one poll on an event in A, and a call with `repo` B was made before its next poll
- **THEN** the next poll still goes to A's daemon with A's seq, and the `wait` returns A's digest

#### Scenario: Submitted event comes cut
- **WHEN** a gated milestone E is submitted while a `wait` with `until: review` is polling
- **THEN** the `wait` returns E's transition event to `submitted` with an `omitted` array in its payload, its summaries cut to `review.summaryChars` with `summaryLength` beside each, and the stored event is unchanged
