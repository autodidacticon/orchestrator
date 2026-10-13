## Why

Import is one-way. After `import_issues` the tracker never learns that tasks ran, finished, failed, or asked questions. Teammates who are not at the terminal see nothing, and a question waits for whoever happens to be attached to the session. Conversation 9 (2026-10-12, `plans/2-tracker-sync/plan.md`) settled how to close the loop without giving the daemon tracker access: the daemon derives tracker-bound effects from its own transitions into a durable outbox, and the session drains it with the tracker tools it already has.

## What Changes

- Add a durable `outbox` table to the store. Every transition that should be visible in the tracker inserts an effect in the same transaction, keyed by the event sequence that produced it, so nothing is lost or duplicated at the source. The daemon never talks to a tracker.
- Define two vendor-agnostic effect kinds, `setState` and `comment`, each naming its issue by node id and url, with a marker footer on every comment that identifies the run and the source event.
- Mirror states: a task's first launch sets its issue in progress, publication sets it done, cancellation sets it cancelled, and the parent issue follows its first starting child and its milestone's acceptance. Mirror comments where a human is needed: questions, blocks with their reasons, milestone submission with the review summary, acceptance, and rejection. Completion and failure comments are optional and off.
- Make done semantics configurable: at integration (default) or at milestone acceptance.
- Add daemon routes `outbox`, `ack`, and `nack`, operator MCP tools `outbox` and `ack`, CLI commands of the same names, and `tracker`, `outboxPending`, and `trackerErrors` in status and the digest.
- Record the tracker at import: `import_issues` takes `tracker: { kind, workspace? }`; effects are produced only when a tracker is recorded and only for nodes that carry a tracker identity.
- Extend the run skill with a drain step after every `wait` and a relay step that turns the first human comment under a question into the answer; extend the import skill to record the tracker kind.

## Capabilities

### New Capabilities
- `tracker-sync`: the outbox model, the effect kinds and marker, the derivation rules and policy, done semantics, and the drainer contract.

### Modified Capabilities
- `operator-control`: new requirement for the outbox routes and the tracker facts in status and the digest.
- `operator-mcp`: new requirement for the `outbox` and `ack` tools.
- `graph-import`: new requirement for the tracker record taken at import.
- `host-integration`: new requirements for the run skill's drain and relay steps and for the import skill's tracker record.
- `crash-recovery`: new requirement bracketing a tracker write between the outbox row and its acknowledgement.

## Impact

- New source: `src/tracker/` (policy, derivation, comment bodies). Changed: `src/state/{store,sqlite}.ts` (outbox table), `src/loop/{orchestrator,tick}.ts` (derivation hook and transition context), `src/operator/{routes,mcp-server,cli}.ts`, `src/import/mapping.ts`, `src/config.ts` (`tracker` block), `src/main.ts` (run id).
- Skills: `hosts/claude-code/skills/{import,run}/SKILL.md`. No tracker SDK is added; the session's Linear or Atlassian MCP tools do every tracker write.
- Existing runs open unchanged: the table is created on open, no tracker is recorded, and no effects are produced until an import names one.
- Tests use an in-memory fake tracker; no real Linear or Jira.
- A headless drainer (the daemon as an MCP client with stored OAuth) can be added later behind the same outbox and routes.
