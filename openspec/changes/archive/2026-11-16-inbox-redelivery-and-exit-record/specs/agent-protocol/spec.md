## MODIFIED Requirements

### Requirement: Inbox notices handed out once
An inbox read SHALL take the notices the launch holds, wait until everything committed so far is durable, remove only the notices it took, and wait for that removal to be durable. A notice queued during the wait SHALL stay for the next read. Inbox reads of one launch SHALL run one at a time, so each notice is handed out once. A notice SHALL be removed from the launch only when its answer goes to a caller whose connection is still open. When the caller is gone after the first wait, the read SHALL remove nothing. When the caller is gone after the removal's wait, the read SHALL put the removed notices back at the front of the launch's notices, ahead of any queued meanwhile. Either way the next read SHALL hand them out.

#### Scenario: Notice queued during the wait
- **WHEN** a second nudge is queued while an inbox read waits for durability
- **THEN** that read answers with the first nudge only, and the next read answers with the second

#### Scenario: Concurrent reads
- **WHEN** two inbox reads of one launch run at once while one notice is held
- **THEN** the notice is handed out by exactly one of them

#### Scenario: Read abandoned during a stall
- **WHEN** a nudge is durable, the sink stalls, the agent's inbox read waits, and the agent gives up and closes the connection before the sink recovers
- **THEN** once the sink recovers the nudge is still held by the launch, and the next read answers with it

#### Scenario: Caller gone while the removal waits
- **WHEN** two nudges are taken, the sink stalls on the batch that removes them, a third nudge is queued, and the caller goes away before the removal is durable
- **THEN** the read removes nothing for good, and the next read answers with the three nudges in order
