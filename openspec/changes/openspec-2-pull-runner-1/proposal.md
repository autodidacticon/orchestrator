## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. In `pull-runner`, 12 of the 26 requirements are over the limit. This change, part 1 of 2 of the OpenSpec 2.1 migration of `pull-runner` (task GH-175, ORC-175, under #139), splits 5 of them the way OpenSpec 2.1 prescribes, without changing what the spec requires. The other long requirements are split by `openspec-2-pull-runner-2`, which touches disjoint requirements.

## What Changes

- Five requirements are MODIFIED. Each keeps its header and every scenario, with names and text unchanged, and its description is cut to one behavior of at most 500 characters:

  | Requirement | Before | After | Scenarios kept | ADDED from it |
  |---|---|---|---|---|
  | Runner modes | 979 | 424 | 4 | 3 |
  | Claim | 3608 | 482 | 16 | 12 |
  | Worker identity | 550 | 336 | 3 | 1 |
  | Release | 3379 | 496 | 11 | 12 |
  | Access modes | 1156 | 471 | 5 | 3 |

- 31 requirements are ADDED, one for each behavior moved out of those descriptions. Each name starts with the name of the MODIFIED requirement its text comes from, followed by a colon, and `pull-runner` has no requirement of that name at the base commit 3c9c12b. Each has a description of at most 500 characters (83 to 494) that holds SHALL or MUST, and one scenario of its own with a WHEN and a THEN step. Each scenario states behavior the code has at the base commit; the file (and test) that shows it is named under "Where each new scenario comes from".
- No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped or weakened. The 5 original descriptions hold 79. The cut descriptions hold 19 and the ADDED descriptions 61, 80 in all; the extra one is the lead-in repeated in the split of "Claim" s7.
- Requirements under 500 characters are not touched. Nothing outside this change directory changes. The fixes of #163, #164 and #165 are not made here.

### Splits, lead-ins and SHALL at a joint

Sentences are numbered from 1 in each original description. Two original sentences are longer than 500 characters on their own, and each is split at its own joints:

- **"Claim" s7 (545 characters)** has no semicolon. It is one list, the items of `opencode: { ... }`, split between its items. The lead-in "For an `opencode` launch the response SHALL carry `opencode: { settings, allowedTools, maxWaitMs, retryWindowMs, env }` instead:" is repeated in each part. The first part keeps the items "the effective `runner.opencode` keys, the long-poll ceiling, the retry window, and the agent environment" in their order, and the closing clause ", so that a worker loop composes the same `opencode run` command and per-launch config, including the derived permission ruleset" stays with it, because it names the command and config that those items compose; it goes to "Claim: OpenCode block" (362 characters). The second part takes the `allowedTools` item, "the rules the OpenCode runner derives its permission ruleset from (the composed allow list, else the detected toolchain and the claude file rules, the same list the runner is given)", unchanged and closed with a period, and goes to "Claim: OpenCode permission rules" (311 characters). The joint's words are the only ones changed: the item's trailing ", " leaves the first part, and the lead-in is repeated in the second.
- **"Release" s4 (529 characters)** is split at its semicolon. The first part, the five SHALL verbs of a kept release, is unchanged and ends with a period instead of the semicolon; it goes to "Release: kept release after progress" (461 characters). The second part, "the response SHALL report `kept` true with the branch and head sha", is given the sentence's own condition "When progress has been observed and `keep` is true," at its head, so that it is right when read alone, and goes to "Release: kept release response" (119 characters).

No lead-in is given to a bullet (the five descriptions have none), and no SHALL is given at a joint: every moved sentence already holds SHALL, SHALL NOT or MAY with SHALL. Two original sentences have no SHALL or MUST of their own, "Access modes" s2 and s3 (what `local` and `remote` mean), and neither moves: both stay in the MODIFIED description with s1 and s4.

### Moved sentences

For each MODIFIED requirement, every original sentence is listed below with where it now is. "Unchanged" means word for word. Every changed or split sentence is quoted first as it was, then as each part now reads, with the kind of change and the requirement that holds the part.

#### Runner modes

- s1, unchanged, "Runner modes: configuration keys": "The configuration SHALL accept `runner.mode` with values `spawn`, `pull`, and `mixed`, defaulting to `spawn`, and `runner.claimWindowMs`, defaulting to 60000."
- s2, unchanged, stays in "Runner modes": "Every launch prepared in `pull` or `mixed` mode SHALL be parked as `claimable` once its worktree and brief exist; in `spawn` mode the launch SHALL be spawned immediately as before."
- s3, unchanged, stays in "Runner modes": "A parked launch SHALL have a claim window: unbounded in `pull`, `runner.claimWindowMs` from the moment it became claimable in `mixed`, and zero in `spawn`."
- s4, unchanged, stays in "Runner modes": "On each tick the orchestrator SHALL spawn every parked launch whose window has elapsed."
- s5, unchanged, "Runner modes: mode override": "`start` with a `mode` argument SHALL override the configured mode for the run, passed to the daemon it spawns or set through the `runner` route on a daemon already running; the override SHALL be stored durably and SHALL apply from the next tick, including to launches already parked."
- s6, unchanged, "Runner modes: paused run": "While the run is paused, parked launches SHALL stay parked: they SHALL NOT be spawned and SHALL NOT be claimed."

#### Claim

- s1, unchanged, "Claim: request fields": "`POST /v1/claims` SHALL take `workerId`, an optional `taskId`, an optional `access`, and an optional `runner`: one runner kind or a list of the kinds the worker can run; a value outside the kinds SHALL be refused with 400."
- s2: "Without `taskId` it SHALL hand over the oldest claimable launch by creation time among those whose kind the filter names (any kind without a filter); with `taskId` it SHALL hand over that task's claimable launch, answering 404 when the task has no launch, 409 naming the launch state when its launch is not claimable, and 409 naming the launch's `runner` when its kind is outside the filter."
  - reference made explicit ("it" becomes "`POST /v1/claims`"), stays in "Claim": "Without `taskId` `POST /v1/claims` SHALL hand over the oldest claimable launch by creation time among those whose kind the filter names (any kind without a filter); with `taskId` it SHALL hand over that task's claimable launch, answering 404 when the task has no launch, 409 naming the launch state when its launch is not claimable, and 409 naming the launch's `runner` when its kind is outside the filter."
- s3: "When nothing is claimable for the filter, or the run is paused, it SHALL answer 404 with `paused` set accordingly, and a launch of another kind SHALL stay parked."
  - reference made explicit ("it" becomes "`POST /v1/claims`"), "Claim: nothing to hand over": "When nothing is claimable for the filter, or the run is paused, `POST /v1/claims` SHALL answer 404 with `paused` set accordingly, and a launch of another kind SHALL stay parked."
- s4, unchanged, stays in "Claim": "A worker that already holds a launch SHALL get it back whatever its filter."
- s5, unchanged, "Claim: launch handed over": "On success the launch SHALL become `live` with `worker: { id, claimedAt }` and no pid, its lease SHALL be reset to expire `leaseTtlMs` after the claim, and the response SHALL be `{ launchId, taskId, token, worktree, briefPath, brief, baseSha, apiUrl, runner, commitPolicy, model, effort }`, where `brief` is the launch's `brief.json` content, `briefPath` the path of its `brief.md`, and `runner`, `commitPolicy`, `model`, and `effort` the values fixed when the launch was prepared."
- s6, unchanged, "Claim: Codex block": "For a `codex` launch the response SHALL also carry `codex: { settings, maxWaitMs, retryWindowMs, env }`: the effective `runner.codex` keys, the long-poll ceiling, the retry window, and the agent environment a spawned launch would get, so that a worker loop composes the same `codex exec` command."
- s7: "For an `opencode` launch the response SHALL carry `opencode: { settings, allowedTools, maxWaitMs, retryWindowMs, env }` instead: the effective `runner.opencode` keys, the rules the OpenCode runner derives its permission ruleset from (the composed allow list, else the detected toolchain and the claude file rules, the same list the runner is given), the long-poll ceiling, the retry window, and the agent environment, so that a worker loop composes the same `opencode run` command and per-launch config, including the derived permission ruleset."
  - split between the items of its list, first part (lead-in "For an `opencode` launch the response SHALL carry `opencode: { settings, allowedTools, maxWaitMs, retryWindowMs, env }` instead:" kept; the `allowedTools` item moves out; the closing ", so that ..." clause stays with this part), "Claim: OpenCode block": "For an `opencode` launch the response SHALL carry `opencode: { settings, allowedTools, maxWaitMs, retryWindowMs, env }` instead: the effective `runner.opencode` keys, the long-poll ceiling, the retry window, and the agent environment, so that a worker loop composes the same `opencode run` command and per-launch config, including the derived permission ruleset."
  - split between the items of its list, second part (lead-in repeated before the unchanged `allowedTools` item, which ends with a period), "Claim: OpenCode permission rules": "For an `opencode` launch the response SHALL carry `opencode: { settings, allowedTools, maxWaitMs, retryWindowMs, env }` instead: the rules the OpenCode runner derives its permission ruleset from (the composed allow list, else the detected toolchain and the claude file rules, the same list the runner is given)."
- s8, unchanged, "Claim: Codex block": "A launch of one kind SHALL NOT carry another kind's block."
- s9, unchanged, "Claim: token fenced until the claim": "The token of a claimable launch SHALL NOT authenticate until the claim is recorded."
- s10, unchanged, "Claim: remote response": "For a launch with `access: remote` the response SHALL carry every field of the local response except `worktree` and `briefPath`, plus `access: "remote"`, `repoUrl`, `integrationBranch`, and `briefMarkdown`: `repoUrl` is `git.workerOriginUrl` when set, else `git.originUrl`, else the URL of the daemon clone's `origin` remote, passed through as written (user information included); `brief` is the launch row's stored `briefJson` and `briefMarkdown` its stored brief text, neither read from disk."
- s11, unchanged, "Claim: remote carry and repeated claim": "When the stored brief's context holds `interrupted` (a kept release), the remote response SHALL carry it as `carry`, so that the worker starts its branch at `carry.interrupted.headSha`."
- s12, unchanged, "Claim: remote carry and repeated claim": "A repeated claim of a remote launch SHALL answer the same body with `repeated: true`."
- s13, unchanged, "Claim: remote fingerprint": "A remote claim SHALL record no baseline `fingerprint` on the launch and SHALL NOT read the workspace fingerprint."
- s14, unchanged, "Claim: worker origin URL key": "`git.workerOriginUrl` is a config-file key read at start; it SHALL NOT change the meaning of `git.originUrl`, which stays the URL of the daemon clone's `origin` and the input of the run id."
- s15, unchanged, "Claim: remote carry and repeated claim": "The local response SHALL be unchanged."
- s16, unchanged, "Claim: workers claim by kind": "The work workflow's Claude Code workers SHALL claim with `runner: "claude-code"`, and the work loop with `runner: "codex"` or `runner: "opencode"`, the kind it was started for."

#### Worker identity

- s1, unchanged, stays in "Worker identity": "`workerId` SHALL be an opaque string chosen by the worker and unique within a run."
- s2, unchanged, stays in "Worker identity": "A worker SHALL hold at most one live launch."
- s3, unchanged, stays in "Worker identity": "A claim by a worker that already holds a live launch SHALL return that launch again with the same token when `taskId` is absent or matches, and 409 otherwise."
- s4: "The repeated response SHALL also carry `pending: { seq, question, answer? }` when the launch has an open question or an admitted answer, so that a fresh worker can collect the answer with `block` and the same seq."
  - reference made explicit ("The repeated response" becomes "The response to a repeated claim"), "Worker identity: pending question in a repeated claim": "The response to a repeated claim SHALL also carry `pending: { seq, question, answer? }` when the launch has an open question or an admitted answer, so that a fresh worker can collect the answer with `block` and the same seq."
- s5, unchanged, stays in "Worker identity": "`status` SHALL list every worker with its launch."

#### Release

- s1, unchanged, stays in "Release": "`POST /v1/launches/:id/release` with a `reason` and an optional boolean `keep` SHALL apply to a live launch held by a worker and SHALL answer 409 for any other launch."
- s2, unchanged, stays in "Release": "When no progress has been observed since the claim, meaning no commit or dirty file in the worktree and no API call under the token, the launch SHALL end with reason `released`, the task SHALL return to `unstarted` without consuming an attempt, and the worktree SHALL be removed so that the next admission prepares a new launch."
- s3, unchanged, "Release: after progress without keep": "When progress has been observed and `keep` is false, the release SHALL be a failed attempt with reason `released` and the worker's reason as message."
- s4: "When progress has been observed and `keep` is true, the orchestrator SHALL commit any uncommitted changes in the worktree as a work-in-progress commit on the launch branch, SHALL end the launch with reason `released`, SHALL remove the worktree and keep the branch, SHALL return the task to `unstarted` with `attempts` unchanged, and SHALL store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason }` so that the next brief carries it; the response SHALL report `kept` true with the branch and head sha."
  - split at its semicolon, first part, unchanged up to the semicolon, which becomes a period, "Release: kept release after progress": "When progress has been observed and `keep` is true, the orchestrator SHALL commit any uncommitted changes in the worktree as a work-in-progress commit on the launch branch, SHALL end the launch with reason `released`, SHALL remove the worktree and keep the branch, SHALL return the task to `unstarted` with `attempts` unchanged, and SHALL store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason }` so that the next brief carries it."
  - split at its semicolon, second part (the condition "When progress has been observed and `keep` is true," repeated before "the response SHALL report ..."), "Release: kept release response": "When progress has been observed and `keep` is true, the response SHALL report `kept` true with the branch and head sha."
- s5, unchanged, "Release: release while waiting": "A release while the task is `waiting` SHALL act as process death: the task becomes `blocked` with its question preserved, and with `keep` the same `interrupted` context SHALL be stored and the branch kept."
- s6, unchanged, "Release: interruptions": "The overlay entry SHALL carry `interruptions`, increased by one on every kept release after progress or while waiting, reset to zero when the task submits, carried in the `interrupted` context, and reported with each live launch in `status`."
- s7, unchanged, "Release: kept release bound": "The configuration SHALL accept `daemon.maxKeptReleases`, default 3, where 0 means unlimited; a release with `keep` for a task whose `interruptions` already equals or exceeds it SHALL behave as a release without `keep`."
- s8, unchanged, "Release: lease expiry of a claimed launch": "Lease expiry on a claimed launch SHALL follow "Lease expiry": a kept release when the worktree shows progress since the claim and the bound allows, a failed attempt with reason `leaseExpired` otherwise."
- s9, unchanged, "Release: remote release body": "A remote launch (`access: remote`) has no worktree on the daemon's host: the release body MAY carry `headSha`, the launch branch tip the worker pushed, and `wipCommit`, its work-in-progress commit, each a full hex object name (a malformed one SHALL be answered 400 naming the field, and a local release SHALL ignore both)."
- s10, unchanged, "Release: remote progress": "For a remote launch, progress SHALL be any agent API call since the claim or a `headSha` that differs from the base sha, and the orchestrator SHALL NOT fingerprint, preserve or remove anything."
- s11, unchanged, "Release: remote keep checks origin": "A kept remote release SHALL fetch the launch branch from origin and require its tip to equal `headSha`: no branch on origin SHALL answer 409 `branchNotPushed`, another tip 409 `shaMismatch`, and an origin that cannot be fetched 503 `originUnreachable` or `originRefused`; on any of these the task and the launch SHALL be unchanged, the launch SHALL stay live, and no `launch.released` event SHALL be appended."
- s12, unchanged, "Release: remote keep without headSha": "A remote release with `keep` but no `headSha` cannot be kept and SHALL behave as a release without `keep`, with `keepError` naming `headSha`."
- s13: "Otherwise a kept remote release SHALL store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason, interruptions }` as a local one does, under the same `daemon.maxKeptReleases` bound, and its `launch.released` event SHALL carry `headSha`."
  - reference made explicit ("Otherwise" becomes "When origin's tip of the launch branch equals the reported `headSha`,", the case left after the refusals of s11 and the missing `headSha` of s12), "Release: remote kept carry": "When origin's tip of the launch branch equals the reported `headSha`, a kept remote release SHALL store `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason, interruptions }` as a local one does, under the same `daemon.maxKeptReleases` bound, and its `launch.released` event SHALL carry `headSha`."

#### Access modes

- s1, unchanged, stays in "Access modes": "A run SHALL have one access, the file key `runner.access`, `local` or `remote`, default `local`, read at start; it SHALL NOT be a runtime override."
- s2, unchanged, stays in "Access modes": "`local` means the worker runs on the daemon's machine, reaches the loopback API, and works in the worktree the daemon prepared."
- s3, unchanged, stays in "Access modes": "`remote` means the worker runs elsewhere and gets no worktree from the daemon (see specs/remote-workspace)."
- s4, unchanged, stays in "Access modes": "Any other value SHALL fail configuration loading with a message naming `runner.access`."
- s5, unchanged, "Access modes: remote run preconditions": "The daemon SHALL refuse to start with `runner.access: remote` unless the runner mode in force is `pull`, `git.pushIntegration` is true, and `prepareCommand` is unset, with one message naming each unmet condition; on a remote run `PUT /v1/runner` SHALL refuse any mode other than `pull` with 409."
- s6, unchanged, "Access modes: access on launch rows": "Every launch row SHALL carry the run's access in `access`, set when the row is created and never changed; a row without it is `local`."
- s7, unchanged, "Access modes: claim access": "A claim's `access` SHALL be `local` or `remote` and SHALL default to `local`; any other value SHALL be answered 400."
- s8, unchanged, "Access modes: claim access": "A claim whose `access` differs from the run's SHALL be answered 409 with `reason`, `access` and `runAccess`, and SHALL change no launch."

### Where each new scenario comes from

Each scenario rests on the files below, as they are at the base commit 3c9c12b:

- "Runner keys left unset": `src/config.ts` (`runner.mode: z.enum(['spawn', 'pull', 'mixed']).default('spawn')`, `claimWindowMs ... default(60_000)`).
- "Override stored and applied to parked launches": `test/loop/modes.test.ts` ("a mode switch drains parked launches on the next tick, pause holds them, ...") and `src/loop/orchestrator.ts` (`setMode` writes the `runner.mode` key and the `operator.mode` event; `effectiveMode` reads it).
- "Pause holds parked launches": `test/loop/modes.test.ts` (the same test: paused, a tick leaves T1 and T5 parked, a claim is 404 with `paused: true`, and after `resume` both are spawned).
- "Kind outside the runner kinds": `test/slice/claim.test.ts` ("a runner filter skips launches of other kinds, ..."), and `claim()` in `src/loop/orchestrator.ts` (the 400 is answered before any launch is read).
- "Paused run and empty run answer 404": `test/slice/claim.test.ts` ("claims oldest first or by name, ...": `w3` gets `paused: false`, `w9` after `pause()` gets `paused: true`), and `claim()` (a held launch is answered before the pause check, so both workers hold none).
- "Local claim response names the brief": `test/slice/claim.test.ts` ("claims oldest first or by name, ...": `briefPath` exists, `brief.task.description`, `lease.expiresAt - worker.claimedAt` is `leaseTtlMs`).
- "Heartbeat with the token of a parked launch": `test/slice/claim.test.ts` ("claims oldest first or by name, ...": the heartbeat of claimable T2 is 401, that of claimed T1 200).
- "Codex claim carries the long-poll facts": `test/slice/codex-work.test.ts` ("a codex claim carries the commit policy, the runner.codex settings, and the agent environment") and `test/host/work-loop.test.ts` ("an opencode claim carries ...": `codex` is undefined).
- "OpenCode claim carries the settings and the environment" and "Rules equal the runner's list": `test/host/work-loop.test.ts` ("an opencode claim carries the runner.opencode settings, the allowedTools, the long-poll ceiling, and the agent environment") and `openCodeAllowedTools` in `src/loop/orchestrator.ts`.
- "Remote brief from the launch row": `test/loop/remote-claim.test.ts` ("answers 200 with the remote fields and no worktree or briefPath", "repoUrl is git.workerOriginUrl when set, passed through as written").
- "Repeated remote claim answers the same body": `test/loop/remote-claim.test.ts` ("a second claim by the same worker answers the same launch with repeated: true"), and `localShapedResponse` in `src/loop/orchestrator.ts` (a local response has `worktree` and `briefPath` and no `access`, `repoUrl` or `briefMarkdown`).
- "No fingerprint call on a remote claim": `test/loop/remote-claim.test.ts` ("records no fingerprint and does not call Workspace.fingerprint").
- "Worker URL leaves the run id alone": `test/loop/remote-claim.test.ts` ("is an optional non-empty string, and git.originUrl keeps its meaning").
- "Claim lines of the workflow and the loop": `hosts/claude-code/workflows/work.js` and `test/host/package.test.ts` (`access "local", and runner "claude-code"`), `hosts/codex/bin/work.mjs` (`POST /v1/claims` with `runner: kind`) and `test/host/work-loop.test.ts` ("--runner defaults to codex and accepts opencode; another kind is refused").
- "Re-claim carries the open question": `test/slice/claim.test.ts` ("claims oldest first or by name, ...": `pendingClaim` has `repeated: true` and `pending: { seq: 1, question: { message: 'which?' } }`).
- "Failed release reaches the next brief": `test/slice/claim.test.ts` ("claims oldest first or by name, ...": `rel2` and the `priorFailure` of the next claim's brief).
- "Kept release ends the launch and stores the context" and "Answer names the kept branch and head": `test/loop/scenarios.test.ts` ("kept release", "after progress leaves attempts unchanged, stores the interrupted context, ...").
- "Kept release of a waiting launch": `test/loop/scenarios.test.ts` ("while waiting blocks with the question and the context; without progress stores nothing").
- "Interruptions counted, shown and reset": `test/loop/scenarios.test.ts` ("after progress leaves attempts unchanged, ...": `liveLaunches` shows `interruptions` 1; "is bounded by daemon.maxKeptReleases and the counter resets on submit") and the submit transition in `src/loop/orchestrator.ts` (`interruptions: 0`).
- "A bound of 0 keeps every release": `src/config.ts` (`maxKeptReleases ... default(3)`) and `release()` in `src/loop/orchestrator.ts` (`underBound = bound === 0 || interruptions < bound`, `interruptions: interruptions + 1`).
- "Expired claim kept, untouched retry failed": `test/slice/claim-recovery.test.ts` ("an expired claim with a dirty file is kept on its branch at no cost; an untouched retry that expires spends the attempt").
- "Malformed shas refused before origin is asked": `test/slice/remote-release.test.ts` ("a headSha that is not the branch tip at origin answers 409 and the launch stays live"), and `release()` (a local release never reads `headSha` or `wipCommit`).
- "Remote release touches no workspace": `test/slice/remote-release.test.ts` ("calls neither Workspace.fingerprint, preserve nor remove").
- "Refused keep changes nothing": `test/slice/remote-release.test.ts` ("a headSha that is not the branch tip at origin answers 409 and the launch stays live"); the 503 answers come from `sealRefusal` in `src/loop/orchestrator.ts`.
- "Keep without a pushed tip": `releaseRemote` in `src/loop/orchestrator.ts` (an API call is progress; `keep` with no `headSha` sets `keepError` naming `headSha` and is not kept, so the release fails the attempt with kind `released`).
- "Pushed tip kept at no cost": `test/slice/remote-release.test.ts` ("a pushed tip is kept at no cost and the next remote claim carries it") and `releaseRemote` (the `launch.released` payload carries `headSha`).
- "Mode route on a remote run": `test/slice/remote-access.test.ts` ("a mode override to spawn on a remote run counts, and the mode route refuses to switch away from pull").
- "Rows of a remote run": `test/slice/remote-access.test.ts` ("admission parks a launch with the brief on its row and no worktree; ...").
- "Claim access outside the two": `test/slice/remote-access.test.ts` ("rows carry access local, and a remote worker is refused with both accesses named") and `claim()` (the 400 is answered before any launch is read).

## Capabilities

### New Capabilities

### Modified Capabilities

- `pull-runner`: "Runner modes", "Claim", "Worker identity", "Release" and "Access modes" have their descriptions cut to one behavior each. The moved behaviors become 31 ADDED requirements. What the spec requires is unchanged.

## Impact

Only `openspec/changes/openspec-2-pull-runner-1/`. No code changes.
