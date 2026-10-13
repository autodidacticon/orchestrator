## Context

`add-session-operator` made the session the operator: it imports an epic with its own Linear or Atlassian tools and drives the daemon through the operator MCP server. The tracker still hears from the run only at import. Conversation 9 (2026-10-12) decided how the run reports back. Constraints: tracker access stays in the session, a rule set at import, so the daemon must not hold tracker credentials; the daemon is the sole writer and every external effect sits between two durable records; a session can crash at any time, so whatever it does to a tracker must be safe to repeat; and `wait` returns within ninety seconds, which gives the session a natural cadence for tracker work.

## Goals / Non-Goals

**Goals:**
- Let people who are not at the terminal see from the tracker what ran, finished, failed, or needs them.
- Let a teammate answer an agent's question by replying under the issue.
- Lose and duplicate nothing: every effect is derived once, durably, and applied idempotently.
- Keep vendor knowledge in the skill, vendor-agnostic effects in the daemon, and no tracker SDK in the project.

**Non-Goals:**
- A headless drainer; the daemon as an MCP client of vendor servers with stored OAuth.
- Reading tracker state into the run beyond re-import; external nodes still flip by re-import.
- Mirroring every lifecycle event; a tracker thread that logs every tick is noise.

## Decisions

**A durable outbox drained by the session, not a daemon-side tracker client and not a skill-only loop.** The daemon derives effects from its own transitions and stores them; a drainer applies and acknowledges them. The first drainer is the run skill using the session's tracker tools, so there is no new auth. Rejected: the daemon as a headless MCP client of the vendor servers, which puts OAuth tokens on disk, duplicates access the session already has, and breaks the rule set at import; and doing everything in the skill without an outbox, which loses effects when the session crashes and leaves no audit trail. A headless drainer can be added later behind the same outbox.

**Derivation happens in the transition's transaction and is keyed by `(sourceSeq, taskId, kind)`.** `Orchestrator.transition` already appends the `transition` event inside a store transaction; derivation runs there with the event's sequence as `sourceSeq`. The key includes the issue because one transition can produce effects for two issues, the task and its parent milestone. Context that derivation needs but cannot compute synchronously, the published sha and the milestone diff stat, is gathered by the tick before the transition and passed in. Rejected: deriving from the event log in a later pass, which needs its own cursor and can lag or double-apply after a crash.

**Effects are vendor-agnostic; the skill maps by state type.** `setState` carries `inProgress`, `done`, or `cancelled`; the skill picks the workspace state of that type (Linear `started`, `completed`, `canceled`; Jira status category In Progress, Done, and a canceled-type status when one exists) and comments instead when no canceled type exists. Mapping by name would break on every renamed workflow.

**A `setState` is derived only when it differs from the last one recorded for the issue.** This one rule yields "first launch only", keeps retries and conflict relaunches silent, makes the parent follow its first starting child, and sets a reopened task back to in progress on relaunch, without a flag per case.

**Mirroring scope is states plus comments where a human is needed.** Questions, blocks with reasons, milestone submission with the review summary, acceptance, and rejection. A question that times out into `blocked` is not repeated. Completion and failure comments sit behind `tracker.commentOnDone` and `tracker.commentOnFail`, both off. Rejected: a comment per lifecycle event (noisy) and comments only (humans move issues by hand).

**Done means integrated, by default.** `tracker.doneAt: integration` flips a task's issue when its work is published, and the parent only when its gated milestone is accepted. `milestoneAccepted` comments "integrated as sha" at publication and flips the task's issue with the milestone; tasks under no gated milestone flip at integration either way.

**Answers are polled from comments and relayed; the first answer wins.** The skill polls only tasks in `openQuestions`, which a task leaves as soon as an answer is persisted; it ignores marked comments and relays the first human comment after the latest marked one. The daemon's `answer` route already refuses with 409 and a reason naming the task's current status when the task is no longer `waiting` or `blocked`, so a late relay is reported, not applied. Rejected: a tracker webhook into the daemon, which needs an inbound channel the daemon does not have.

**The tracker is recorded at import and enablement is automatic.** `import_issues` takes `tracker: { kind, workspace? }`, stored under kv `tracker`. `tracker.enabled: auto` derives effects only when a tracker is recorded and only for nodes carrying `url` or `trackerState`, so file-based runs stay silent; `always` and `never` override. The literals avoid `on` and `off`, which YAML 1.1 readers turn into booleans.

**The marker is a visible footer, not hidden metadata.** `— orchestrator run <runId> · event <sourceSeq>` on every comment lets the skill skip its own comments when reading and recognise one posted before a crash. Hidden markup differs per vendor; a visible line does not.

**Routes, tools, and status facts are added requirements, not modified ones.** Four other pending changes extend "Status report" and "Tool set"; a MODIFIED block replaces the whole requirement at sync and the last one synced would win. No existing requirement changes meaning here, so nothing is modified. The tool count in "Tool set" is left for a sweep once the pending changes land.

**Rejections are retried in order, per issue.** A nack keeps the effect pending with `attempts` increased until `tracker.maxAttempts`, then marks it `failed` and surfaces it in `trackerErrors`. The drainer applies an issue's effects in id order and leaves later ones after a rejection, so a later state is never set before an earlier one.

## Risks / Trade-offs

- [No session attached for hours] → effects queue; nothing is lost; `outboxPending` shows the backlog; a later headless drainer empties it without a schema change.
- [A human moves an issue by hand] → the daemon never reads tracker state and never fights it; a derived state is written only on a real transition; re-import is how tracker changes enter the run.
- [A comment under a question was not meant as an answer] → only comments after the latest marked comment are relayed, the skill reports what it relayed, and the relaunch brief shows the answer; a wrong answer is corrected like any other, by cancel or unblock.
- [A workspace workflow lacks a state type] → the skill comments instead of guessing; a vendor error is nacked with its text, retried, then surfaced.
- [The transition transaction grows: derivation reads the outbox and the report tables] → a few indexed reads per transition; the crash suite keeps the convergence check.
- [Two sessions drain at once] → ack is idempotent and the marker check runs before every post; the worst case is a wasted read.

## Migration Plan

The `outbox` table is created on open with `CREATE TABLE IF NOT EXISTS`. Existing runs have no tracker recorded and produce no effects until an import names one. The `tracker` config block has defaults for every key. The `import_issues` `tracker` argument is optional; the import skill always sends it.

## Open Questions

- The headless drainer: the daemon as an MCP client of the vendor servers with stored OAuth, behind the same outbox and routes.
- Whether to acknowledge a relayed comment answer with a short marked reply in the tracker thread.
- A `retry` operation for `failed` effects, or manual `ack` after a human fixed the issue by hand.
- The "Tool set" count scenario once the pending changes have landed.
