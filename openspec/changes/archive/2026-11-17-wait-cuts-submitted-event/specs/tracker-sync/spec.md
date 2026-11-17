## MODIFIED Requirements

### Requirement: Comment effects
The daemon SHALL derive a `comment` when: a task enters `waiting`, or enters `blocked` with a question delivered through the fallback file, with the question verbatim and its options; a task becomes `blocked` for any other reason, with the reason kind and message, the missing slots for `insufficientSpec`, and `whatWouldUnblock` when the last fail report carries one; a gated milestone becomes `submitted`, with a short notice: a first line naming the milestone, `ready for review`, `version <n> at <sha>` and the tag `milestone/<id>/v<n>`, then how to get the review (the `review` tool with the milestone id, or `orchestrator-ctl review <id>`), and no diff stat and no task lines; a milestone is accepted, with the sha and version; and a milestone is rejected, with the note. A `waiting` to `blocked` transition that preserves the same question SHALL NOT derive a second comment. A done task SHALL derive a comment only when `tracker.commentOnDone` is true (default false) or `doneAt` is `milestoneAccepted`; a `failed` transition SHALL derive a comment with the failure reason only when `tracker.commentOnFail` is true (default false). The effect key and marker of the submitted comment are unchanged, so an effect derived before the notice and still pending keeps its long body.

#### Scenario: Question is mirrored
- **WHEN** A blocks with the question "Use REST or GraphQL?" and options REST and GraphQL
- **THEN** a comment for A is derived whose body contains the question and both options

#### Scenario: Timed-out question is not repeated
- **WHEN** A's question passes `maxWait` and A becomes `blocked` with the same question
- **THEN** no new comment is derived for A

#### Scenario: Exhaustion is mirrored
- **WHEN** A fails its last attempt with `whatWouldUnblock` "need staging credentials"
- **THEN** a comment for A is derived naming the exhaustion and "need staging credentials"

#### Scenario: Submitted milestone is mirrored
- **WHEN** E becomes `submitted` at version 1
- **THEN** a comment for E is derived with the pinned sha, `milestone/E/v1`, the `review` tool and `orchestrator-ctl review E`, and with no diff stat, no line starting with `- ` and no closure task's summary

#### Scenario: Optional comments are off by default
- **WHEN** A fails once and is retried, then is published, with the default policy
- **THEN** no comment is derived for either event
