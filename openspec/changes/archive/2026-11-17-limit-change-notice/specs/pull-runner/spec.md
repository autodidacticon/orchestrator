## MODIFIED Requirements

### Requirement: Silence limit in the claim
The claim response, first and repeated, SHALL carry `health: { stuckFailAfterMs }` with the daemon's `health.stuckFailAfterMs` in force. A work loop without `--max-silence-ms` SHALL take it as its first silence limit when it is positive, and SHALL then follow `budgets.stuckFailAfterMs` from `GET /v1/status` as host-integration "Work loop silence limit" states; when the value is 0 (the daemon never fails a stuck launch) the loop SHALL keep its own default, so a hung agent whose lease the loop renews is still bounded.

#### Scenario: Claim states the threshold
- **WHEN** a worker claims a launch under `health.stuckFailAfterMs: 1800000`
- **THEN** the response has `health: { stuckFailAfterMs: 1800000 }`, and a loop without `--max-silence-ms` ends a silent agent after 1800000ms unless `status` names another value meanwhile
