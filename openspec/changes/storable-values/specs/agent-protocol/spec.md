## ADDED Requirements

### Requirement: Integer fields
The `log`, `heartbeat`, `report` and `block` calls SHALL check `seq`, when it is present, before anything is written; the lease renewal and the progress signal count as writes. `seq` SHALL be a non-negative safe integer. Otherwise the call SHALL answer 400 with `field: "seq"` and an error that names `seq`. The worker `usage` call SHALL require its token counts to be non-negative safe integers, and SHALL answer 400 naming the field before it records anything.

#### Scenario: Fractional seq
- **WHEN** an agent calls `log` with `"seq": 1.5`
- **THEN** the call answers 400 naming `seq`, and no event, dedup row or lease renewal is written

#### Scenario: Huge seq
- **WHEN** an agent calls `log` with `"seq": 1e30`
- **THEN** the call answers 400 naming `seq`, and nothing is written

### Requirement: Unstorable values answer 400
A write the store refuses with `UnstorableValueError` SHALL answer 400 with the error and its `field`, on agent and operator routes alike. A string the store cannot hold as it is SHALL NOT cause an error: it is stored with U+FFFD in place (see state-backend "Storable strings").

#### Scenario: NUL in a log text
- **WHEN** an agent calls `log` with `"text": "a\u0000b"`
- **THEN** the call answers 200 and the event holds `a�b`

#### Scenario: Store refusal over HTTP
- **WHEN** a route's write binds a non-integer to an integer column
- **THEN** the HTTP response is 400, with `field` naming `table.column`, and not 500
