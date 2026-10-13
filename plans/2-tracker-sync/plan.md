# Mirror a run to its tracker: plan for change `add-tracker-sync`

## Context

`add-session-operator` (`plans/1-session-operator/plan.md`) put the operator in a Claude Code
session: the session imports an epic with its own Linear or Atlassian tools and drives the
daemon through the operator MCP server. The tracker hears from the run exactly once, at
import. After that, tasks run, finish, fail, and ask questions, and the issues never change.
Teammates not at the terminal see nothing; a question waits for whoever is attached.
Conversation 9 on 2026-10-12 settled the design. This document records the decisions and
their reasoning; the OpenSpec change `add-tracker-sync` holds the requirements, design
record, and task checklist.

Two rules from the previous change constrain this one. Tracker access stays in the session,
so the daemon must not hold tracker credentials. Every external effect sits between two
durable records, so a tracker write must be recorded before it happens and after.

## Decisions

1. **A durable outbox, drained by the session.** The daemon derives tracker-bound effects
   from its own transitions and stores them in a new `outbox` table, in the same transaction
   as the transition, keyed by the event sequence, the issue, and the kind. It never talks to
   a tracker. The run skill drains the outbox with the session's tracker tools, so there is
   no new auth. Rejected: the daemon as a headless MCP client of the vendor servers (OAuth on
   disk, duplicates the session's access, breaks the import-time rule), and a skill-only loop
   with no outbox (lost on a session crash, no audit). A headless drainer fits behind the
   same outbox later.
2. **Two vendor-agnostic effects.** `setState` with `inProgress`, `done`, or `cancelled`, and
   `comment` with a body and a marker. Each names its issue by node id and url. The skill maps
   states by type (Linear `started`, `completed`, `canceled`; Jira categories In Progress and
   Done, plus a canceled-type status when one exists, else a comment). The marker
   `— orchestrator run <runId> · event <sourceSeq>` is a visible footer: it lets the skill
   skip its own comments when reading and recognise a comment posted before a crash.
3. **States, plus comments where a human is needed.** First launch sets the issue in
   progress, publication sets it done, cancellation sets it cancelled; the parent follows its
   first starting child and its milestone's acceptance. Comments for questions, blocks with
   reasons, milestone submission with the review summary, acceptance, and rejection.
   Completion and failure comments are off by default. A `setState` is derived only when it
   differs from the last one recorded for the issue, which gives "first launch only", silent
   retries, and a reopened task going back to in progress with one rule. Rejected: a comment
   per lifecycle event, and comments only.
4. **Done at integration.** `tracker.doneAt: integration` by default; the parent flips only
   when its gated milestone is accepted. `milestoneAccepted` comments "integrated as sha" at
   publication and flips task issues with the milestone; tasks under no gated milestone flip
   at integration either way.
5. **Answers come back through comments.** On each `wait` cycle the skill reads the comments
   of every issue in `openQuestions`, ignores marked ones, and relays the first human comment
   after the latest marked one through `answer`. First answer wins: a task leaves
   `openQuestions` once an answer is persisted, and the `answer` route refuses with 409 and
   the current status once the task has moved on. `tracker.answersFromComments` turns it off.
6. **The tracker is recorded at import; enablement is automatic.** `import_issues` takes
   `tracker: { kind, workspace? }`, kept under kv `tracker`. Effects are derived only when a
   tracker is recorded and only for nodes carrying `url` or `trackerState`; file-based runs
   produce none. `tracker.enabled` can force `always` or `never`.
7. **Routes and tools.** `GET /v1/outbox`, `POST /v1/outbox/:id/ack`, and
   `POST /v1/outbox/:id/nack`; MCP tools `outbox` and `ack` (result or error); CLI commands of
   the same names. A nack keeps the effect pending up to `tracker.maxAttempts` (3), then marks
   it `failed` and lists it in `trackerErrors`. Status and the digest gain `outboxPending` and
   `trackerErrors`. All of it lands as added requirements because four pending changes also
   extend "Status report" and "Tool set".
8. **Crash safety.** The outbox row is the record of intent, the tracker write the external
   effect, the ack the record of outcome. A daemon crash loses nothing because derivation is
   transactional; a session crash between post and ack is covered by the marker check and by
   the idempotence of setting a state.

## Implementation

Six task groups in `openspec/changes/add-tracker-sync/tasks.md`:

1. Config and outbox store (`tracker` config block, `outbox` table and store methods, kv
   `tracker` and `runId`).
2. Effect derivation (`src/tracker/`: policy, state and comment rules, `doneAt`; the hook in
   `Orchestrator.transition`; context gathered by the tick before the milestone and
   publication transitions).
3. Routes, status, and CLI (`outbox`, `ack`, `nack`; `tracker` on `PUT /v1/graph`; status and
   digest facts; CLI commands).
4. Operator MCP tools and import (`outbox` and `ack` tools, `tracker` on `import_issues`).
5. Slice through a fake tracker and crash coverage (an in-memory tracker and a drainer that
   does what the skill does; state and comment sequences for the tracked fixture; drainer
   crash, retry cap, `doneAt` both ways, comment relay; an outbox invariant in the crash
   suite).
6. Skills and documentation (import skill records the tracker; run skill drains and relays;
   README).

Gate: group 2's derivation tests plus group 5's slice. Groups 1 and 2 build against the loop
harness alone; group 5 needs groups 3 and 4.

## Verification

- `npm test` green, including the v1 and session-operator suites; the crash matrix passes
  with the outbox invariant added.
- Derivation unit tests cover every transition in the table under both `doneAt` modes,
  `parentInProgress` on and off, and the optional comments off and on.
- The slice drains the outbox like the skill would against the fake tracker and checks the
  per-issue state and comment sequence through question, answer, block, milestone submit and
  accept; a run without a tracker leaves the outbox empty.
- `claude plugin validate --strict hosts/claude-code` passes.
- Opt-in, by hand: a sandbox Linear epic imported and run from a Claude Code session, with
  the issues moving and a question answered from a Linear comment. No real tracker in
  `npm test`.

## Deferred

- A headless drainer: the daemon as an MCP client of the vendor servers with stored OAuth,
  behind the same outbox and routes, for runs with no session attached.
- A `retry` operation for `failed` effects, and manual `ack` after a human fixed an issue.
- Acknowledging a relayed comment answer in the tracker thread.
- The "Tool set" count scenario, to be swept once the pending changes have landed.
- Health monitoring (7), graph mutation (8), the pull-based runner, and scheduling (5).
