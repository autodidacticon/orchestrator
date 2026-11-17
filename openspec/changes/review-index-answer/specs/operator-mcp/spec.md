## MODIFIED Requirements

### Requirement: Review tool
`review` SHALL take `milestone` and the optional arguments `task` (a string), `full` (a boolean), `statLines` and `summaryChars` (integers of 0 or more), forward the ones that are set to the daemon's review route as query parameters built with `URLSearchParams`, adding `full` only when it is `true`, and return the daemon's answer unchanged, so that the session can judge it or hand it to reviewers before calling `accept` or `reject`. Its description SHALL name `task`, `full` and `omitted`, and say that `full` can be too large for a client.

#### Scenario: Review then accept
- **WHEN** `review` is called for a submitted milestone and then `accept` is called with the returned sha and version
- **THEN** the milestone becomes done

#### Scenario: full false is the index
- **WHEN** `review` is called with `full: false`
- **THEN** no `full` parameter is sent and the answer is the index
