## ADDED Requirements

### Requirement: Suite reproduction of an import racing a reload
The test suite SHALL reproduce on demand, without product code changes, an import through the graph route whose reload runs alongside another reload of the same graph file. A test that imports into a running daemon SHALL judge an answer of `accepted: false` with no reasons by the daemon's active graph rev, and SHALL treat an answer with reasons as a rejection.

#### Scenario: Import answered not accepted on demand
- **WHEN** `test/slice/import-reload-race.test.ts` runs with `ORCH_TEST_REPRO=import-reload-race`, which starts the orchestrator's `loadGraph` just before the route's own poll and lets it record the file's new mtime first
- **THEN** the written graph is active, the route answers `accepted: false` with no reasons, and the test fails

#### Scenario: Operator MCP imports under a ticking daemon
- **WHEN** an operator MCP slice test imports a graph or issues and the answer is `accepted: false` with no reasons
- **THEN** the test counts the import as accepted only once the status tool's `graphRev` equals the answer's `rev`, waiting up to 5 seconds
