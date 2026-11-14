## ADDED Requirements

### Requirement: Durable inbox
`GET /v1/launches/:id/inbox` renews the lease, records a progress signal and removes the notices it hands out, so it SHALL answer only once those writes are durable, like a POST. It SHALL hand out only notices whose records are durable. When the store goes fatal during the wait, the read SHALL NOT answer with notices.

#### Scenario: Notice queued during a stall
- **WHEN** the sink stalls, a nudge is queued, and the agent reads its inbox
- **THEN** the read does not answer until the sink accepts the nudge's record, and then answers with the nudge

#### Scenario: Durable notice, stalled inbox write
- **WHEN** a nudge is durable, the sink then stalls, and the agent reads its inbox
- **THEN** the read does not answer until its own writes are durable

### Requirement: Inbox notices handed out once
An inbox read SHALL take the notices the launch holds, wait until everything committed so far is durable, remove only the notices it took, and wait for that removal to be durable. A notice queued during the wait SHALL stay for the next read. Inbox reads of one launch SHALL run one at a time, so each notice is handed out once.

#### Scenario: Notice queued during the wait
- **WHEN** a second nudge is queued while an inbox read waits for durability
- **THEN** that read answers with the first nudge only, and the next read answers with the second

#### Scenario: Concurrent reads
- **WHEN** two inbox reads of one launch run at once while one notice is held
- **THEN** the notice is handed out by exactly one of them
