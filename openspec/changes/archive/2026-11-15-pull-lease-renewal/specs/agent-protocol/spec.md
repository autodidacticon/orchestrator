## ADDED Requirements

### Requirement: Heartbeat interval
When the brief input carries the lease TTL, which the daemon passes from its `leaseTtlMs`, the brief's Reporting section SHALL carry a lease line and `brief.json` SHALL carry `leaseTtlMs`. The line SHALL state the TTL. It SHALL say to call an operation at least every third of the TTL, naming `lease.renewEveryMs` and its value. It SHALL say to run any longer command in the background and call `heartbeat` while it runs.

#### Scenario: Brief names the interval
- **WHEN** a launch is prepared under `leaseTtlMs: 60000`
- **THEN** `brief.json` has `leaseTtlMs: 60000` and `brief.md` says to call at least every 20s (`lease.renewEveryMs` 20000, a third of the lease) and to run longer commands in the background while calling `heartbeat`

### Requirement: No lease line without a TTL
A brief composed from an input without `leaseTtlMs` SHALL carry no lease line, and its `brief.json` no `leaseTtlMs`.

#### Scenario: No TTL, no line
- **WHEN** a brief is composed from an input without `leaseTtlMs`
- **THEN** the brief has no lease line and `brief.json` has no `leaseTtlMs`
