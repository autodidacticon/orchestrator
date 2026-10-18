---
name: orchestrator-run
description: Start the orchestrator for this repository from a Codex session and monitor the run, surfacing agent questions, milestone reviews, completion and stalls. Use when the user wants to run, resume, or watch an orchestrated run.
---

# Run and monitor (Codex host)

The daemon does the work. You are its operator: you keep it running, relay questions to the
user, and hand milestones to the `orchestrator-review` skill. Keep the conversation small:
report digests, never raw event lists. Every tool named here belongs to the orchestrator's
operator MCP server (`mcp__orchestrator_operator__<tool>`); see hosts/codex/README.md for its
registration.

In `codex exec`, the operator tools run only when their approvals are granted in advance
(`approval_policy = "never"` with `default_tools_approval_mode = "approve"` and each tool's
`approval_mode = "approve"` on `mcp_servers.orchestrator_operator`); without them every call
is refused. An interactive
Codex session asks the user to approve each tool instead. If a call comes back refused for
approval, tell the user which of the two applies and stop.

## 1. Start

This session has no subagents to work launches, so the daemon spawns the agents headless and
you only monitor; `spawn` is the Codex host's default until a Codex work loop exists. An
explicit `mode` overrides `runner.mode` in `orchestrator.yaml` and is applied to a daemon
that is already running, so choose it before calling `start`:

- Call `status` first. When it reports no running daemon, call `start` with `mode: "spawn"`,
  unless the repository's `orchestrator.yaml` sets `runner.mode`; then call `start` without
  `mode` and respect the file.
- When a daemon is running, call `start` without `mode`, which leaves its mode alone. If the
  mode is `pull` or `mixed` and `status.attachments` shows another session holding launches,
  that session is working the run: leave the mode as it is and only monitor.

`start` returns the run directory, graph path,
URL, the runner `mode` in force, and the resolved configuration: `config` (every key as
`{ value, source }`, the source being `argument`, `file`, `pinned`, `detected`, `default`, or
`unresolved`), `toolchain` (what detection found in the repository root), `needsConfig` (keys
no layer supplied), and `modeNote`. It is safe to repeat.

When the mode in force is `pull` (or `mixed`, whose claim window nobody here fills), launches
are parked for session workers that this host does not have, and nothing progresses until
the claim window ends or a Claude Code session works them. Say so, show `modeNote` when it is
set, and offer `start` with `mode: "spawn"` unless another session is working the run.

The runner kind (`config.runnerKind`, from `runner.kind` in `orchestrator.yaml`, `start` or
`configure` with `runnerKind`, or `--set runnerKind=codex`) is `claude-code` by default or
`codex`. Both kinds run headless under `spawn`. A task can also choose its kind (`runner` in
its payload, or a `runner:<kind>` label), so one run can hold both kinds;
`status.claimableByKind` counts parked launches per kind.

Tell the user who is executing the work (the daemon's headless agents), and report the
toolchain in one line: the check command, the integration branch, and the worker kind,
model and effort (`config.runnerKind`, `config.model`, `config.effort`, each default being
that kind's default model at `medium`, `gpt-6-astra` for `codex`) with the source of each.
For a `codex` run name the sandbox and the commit policy (`config.codex.sandbox`,
`config.codex.commit`) and omit the allow-list part, since Codex runs under its sandbox
instead of an allow list, for example
"detected: npm test on main; workers codex gpt-6-astra at medium (file); sandbox workspace-write, daemon commits".
For a `claude-code` run name the kind and add the toolchains whose commands the spawned
agents may run, for example "detected: npm test on main; workers claude-code
<config.model.value> at medium (default); agents may run npm and node". When `config.model.applied`
is false (a `runnerCommand` without the `{model}` slot), omit the model part. A task can
choose its own model or effort: `model` and `effort` in its payload, or `model:<name>` and
`effort:<level>` labels on its issue; `status.liveLaunches` shows what each launch runs with
(its `runner`, `model`, and `effort`). If `needsConfig` is not empty, resolve it now (section
1b). Then call `status`. If no graph is loaded, say so and suggest the `orchestrator-import`
skill.

The configuration keys for the runner kinds, in `orchestrator.yaml`: `runner.kind`
(`claude-code` or `codex`); `runner.claude.*` (`model`, `effort`, `commit`, `allowedTools`,
`deriveTools`); `runner.codex.*` (`model`, `effort` up to `ultra`, `sandbox`: `read-only`,
`workspace-write` (the default), or `danger-full-access`, and `commit`: `daemon` by default,
`agent` under `danger-full-access`); and `budgets.prices`, the per-model token prices
(`{ <model>: { inputPerMTok, outputPerMTok, cachedInputPerMTok? } }`, USD per million tokens)
that turn Codex token counts into cost. A Codex launch without a price for its model counts
in `cost.unpricedLaunches` and its cost stays unknown, so `budgets.maxRunCostUsd` cannot stop
it; mention this when a codex run has a cost budget and no price.

## 1b. Resolve what detection could not

When `needsConfig` names `checkCommand`, in the `start` result or in a later `wait` digest,
submitted work is held under `verifying` until a check command is set: no attempt is spent
and the sealed work is kept, but nothing is published. Never leave it unresolved while a task
is `submitted` without having asked the user. Look for the test command in `AGENTS.md` (or `CLAUDE.md` when there is no `AGENTS.md`),
the README, and the manifests in the repository root (`package.json` scripts, `Makefile`
targets, and their counterparts). When one is stated unambiguously, call `configure` with
`checkCommand` and tell the user the command and where you found it ("set checkCommand to
`make check` from AGENTS.md"). Otherwise propose your best reading, or say you found none,
and call `configure` only with what the user confirms. `configure` also takes `capacity`,
`allowedTools` (rules appended to the derived list for spawned Claude Code agents, such as
`Bash(docker:*)`), `runnerCommand`, `runnerKind` (`claude-code` or `codex`), `model` and
`effort` (the worker defaults of the kind in force, or of `runnerKind` in the same call, for
launches prepared from then on; effort is `low`, `medium`, `high`, `xhigh`, or `max`, and
`ultra` is codex-only), `codex` (`{ model, effort }` for codex whichever kind is in force),
`sandbox` (the codex sandbox), and `commit` (`agent` or `daemon`, the commit policy of the
kind in force); a null clears an override so the value falls back to the file, detection, or
the default. The integration branch is start-only: pass `integrationBranch` to `start` before
the run holds any launch; a running daemon refuses it.

## 2. Monitor loop

Loop on `wait` with `afterSeq` set to the `seq` returned by the previous call (omit it the
first time). Use `until` to wait for what matters: `question` when there is nothing else to
do, otherwise `any`. Each call returns within the cap its description states (ninety
seconds, or less when the server was registered with `ORCH_WAIT_CAP_MS`), which is below the
server's `tool_timeout_sec`; call it again until the run ends. After each return: first drain
the tracker outbox (section 2a), then relay comment answers (section 2b), then act on the
digest:

- **openQuestions** non-empty: for each task, call `status` or `logs` only if you need
  context, then present the question to the user verbatim and wait for their reply. Send the
  reply with `answer`. Do not invent answers to questions that need a human decision. When the
  question's kind is `needsAccess` and it names a command (from `status`, under the task's
  blocked or waiting reason), offer what applies to the asking launch's runner (its `runner`
  in `status.liveLaunches`): for a `codex` launch, changing the sandbox for later launches
  (`configure` with `sandbox`, for example `danger-full-access`); for a `claude-code` launch,
  adding a rule through `configure` (`allowedTools: ["Bash(<command>:*)"]`). Either way say
  that the live agent cannot gain it. Also offer running the command yourself on the agent's
  behalf in its worktree and sending the result with `answer`, which is what unblocks the live
  agent now, or answering with an alternative. Do what the user picks.
- **needsConfig** names `checkCommand`: submitted tasks are held under `verifying` until a
  check command is set. Follow section 1b now; do not call the run slow or stalled.
- **awaitingReview** non-empty: use the `orchestrator-review` skill for each milestone.
- **finished** true: report the final state (done tasks, milestones) and stop.
- **stalled** true: report `stallRoots` with their reasons. Offer the options that apply:
  `unblock` with an answer, `cancel` with release, `reopen`, or fixing the graph and
  re-importing. Wait for the user.
- **blocked** tasks whose reason is `insufficientSpec`: tell the user which acceptance
  criteria are missing and offer to add them in the tracker and re-import.
- **stuck** non-empty: call `status` and show each stuck task with its `idleMs` and
  `lastSignal` from `liveLaunches`. Offer the user three choices: a nudge with a message
  (send it with `nudge`; the agent sees it on its next inbox call), cancellation (`cancel`),
  or waiting. The daemon fails a launch that stays stuck past `budgets.stuckFailAfterMs`
  and retries it like any other failure; say so.
- **proposals** non-empty: agents proposed follow-up tasks. For each pending proposal (from
  `proposals`), show its title, description, acceptance criteria, and deps, and wait for the
  user's decision. On acceptance in a run imported from a tracker, first create the issue
  with this session's tracker tools: a child of the epic, blocked by the proposing task's
  issue, with the acceptance criteria under the configured heading in its description; then
  call `accept_proposal` with the new issue's key as `nodeId`. GitHub: `gh issue create
  --repo <owner/repo> --parent <root url> --title ... --body-file -` creates the sub-issue;
  add the dependency with the GraphQL mutation `addBlockedBy(input: { issueId, blockingIssueId })`
  (node ids from `gh api graphql`); the `nodeId` is `GH-<new number>`. In a file-based run call
  `accept_proposal` without `nodeId` and report the new node id. On rejection call
  `reject_proposal` with the user's note. Never accept a proposal the user has not approved.
- **pausedReason** is `costBudget`: the run cost reached its ceiling. Report `cost.runUsd`
  and `cost.ceilingUsd` from `status`, then offer `resume` with `overrideBudget: true`
  (raises the ceiling by one budget) or stopping. Never override the budget unless the user
  says so.
- **deferred** non-zero: ready tasks are held back because their declared scope overlaps a
  task that is running, waiting, submitted, or claimable. Read `deferred` from `status` and
  name each held task with the ids in its `with` list in the progress report ("T3 waits for
  T2's files"); do not call the run slow or stalled. Nothing to do: they launch on the first
  tick after the blocker's work is published.

Between actions, give the user a one-line progress note: running, waiting, done counts, and
the deferred tasks with their blockers when there are any.

### 2a. Drain the tracker outbox

Call `outbox`. If `policy.enabled` is false or `effects` is empty, skip this section. Each
effect names its `issue` (the tracker key), an optional `url`, and is either
`setState { state }` or `comment { body, marker }`. Apply them in `id` order with the
tracker tools in this session, acknowledging each one before the next:

- `setState`: map `state` by state TYPE, never by name. Linear: the team's workflow state of
  type `started` for `inProgress`, `completed` for `done`, `canceled` for `cancelled`. Jira:
  transition to a status in category In Progress or Done; for `cancelled`, a canceled-type
  status when the workflow has one. When the tracker has no canceled-type state, leave the
  status, post a comment saying the task was cancelled, and acknowledge. GitHub (act on the
  effect's `url` with `gh`, never on the `GH-` id):
  `done`: `gh issue close <url> --reason completed`;
  `cancelled`: `gh issue close <url> --reason "not planned"`;
  both followed by `gh issue edit <url> --remove-label <policy.tracker.inProgressLabel>` when
  the policy has a label (a no-op when the issue does not carry it);
  `inProgress`: `gh issue reopen <url>` when the issue is closed, then
  `gh issue edit <url> --add-label <policy.tracker.inProgressLabel>`; when the policy has no
  `inProgressLabel`, call `ack { id, result: { skipped: true } }` and change nothing.
  A milestone root (`GH-M<n>`, the effect's `url` is a milestone): `done` closes the milestone
  with `gh api`; acknowledge `inProgress` as skipped. On success call
  `ack { id, result: { stateId } }` (for GitHub, `{ state }`).
- `comment`: list the issue's recent comments first (GitHub: `gh issue view <url> --comments`
  or the GraphQL `comments` connection). If one already contains the effect's `marker`, call
  `ack { id, result: { commentId } }` with that comment's id and do not post again (a previous
  session posted it and crashed before acknowledging). Otherwise post `body`, a blank line,
  and the `marker` as the last line (GitHub: `gh issue comment <url> --body-file -`), then
  `ack { id, result: { commentId } }`. A GitHub milestone root takes no comments: acknowledge
  the effect as skipped.
- On a tracker error: `ack { id, error: "<message>" }`, then skip the remaining effects for
  that issue in this drain; they come back next time. The daemon retries a rejected effect
  up to its cap and then lists it in `trackerErrors`; when the digest shows `trackerErrors`,
  tell the user once which effects failed and why, and carry on.

Report one line: "tracker: applied N, rejected M". Never paste effect payloads into the
conversation.

### 2b. Relay answers from the tracker

When `policy.answersFromComments` is true and the digest lists `openQuestions`: for each
task, list its issue's comments (GitHub: `gh issue view <url> --comments`); ignore any
containing "— orchestrator run"; take the first human comment posted after the latest marked
comment that you have not relayed before; send it with `answer`; remember that comment's id so
you never relay it twice. If the daemon answers 409, the task is no longer waiting or blocked
(someone answered first): tell the user and do not retry. Answers typed in this session still
work; the first answer wins.

## 2c. Reopening a task

When the user asks to reopen a done or cancelled task, call `reopen` without `cascade`. If it
succeeds, report `reset`: the task and any milestones that were reset and will be reviewed
again at their next version. If it is refused with `blockers`, those started tasks depend on
it. Tell the user each blocker would be reset (killed if running, dropped if under
verification, reopened if done) and relaunched with a revision brief, and that the
integration branch is never rewritten. Only after the user agrees call `reopen` with
`cascade: true` and show the returned plan. If the refusal names a `publishing` task, wait a
moment and retry.

## 3. Pausing and stopping

`pause` stops new launches while running work finishes; `resume` lifts it. `stop` shuts the
daemon down gracefully: agents keep running and are adopted on the next `start`. Only pass
`reap: true` when the user explicitly wants agents killed.

## 4. When the session ends

The run's state is durable. The spawned agents keep working without this session. The daemon
exits on its own after `daemon.idleExitMs` (ten minutes by default) with no session attached
and nothing live, records why in the run directory, and comes back on the next tool call;
`runs` shows every run with its daemon's state or last exit. Tell the user they can come back
and use the `orchestrator-run` skill again; nothing is lost. Questions that nobody answers
degrade to blocked after the configured wait and can be answered later with `answer`.
