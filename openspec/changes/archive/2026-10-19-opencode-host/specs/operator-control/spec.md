## MODIFIED Requirements

### Requirement: Session attachments
The daemon SHALL expose `POST /v1/attachments` with `{ id, pids }`, where `pids` is the registering process's own pid followed by its ancestor pids up to six levels, recording the attachment durably and appending `attachment.started` on first sight (registering a live attachment again SHALL refresh its chain); `POST /v1/attachments/:id/end` with `{ reason }`, recording the end; and `POST /v1/attachments/ended` with `{ pids, reason }`, recording the end of every live attachment whose chain contains any pid in `pids`. An operator request MAY carry the header `x-orch-attachment` naming the caller's attachment; when that id is not a live attachment the daemon SHALL still perform the operation and SHALL add the response header `x-orch-attachment: unknown`. A claim MAY carry `attachment`, stored on the launch's worker record. At every reconcile the daemon SHALL end any attachment whose first pid is dead, SHALL release with `keep` and reason `sessionEnded` every live claimed launch whose worker carries an ended attachment, SHALL append `attachment.ended`, and SHALL remove the record. `status` SHALL report `attachments` as `[{ id, pids, since, launches }]` for live attachments. The end routes SHALL respond once the end is recorded, before any release.

#### Scenario: Dead attachment releases its launches
- **WHEN** a worker claimed T2 through an attachment whose first pid has since died
- **THEN** the next reconcile releases T2's launch with `keep`, T2 is `unstarted` with `attempts` unchanged, and the attachment is gone from `status`

#### Scenario: Session end by ancestry
- **WHEN** `POST /v1/attachments/ended` names a pid that is in an attachment's chain but is neither its own pid nor its parent, as the session process is above the launcher and `npx`
- **THEN** the response is immediate, the attachment is recorded as ended, and the next reconcile releases its launch with `keep`

#### Scenario: Unknown attachment flagged
- **WHEN** `status` is called with `x-orch-attachment` naming an attachment that has ended
- **THEN** the response is the current status and carries the header `x-orch-attachment: unknown`

#### Scenario: Attachment without launches
- **WHEN** an attachment that holds no launch ends
- **THEN** nothing is released and the attachment is removed

#### Scenario: OpenCode session end by stdio close
- **WHEN** an OpenCode session ends whose operator server holds an attachment with a claimed launch; OpenCode has no session end event, so no hook posts to `POST /v1/attachments/ended`
- **THEN** OpenCode closes the server's stdio, the server posts the end of its own attachment with reason `sessionEnded`, and the next reconcile releases the launch with `keep` and `attempts` unchanged; were the server killed instead, its dead first pid ends the attachment at the next reconcile

#### Scenario: Codex session end by ancestry
- **WHEN** a Codex SessionEnd hook posts `{ pids, reason: "other" }`, where its second pid is the codex process and an attachment's chain is the operator server, its launcher, and that codex process
- **THEN** the attachment is recorded as ended with reason `other`, and the next reconcile releases its launch with `keep` and `attempts` unchanged
