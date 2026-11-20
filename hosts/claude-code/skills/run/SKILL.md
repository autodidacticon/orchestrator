---
name: run
description: Start the orchestrator for this repository and monitor the run, surfacing agent questions, milestone reviews, completion and stalls. Use when the user wants to run, resume, or watch an orchestrated run.
---

# Run and monitor

The daemon does the work. You are its operator: you keep it running, relay questions to the
user, and hand milestones to the review skill. Keep the conversation small: report digests,
never raw event lists.

## 1. Start

Call `start`. It returns the run directory, graph path, URL, the runner `mode` in force, and
the resolved configuration: `config` (every key as `{ value, source }`, the source being
`argument`, `file`, `pinned`, `detected`, `default`, or `unresolved`), `toolchain` (what
detection found in the repository root), and `needsConfig` (keys no layer supplied). It is safe
to repeat. A run started from this plugin defaults to `pull`: the daemon prepares each launch
and this session's own subagents do the work (section 1a), so the user sees every agent here.
`spawn` (the daemon runs headless agents, for unattended runs) and `mixed` are explicit
choices: `start` with `mode`, or `runner.mode` in `orchestrator.yaml`, which wins.

The runner kind (`config.runnerKind`, from `runner.kind` in `orchestrator.yaml`, `start` or
`configure` with `runnerKind`, or `--set runnerKind=codex`) is `claude-code` by default,
`codex`, or `opencode`. Codex launches are worked only in `spawn` or `mixed` mode, because pull-mode workers
are this session's Claude subagents and claim only `claude-code` launches; so are OpenCode
launches (pull-mode workers for those kinds come from `orchestrator-work --runner <kind>`). So a `start` without `mode` whose runner kind is `codex`
or `opencode` (the `runnerKind` argument, or already in force for the run) starts the daemon in
`spawn` instead of `pull`, and the result's `modeNote` says so; tell the user the daemon runs
the Codex or OpenCode agents headless and you only monitor. When `modeNote` warns that a codex
or opencode run is in `pull` mode, offer `start` with `mode: "spawn"` or `"mixed"`. A task can
also choose its kind (`runner` in its payload, or a `runner:<kind>` label), so one run can hold
several kinds; `status.claimableByKind` counts parked launches per kind.

Tell the user who is executing the work, and report the toolchain in one line: the check
command, the integration branch, and the worker kind, model and effort (`config.runnerKind`,
`config.model` and `config.effort`; the defaults are `claude-opus-5-5` at `medium` for
`claude-code`, `gpt-6-astra` at `medium` for `codex`, and `anthropic/claude-opus-5-5` at
`medium` for `opencode`) with the source of each and, when the
daemon spawns Claude Code agents (`spawn`, or `mixed` after the claim window), the toolchains
whose commands agents may run, for example
"detected: npm test on main; workers claude-opus-5-5 at medium (default); agents may run npm and node".
For a `claude-code` run you may leave the kind out of the line, as above. For a `codex` run name
the kind, the sandbox, and the commit policy (`config.codex.sandbox`, `config.codex.commit`) and
omit the allow-list part, since Codex runs under its sandbox instead of an allow list, for example
"detected: npm test on main; workers codex gpt-6-astra at medium (file); sandbox workspace-write, daemon commits".
For an `opencode` run name the kind, the permission, and the commit policy
(`config.opencode.permission`, `config.opencode.commit`) and omit the allow-list part, for example
"detected: npm test on main; workers opencode anthropic/claude-opus-5-5 at medium (default); permission derived, agent commits".
When this session's subagents work the launches (`pull`), omit the allow-list part: workers
run under this session's own permissions.
When `config.model.applied` is false (a `runnerCommand` without the `{model}` slot), omit the
model part. A task can choose its own model or effort: `model` and `effort` in its payload, or
`model:<name>` and `effort:<level>` labels on its issue; `status.liveLaunches` shows what each
launch runs with (its `runner`, `model`, and `effort`). If `needsConfig` is not empty, resolve
it now (section 1b). Then call `status`. If no graph is loaded, say so and suggest the
`import` skill.

**Worker profile.** The `start` result's `confirmProfile` says whether the profile hold is
on. While it is on, the daemon launches no task whose model or effort would come from a
built-in default, and no worker can claim it. Before a graph is loaded: when
`confirmProfile` is true and `config.model.source` or `config.effort.source` is `default`, ask
the user now which model and effort the workers run with, naming the value shown as one
option; in `spawn` mode skip a key whose `applied` is false. With a graph, read
`status.profiles`, and read it again after every import. Each entry says what a group of
tasks that have not started will run with (`runner`, `model`, `effort`), where each value
comes from (`modelSource`, `effortSource`: `task`, `argument`, `file`, or `default`), and how
many tasks it covers (`tasks`); tell the user every entry in one line. An entry with
`held: true` is not launched: ask the user for the keys in `missing`, naming the entry's
value as one option. Apply the answer with `configure`: `model` and `effort` for the kind in
force, or the `claude`, `codex`, or `opencode` object for another kind. Do this also when the
user accepts the value shown, so that its source becomes `argument`. Never choose the profile
from the model of this session, and never without the user's answer. A lasting choice is
`model` and `effort` under `runner.claude`, `runner.codex`, or `runner.opencode` in
`orchestrator.yaml`; `runner.confirmProfile: false` there turns the profile hold off.

The configuration keys for the runner kinds, in `orchestrator.yaml`: `runner.kind`
(`claude-code`, `codex`, or `opencode`); `runner.claude.*` (`model`, `effort`, `commit`, `allowedTools`,
`deriveTools`); `runner.codex.*` (`model`, `effort` up to `ultra`, `sandbox`: `read-only`,
`workspace-write` (the default), or `danger-full-access`, and `commit`: `daemon` by default,
`agent` under `danger-full-access`); `runner.opencode.*` (`model` as a `provider/model` id,
`effort` up to `max`, `commit`: `agent` by default, `permission`: `derived` (the default) or
`allow`, and `dataDir`: `shared` (the default) or `launch`); and `budgets.prices`, the per-model token prices
(`{ <model>: { inputPerMTok, outputPerMTok, cachedInputPerMTok? } }`, USD per million tokens) that turn Codex token
counts into cost. A Codex launch without a price for its model counts in
`cost.unpricedLaunches` and its cost stays unknown, so `budgets.maxRunCostUsd` cannot stop it;
mention this when a codex run has a cost budget and no price.

A launch that ended with no usage recorded counts in `cost.unmeteredLaunches` (the digest's
`unmeteredLaunches`). Its cost is unknown and outside `cost.runUsd`, so `budgets.maxRunCostUsd`
cannot stop it. When the run has a cost budget and the count is above 0, name the count whenever
you report the run cost.

## 1b. Resolve what detection could not

When `needsConfig` names `checkCommand`, in the `start` result or in a later `wait` digest,
submitted work is held under `verifying` until a check command is set: no attempt is spent and
the sealed work is kept, but nothing is published. Never leave it unresolved while a task is
`submitted` without having asked the user. Look for the test command in `CLAUDE.md`, the
README, and the manifests in the repository root (`package.json` scripts, `Makefile` targets,
and their counterparts). When one is stated unambiguously, call `configure` with `checkCommand`
and tell the user the command and where you found it ("set checkCommand to `make check` from
CLAUDE.md"). Otherwise propose your best reading, or say you found none, and call `configure`
only with what the user confirms. `configure` also takes `capacity`, `allowedTools` (rules
appended to the derived list for spawned Claude Code agents, such as `Bash(docker:*)`),
`runnerCommand`, `runnerKind` (`claude-code`, `codex`, or `opencode`), `model` and `effort` (the worker
defaults of the kind in force, or of `runnerKind` in the same call, for launches prepared from
then on; effort is `low`, `medium`, `high`, `xhigh`, or `max`, and `ultra` is codex-only),
`codex` and `opencode` (`{ model, effort }` for that kind whichever kind is in force), `sandbox` (the codex
sandbox), `networkAccess` (`codex.networkAccess`, `true` or `false`, for launches spawned or
claimed after the change; it widens what a Codex worker can reach, so set it only when the user
says so), `permission` and `dataDir` (the opencode leaves), and `commit` (`agent` or `daemon`, the commit policy of the kind in force); a null clears an override so the value falls back
to the file, detection, or the default. The integration branch is start-only: pass `integrationBranch` to `start` before
the run holds any launch; a running daemon refuses it.

## 1a. Work the run with session subagents

When the mode in force is `pull` or `mixed` and the run can hold `claude-code` launches, run
the bundled workflow before the first `wait`. Do not start it for a codex-default run or an opencode-default run
(`config.runnerKind` is `codex` or `opencode`) unless the graph has tasks with `runner: claude-code` or
`status.claimableByKind["claude-code"]` is above 0: the workers claim only `claude-code`
launches, so they would find nothing and stop. Use a worker count no larger than the run's
`capacity` (from `status`), usually 2 to 4, and a run tag such as `work-1`:

Read `workflows/work.js` from the plugin directory (`<plugin dir>/workflows/work.js`) and pass
its whole text inline as the Workflow tool's `script` input, with these `args`:

```
Workflow({ script: "<the whole text of <plugin dir>/workflows/work.js>", args: { workers: 2, runTag: "work-1", capacity: <status.config.capacity.value> } })
```

Pass the script inline: the Workflow tool loads a `scriptPath` only from the working directory, a
directory added with `/add-dir` (or `--add-dir`), or a path it returned earlier in the session, and
the plugin lives outside those, so `scriptPath` with the plugin path is refused. Use
`scriptPath: "<plugin dir>/workflows/work.js"` with the same `args` only when the plugin directory
has been added with `/add-dir`. After one inline run the Workflow tool returns a saved script path;
a re-run with the same run tag may pass that path as `scriptPath`.

Each worker loop runs a cheap claimer agent (`claude-haiku-5-5` at `low` by default; pass
`claimModel` and `claimEffort` only when the user asks otherwise) that claims a launch, polling
up to three times with 90-second waits when nothing is claimable, then runs a worker subagent
on its brief in the prepared worktree with the launch's model and effort, reports through the
worker tools, and claims again until nothing is claimable and nothing is being prepared for
`claude-code` (`status.preparingByKind["claude-code"]`). Agents are labelled `claim
<workerId>` and `work <workerId> <taskId>`. Workers edit files in worktrees under the run
directory, outside the repository, so an `acceptEdits` session prompts for each file there
unless it was started with `--add-dir ~/.orchestrator`. The workflow runs in the background; do
not wait for its completion notice, monitor with `wait` (section 2). When the workflow has ended while launches are still claimable (a question was
answered after it stopped, or a task was retried), re-run it with the same run tag: a worker
with the same id claims its launch back. In `spawn` mode run no workflow; the daemon's agents
do the work and you only monitor.

Launches worked by this session's subagents record no usage with the daemon: the workflow posts
none, so once each ends it counts in `cost.unmeteredLaunches` and its cost is outside
`budgets.maxRunCostUsd`.

## 2. Monitor loop

Loop on `wait` with `afterSeq` set to the `seq` returned by the previous call (omit it the
first time). Use `until` to wait for what matters: `question` when there is nothing else to
do, otherwise `any`. Each call returns within ninety seconds; call it again until the run
ends. After each return: first drain the tracker outbox (section 2a), then relay comment
answers (section 2b), then act on the digest:

- **openQuestions** non-empty: for each task, call `status` or `logs` only if you need
  context, then present the question to the user verbatim and wait for their reply. Send the
  reply with `answer`. Do not invent answers to questions that need a human decision. When the
  question's kind is `needsAccess` and it names a command (from `status`, under the task's
  blocked or waiting reason), offer three things: changing the configuration so launches
  prepared afterwards can run it, saying that the live agent cannot gain the change; running
  the command yourself on the agent's behalf in its worktree and sending the result with
  `answer`, which is what unblocks the live agent now; or answering with an alternative. The
  configuration change depends on the launch's kind (its `runner` in `status.liveLaunches`):
  for `claude-code`, a rule through `configure` (`allowedTools: ["Bash(<command>:*)"]`); for
  `codex`, a wider `sandbox` through `configure` (`workspace-write` from `read-only`, else
  `danger-full-access`, only when the user accepts it); for `opencode`, whose `permission: derived` rejects a command
  outside the derived rules automatically, `configure` with `permission: "allow"`, which lets
  every later opencode launch run any command. Do what the user picks.
- **needsConfig** names `checkCommand`: submitted tasks are held under `verifying` until a
  check command is set. Follow section 1b now; do not call the run slow or stalled.
- **profileHeld** non-empty: tasks are held until their model or effort is set. Follow the
  Worker profile paragraph of section 1 now; do not call the run slow or stalled.
- **awaitingReview** non-empty: invoke the `review` skill for each milestone.
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
  and retries it like any other failure; say so. To let a stuck launch keep running, see
  **a launch needs more time** below.
- **a launch needs more time**: whenever you read `status`, compare the `elapsedMs` of each
  running launch in `liveLaunches` with `budgets.maxLaunchMs` (when it is above 0) and tell
  the user when less than 15 minutes remain; offer the same when the user wants a stuck
  launch to keep running. To raise the time budget, offer `configure` with
  `budgets: { maxLaunchMs: <ms> }`; for a stuck launch that has a `pid` in
  `status.liveLaunches`, offer `configure` with `health: { stuckFailAfterMs: <ms> }`
  (`health.stuckFailAfterMs`; `budgets.maxLaunchMs` is the time budget). Values are
  milliseconds, and the daemon applies a change on its next tick. Check that
  `applied` in the answer lists `budgets` or `health`; a launch the daemon was already
  ending can still end. You need not send a `nudge`: the daemon tells each affected worker
  itself, with a `nudge` notice (`source: "config"`) that the worker sees on its next inbox
  call. Once the launch has reported or ended, clear the override with a null leaf (`budgets: { maxLaunchMs: null }`
  or `health: { stuckFailAfterMs: null }`), or the raise stays for every later launch of
  the run. A lowered, cleared or switched-on limit that a live launch is already past is
  refused with a 409 whose `wouldEnd` lists the launches it would end, and nothing is
  applied: show `wouldEnd` to the user, and send the call again with `endLive: true` only
  when the user says so (the next tick then ends those launches, each with an attempt
  spent). A launch held by this session's workers has no `pid` and is bound by its
  lease, `leaseTtlMs`, which is a start-time key: raising a stuck limit does not help it.
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
- **pausedReason** is `costBudget`: the run cost reached its ceiling. Report `cost.runUsd`,
  `cost.ceilingUsd`, and `cost.unmeteredLaunches` (launches whose cost is unknown) from `status`, then offer `resume` with `overrideBudget: true`
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

- A Linear project-milestone root (the effect's `url` is a project URL, with `/project/` in
  its path and not `/issue/`): never change the project's state, and never post a comment on
  it, because a project has no workflow state of its own and no comment thread. Answer every
  `setState` effect (`inProgress`, `done`, `cancelled`) with
  `ack { id, result: { applied: false, reason: "<why>" } }` and change nothing in Linear.
  Post only a `comment` whose `body` opens with "Milestone accepted:" or "Milestone rejected:",
  and post it as a project status update on the project the `url` names, with no health value
  (when the tool requires one, keep the project's current health). List the project's recent
  status updates first; if one already contains the effect's `marker`, call
  `ack { id, result: { statusUpdateId } }` with that update's id and do not post again.
  Otherwise post `body`, a blank line, and the `marker` as the last line, then call
  `ack { id, result: { statusUpdateId } }`. Every other `comment` for such a root (the
  ready-for-review comment, a blocked comment, a question) is not an accept or reject decision:
  answer it with `ack { id, result: { applied: false, reason: "<why>" } }` and post nothing.
  When this session has no Linear tool that posts a project status update, answer the accept
  and reject comments with `applied: false` and a reason that says so, and tell the user once.
  Always answer these effects with `ack` and a `result`, never with `error`, which is retried
  and ends in `trackerErrors`; a tracker error while posting a status update is still an
  `error`, as for any effect. The effect's stored status becomes `applied` either way: that is
  the daemon's word for acknowledged, and `result.applied: false` states that nothing was
  changed in the tracker. An effect acknowledged with `applied: false` is counted in neither
  number of the line below. A Linear effect whose `url` is an issue URL follows the rules
  below.
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
containing "— orchestrator run"; take the first
human comment posted after the latest marked comment that you have not relayed before; send
it with `answer`; remember that comment's id so you never relay it twice. If the daemon
answers 409, the task is no longer waiting or blocked (someone answered first): tell the
user and do not retry. Answers typed in this session still work; the first answer wins.

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

The run's state is durable. A launch held by one of this session's workers is handed back
when the session ends, with its branch kept and any uncommitted work committed on it; the
next launch is briefed to continue from that branch, and no attempt is spent. Parked
launches wait for the next worker. The daemon exits on its own after `daemon.idleExitMs`
(ten minutes by default) with no session attached and nothing live, records why in the run
directory, and comes back on the next tool call; `runs` shows every run with its daemon's
state or last exit. Tell the user they can come back and use the `run` skill again; nothing
is lost. Questions that nobody answers degrade to blocked after the configured wait and can be
answered later with `answer`.
