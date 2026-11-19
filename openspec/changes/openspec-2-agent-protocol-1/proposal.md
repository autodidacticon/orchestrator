## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. 16 of the 33 requirements of `agent-protocol` are over the limit. This change, part 1 of 2, splits six of them the way OpenSpec 2.1 prescribes, without changing what the spec requires: "Standalone brief" (5991 characters), "Submission sealing" (1461), "Acceptance evidence" (572), "Block and wait" (748), "Fallback file" (606) and "MCP façade" (3384). It is part of the OpenSpec 2.1 migration (#139, task GH-169). Part 2 (`openspec-2-agent-protocol-2`) splits the other ten in a change of its own; the two parts touch disjoint requirements.

## What Changes

- MODIFIED, six requirements: "Standalone brief", "Submission sealing", "Acceptance evidence", "Block and wait", "Fallback file" and "MCP façade". Each keeps its header and every scenario, names and texts unchanged (34 scenarios). Its description is cut to one behavior of at most 500 characters (438, 458, 279, 465, 401 and 376).
- ADDED, forty requirements, one per behavior removed from a MODIFIED description. Each is named after the MODIFIED requirement its text comes from, then a colon and the behavior. Each holds the moved sentences, unchanged or with only their references made explicit, split, given a lead-in or given SHALL at a joint as listed below. Each has a description of 61 to 494 characters with SHALL or MUST, and at least one new scenario with WHEN and THEN.
- SHALL/MUST: the six original descriptions hold 76. The cut descriptions hold 23 and the ADDED descriptions 64, which makes 87. The extra ones come from repeated lead-ins and from SHALL added at joints. No SHALL or MUST is dropped or weakened.
- Nothing is removed or renamed. No other requirement of `agent-protocol` changes, and no fix of #163, #164 or #165 is made: the text is kept as it is, "60 000 ms" included.

### Rules used in the lists below

- *Unchanged*: moved word for word.
- *Explicit*: only a reference was made explicit; the replaced words are named.
- *Lead-in*: a bullet of the list "They SHALL contain:" moved with that lead-in before its unchanged text, "They" made explicit as "`brief.md` and `brief.json`".
- *Split*: a sentence or bullet over 500 characters on its own, or one that left a part over 500, cut at its own joint; what changed at the joint is named.
- *SHALL at a joint*: moved text with no SHALL of its own, which no SHALL sentence could carry within 500 characters, gets SHALL plus its own verb; nothing else changes.
- A bullet's closing `;` becomes `.` where the bullet's text now ends a description.

### Moved sentences

#### Standalone brief

Stays in the MODIFIED description, unchanged: "Before launching, the orchestrator SHALL write `<worktree>/.orchestrator/brief.md` and `brief.json`."; "They SHALL contain:" with the bullets "the task payload verbatim and the acceptance criteria;", "workspace facts: worktree path, branch, `baseSha`, integration branch;" and "the completion report of each direct dependency, and any released cancellation with its reason;"; and "The brief MUST be sufficient for a person to perform the task without any other channel."

- Bullet "the definition of done: …" (1024 characters) is split between its sentences:
  - "the definition of done: under the `agent` commit policy, commit all work on the launch branch (a dirty worktree is refused with the file list; commit and resubmit); under `daemon`, leave the changes in the worktree, committed or not, because the orchestrator commits what is uncommitted when it accepts the report." and "In both cases: never merge or touch the integration branch, declare a no-op explicitly, and terminate after the report is accepted." → **Standalone brief: definition of done** (lead-in).
  - "When the repository has an `openspec/` root (the launch worktree contains `openspec/`), for every runner kind and commit policy it SHALL also say to record any spec change as an OpenSpec change directory … validated with `openspec validate <name>`, and not to edit `openspec/specs/` directly." is 510 characters on its own. It is split at the clause joint ", and not to edit", with the subject and its condition repeated in the second part:
    - "… for every runner kind and commit policy the brief's definition of done SHALL also say to record any spec change … validated with `openspec validate <name>`." → **Standalone brief: OpenSpec change rule** ("it" made explicit as "the brief's definition of done").
    - "When the repository has an `openspec/` root (the launch worktree contains `openspec/`), for every runner kind and commit policy the brief's definition of done SHALL also say not to edit `openspec/specs/` directly." → **Standalone brief: OpenSpec specs not edited directly** (split; the condition and subject repeated).
  - "Without an `openspec/` root the brief SHALL NOT carry that item;" → **Standalone brief: no OpenSpec rule without a root** ("that item" made explicit as "the OpenSpec change-directory item of the definition of done").
- Bullet "attempt context when present: …" (517 characters with its lead-in) is split between its sentences:
  - "attempt context when present: the prior failure report, verifier output, conflict details naming the files and the sibling that landed, and the human's answer." → **Standalone brief: attempt context** (lead-in).
  - "Under `agent`, the conflict, interruption, and revision texts tell the agent to rebase, merge or cherry-pick the prior branch, squash a work-in-progress commit, and commit the delta." and "Under `daemon` they tell it instead to inspect the prior branch with `git show`/`git diff` and reapply the changes as file edits;" → **Standalone brief: attempt context by commit policy**. They have no SHALL of their own, and no SHALL sentence carries them within 500 characters (the lead-in and the first part with them make 517), so the first gets SHALL at a joint ("tell" becomes "SHALL tell"). "the conflict, interruption, and revision texts" is made explicit as "… texts of the brief".
- Bullet "the API base URL, the launch token, the fallback report path, and the instruction to stop immediately on a 401." → **Standalone brief: reporting facts** (lead-in).
- "A remote launch (`access: remote`) has no worktree: its brief is kept on the launch row (see specs/remote-workspace)." → **Standalone brief: remote brief names no daemon path** (unchanged; carried by the SHALL sentence that follows it).
- "The text the orchestrator writes into its workspace and reporting sections SHALL name no path … and no loopback address; text carried verbatim … is not rewritten." → **Standalone brief: remote brief names no daemon path** ("its" made explicit as "a remote brief's").
- "Its workspace section SHALL instead name the clone (…), the branch, the base commit and the integration branch, and SHALL say how work is submitted: commit all work on the branch; … not from the clone." (562 characters on its own) is split at the clause joint ", and SHALL say", with the subject repeated:
  - "A remote brief's workspace section SHALL instead name the clone (the current directory, a clone of the repository the worker loop made), the branch, the base commit and the integration branch." → **Standalone brief: remote workspace section** ("Its" made explicit).
  - "A remote brief's workspace section SHALL say how work is submitted: commit all work on the branch; `report` with kind submit through the `orchestrator` MCP server's tool pushes the branch to `origin` and names the pushed commit; an agent that calls the API itself first runs `git push origin <branch>` and sends the tip's full sha as `sealedSha`; the orchestrator reads the work from `origin`, not from the clone." → **Standalone brief: remote submit line** (split; subject repeated).
- "Its API base URL SHALL be `apiBaseUrl` (without a trailing slash), never the bind address, and its fallback report path SHALL be the relative path `.orchestrator/report.json`, which the brief says is relative to the root of the clone; `brief.json` SHALL carry the same branch, base commit, API base URL and fallback path." → **Standalone brief: remote API base URL and fallback path** ("Its" made explicit as "A remote brief's").
- "For a carry holding `interrupted`, the remote brief SHALL say that the branch starts at `carry.interrupted.headSha` …, and SHALL NOT tell the agent to merge or cherry-pick the prior branch onto its base." → **Standalone brief: remote brief after an interruption** (unchanged).
- "Whether the remote brief carries the OpenSpec change rule SHALL follow whether the daemon's clone has an `openspec/` root." and "The commit-policy lines of the definition of done SHALL be those of `agent`, … and the prepare-command item SHALL NOT appear, since a remote run has no `prepareCommand`." → **Standalone brief: remote definition of done** (unchanged).
- "A local launch's brief SHALL be unchanged by this." → **Standalone brief: remote definition of done** ("this" made explicit as "the rules of a remote brief").
- "The agent sees the shim's tools under a name that depends on its CLI: `mcp__orchestrator__<tool>` under Claude Code and Codex, `orchestrator_<tool>` under OpenCode." → **Standalone brief: OpenCode reporting tools** (unchanged; carried by the SHALL sentence that follows it).
- "An `opencode` brief's Reporting section SHALL name `orchestrator_heartbeat`, … and tell the agent to prefer them to calling the API from a command." → **Standalone brief: OpenCode reporting tools** (unchanged).
- "The `claude-code` and `codex` briefs keep their Reporting text (the `codex` one is in "Codex brief reports through the MCP server")." → **Standalone brief: Reporting text by kind** (unchanged; carried by the SHALL sentences that follow it).
- "It SHALL keep the API and the fallback file, because no sandbox blocks loopback." and "It SHALL NOT name `mcp__orchestrator__` tools." → **Standalone brief: Reporting text by kind** ("It" made explicit as "An `opencode` brief's Reporting section").
- "An `opencode` brief's workspace section SHALL say that OpenCode permission rules are in force with nothing else confining the agent's commands." → **Standalone brief: OpenCode permission rules** (unchanged).
- "It SHALL NOT mention a sandbox." → **Standalone brief: OpenCode permission rules** ("It" made explicit as "An `opencode` brief's workspace section").
- "It SHALL say that a command a rule does not allow fails with "The user has specified a rule which prevents you from using this specific tool call." and is not approved at runtime." → **Standalone brief: OpenCode deny error** ("It" made explicit as "An `opencode` brief's workspace section").
- "That is the `deny` error, which the model sees and continues past." → **Standalone brief: OpenCode deny error** (unchanged; carried by the SHALL sentence before it).
- "It SHALL tell the agent not to retry it but to ask with a `needsAccess` question naming the command and continue with what it can, and say that the operator can run it or set `runner.opencode.permission` to `allow` for the next launch." → **Standalone brief: OpenCode needsAccess question** ("It" made explicit as "An `opencode` brief's workspace section", and "retry it" as "retry a command a rule does not allow").
- "Under `derived` it SHALL list the file tools (read, glob, grep, list, edit, write), then the `bashPatterns` followed by the check command's patterns." and "It SHALL say that every other command is denied and that each command of a chain (`&&`, `;`, `|`) must match one of them on its own." → **Standalone brief: OpenCode derived patterns** ("it"/"It" made explicit as "an `opencode` brief's workspace section").
- "`brief.json` SHALL carry the launch's `runner` (`kind`, `commitPolicy`, `sandbox` for a `codex` launch, and `permission` for an `opencode` launch)." and "The `permission` holds `mode` (`derived` or `allow`) and, under `derived`, the `bashPatterns` the runner's ruleset allows, `git *` first." → **Standalone brief: runner in brief.json** (unchanged; the second is carried by the first).
- "A brief composed without a runner SHALL be the `claude-code` text under the `agent` policy." → **Standalone brief: brief without a runner** (unchanged).

#### Submission sealing

Stays in the MODIFIED description, unchanged: "On `report submit` the orchestrator SHALL inspect the worktree, ignoring `.orchestrator/`.", "Under the launch's `agent` commit policy, a worktree with uncommitted or untracked changes SHALL be rejected with 409 and the list of files, and the task SHALL remain `running`.", "Once the worktree is clean or committed, the branch head SHALL be recorded as `sealedSha` and the task SHALL become `submitted`." and "Commits made after sealing SHALL be ignored by verification."

- "Under `daemon`, the orchestrator SHALL commit those changes on the launch branch: author and committer `orchestrator`, hooks skipped, the report summary as the message." → **Submission sealing: daemon commit** ("those changes" made explicit as "a worktree's uncommitted or untracked changes").
- "It SHALL then seal the new head, and the `agent.report` event SHALL carry `committedByOrchestrator: true`." → **Submission sealing: daemon commit** ("It" made explicit as "The orchestrator").
- "Under either policy, a clean worktree SHALL NOT be committed." → **Submission sealing: daemon commit** (unchanged).
- "On a remote launch the daemon holds no worktree: the submit report SHALL carry `sealedSha`, …; the commit policy does not apply." and "A remote submit without `sealedSha`, or with a value that is not a full hex object name, SHALL answer 400 naming `sealedSha` and record nothing." → **Submission sealing: remote launch** (unchanged).
- "On a local launch `sealedSha` in the report SHALL be ignored." → **Submission sealing: local sealedSha ignored** (unchanged).
- "A refused seal, local or remote, SHALL record no `agent.report` event and no deduplicated response, so the same `seq` may be sent again." → **Submission sealing: refused seal records nothing** (unchanged).

#### Acceptance evidence

Stays in the MODIFIED description, unchanged: "When the brief contains acceptance criteria, the submit report MUST include an `acceptance` entry with evidence for each criterion; otherwise the submission SHALL fail with reason `missingAcceptanceEvidence`." and "The check is structural; the orchestrator does not judge the evidence."

- "An entry covers a criterion when its `criterion` matches the criterion's text after …, or when it is the criterion's 1-based position in the brief's list." → **Acceptance evidence: criterion matching**, with SHALL at a joint ("covers" becomes "SHALL cover"). Neither this sentence nor "The check is structural; …" has a SHALL. The first sentence and this one make 501 characters, so one of the two had to move without a SHALL sentence to carry it.

#### Block and wait

Stays in the MODIFIED description, unchanged: "`block` SHALL persist the question, …", "An operator answer SHALL be persisted before any resume.", "The task SHALL return to `running`, and the long-poll SHALL complete only after the scheduler admits it." and "When `maxWait` elapses, the task SHALL become `blocked` with the question preserved, and a later answer SHALL act as unblock-with-answer."

- "A dropped connection SHALL be recoverable by re-issuing `block` with the same `seq`, which returns the stored answer once admitted." → **Block and wait: replay after a dropped connection** (unchanged).
- "A runner whose CLI times out MCP tool calls SHALL size that timeout above `maxWait`." and "The Codex runner's default is `ceil(maxWaitMs/1000)+60` seconds." → **Block and wait: tool timeout above maxWait** (unchanged; the second is carried by the first). It stays apart from **MCP façade: tool timeout above maxWaitMs**, which holds the façade's own sentence.

#### Fallback file

Stays in the MODIFIED description, unchanged: "The brief and the MCP façade SHALL instruct the agent …", "The file SHALL carry `launchId`, `seq`, a kind of `submit`, `fail`, or `block`, and the body.", "Recovery SHALL apply the file when it finds the process dead." and "A fallback `block` SHALL be treated as a transition to `blocked` with the question."

- "A fallback `submit` SHALL be sealed the way a posted one is under the launch's commit policy; under `daemon`, the `agent.fallback` event SHALL carry `committedByOrchestrator: true` when a commit was made." → **Fallback file: fallback submit sealed by commit policy** (unchanged).

#### MCP façade

Stays in the MODIFIED description, unchanged: "A stdio MCP server launched per agent SHALL expose the five operations as tools, …" and "The `report` tool's description SHALL state that a submit requires a committed, clean worktree only when `ORCH_COMMIT_POLICY` is unset or `agent`."

- "Started with `--orch-env-file <path>`, the façade SHALL layer the file's `KEY=VALUE` lines over its environment." → **MCP façade: env file** (unchanged).
- "When the file is missing or unreadable, it SHALL exit 1 with a message naming the path." → **MCP façade: env file** ("it" made explicit as "the façade").
- "The flag is not `--env-file`, because Node takes that flag from anywhere in argv." → **MCP façade: env file** (unchanged; carried by the SHALL sentences before it).
- "The façade SHALL be in remote mode when `ORCH_ACCESS` is `remote`; the worker loop starts it so for a remote launch (see specs/worker-pool "Clone cache")." → **MCP façade: remote mode** (unchanged).
- "It then SHALL need `ORCH_WORKTREE` (the clone's path) and `ORCH_BRANCH` (the launch branch), and without either it SHALL exit 1 with a message naming the missing variable." → **MCP façade: remote mode** ("It" made explicit as "The façade in remote mode").
- "With any other `ORCH_ACCESS` it SHALL read neither variable and behave as without remote mode, since a spawned agent's environment carries `ORCH_WORKTREE` too." → **MCP façade: other access values** ("it" made explicit as "the façade").
- The list "In remote mode a `report` call with kind `submit` SHALL do three things before it calls the daemon, and the daemon's answer SHALL be returned unchanged:" with its three bullets (771 characters) is split between its items, with the lead-in repeated in each part. Each part names which of the three things it holds, so that it is right when read alone: the lead-in's colon becomes "; the first SHALL be:", "; the second SHALL be:" or "; the third SHALL be:" (SHALL at a joint). The clause "and the daemon's answer SHALL be returned unchanged" is kept in the first part only, because the second part with it would be 541 characters:
  - the lead-in and the bullet "the dirty check of the clone by the rule of a local seal (…): a dirty clone is answered `{ status: 409, error: "dirtyWorktree", files }`;" → **MCP façade: remote submit dirty check** (split, lead-in).
  - the lead-in and the bullet "`git push --force origin HEAD:refs/heads/<ORCH_BRANCH>`, … `HEAD` is pushed whatever branch the clone has checked out;" → **MCP façade: remote submit push** (split, lead-in).
  - the lead-in and the bullet "the full sha of `HEAD`, added to the body as `sealedSha`." → **MCP façade: remote submit names the pushed tip** (split, lead-in).
- "A git command that fails in the dirty check or while reading `HEAD` SHALL be answered `{ status: 500, error: "gitFailed", message }`." → **MCP façade: remote refusals** (unchanged).
- "After any of these refusals nothing is sent to the daemon, so the same call may be sent again with the same `seq`." → **MCP façade: remote refusals** ("these refusals" made explicit as "the `dirtyWorktree`, `pushFailed` and `gitFailed` refusals"; carried by the SHALL sentence before it).
- "The `report` tool's input schema SHALL NOT declare `sealedSha`: the façade always names the tip it pushed." → **MCP façade: remote submit names the pushed tip** (unchanged).
- "A `report` with kind `fail` and the other four tools SHALL be forwarded as without remote mode." → **MCP façade: remote mode forwards other calls** (unchanged).
- "In remote mode the `report` tool's description SHALL say that a submit needs committed work, …" and "The `--help` text SHALL name `ORCH_ACCESS`, `ORCH_WORKTREE` and `ORCH_BRANCH`." → **MCP façade: remote report description and help** (unchanged).
- "A runner whose CLI can treat an MCP server as optional or gate its tools behind approvals SHALL register the façade as required and with its tools pre-approved.", "For Codex this means `required=true`, plus the default and per-tool `approve` keys." and "OpenCode has no `required` analog (…); its tools are named `orchestrator_<tool>` and are pre-approved by the permission rule `"orchestrator_*": "allow"`." → **MCP façade: required and pre-approved registration** (unchanged; the second and third are carried by the first).
- "A runner whose CLI times out MCP calls SHALL size the tool timeout above `maxWaitMs`, so a `block` long-poll is not cut: Codex through `tool_timeout_sec`, OpenCode through `mcp.orchestrator.timeout` (its default is 60 000 ms)." → **MCP façade: tool timeout above maxWaitMs** (unchanged).

### Where each new scenario comes from

At the base commit 941ee02:

- "Definition of done by commit policy": `src/brief/compose.ts` (the Definition of done lines for `agent` and `daemon`), `test/loop/brief.test.ts` ("a claude-code launch under daemon commits gets the daemon text without a sandbox paragraph").
- "OpenSpec root detected in the worktree": `test/loop/brief.test.ts` ("detects the openspec root in the worktree").
- "Rule against direct spec edits for every kind": `test/loop/brief.test.ts` ("a brief for a repository with an openspec root carries the change-directory rule in its Definition of done"), `src/brief/compose.ts` (`OPENSPEC_CHANGE_RULE`).
- "Golden briefs carry no OpenSpec rule": `test/loop/brief.test.ts` (same test: no golden contains `openspec`).
- "Answer carried into the next launch": `test/slice/launch.test.ts` ("maxWait degrades to blocked; a later answer becomes a new launch with the answer in its brief"), `src/brief/compose.ts` ("Question asked earlier", "Human answer").
- "Conflict, interruption and revision under each policy": `test/loop/brief.test.ts` ("a codex launch under daemon commits gets the sandbox paragraph and read-only git text", "a codex launch under agent commits keeps the git-write sentences and names its sandbox").
- "Reporting section and brief.json": `src/brief/compose.ts` (the Reporting lines and the `apiBaseUrl`, `token` and `fallbackPath` fields of `brief.json`).
- "Remote brief kept on the launch row": `test/loop/remote-brief.test.ts` (`remoteLaunch` and "names the branch, base commit, integration branch, apiBaseUrl and the relative fallback path, and no daemon path or loopback address").
- "Remote workspace lines": `test/loop/remote-brief.test.ts` (same test), `src/brief/compose.ts` (the remote Workspace lines).
- "Remote submit line": `test/loop/remote-brief.test.ts` ("names the orchestrator MCP server's report tool as the one that pushes, and sealedSha for an agent that calls the API itself").
- "Trailing slash dropped": `test/loop/remote-brief.test.ts` (`apiBaseUrl` set with a trailing `/`; "briefJson carries the same branch, base commit, API URL and fallback path as the markdown"), `src/launch/launch.ts` (`remoteBrief`).
- "Interrupted remote brief without the merge text": `test/loop/remote-brief.test.ts` ("for an interrupted carry, names carry.interrupted.headSha as where the branch starts").
- "Remote run with a prepare command refused": `src/config.ts` (`remoteAccessProblems`), `test/slice/remote-access.test.ts` ("lists every unmet condition of a remote run"), `test/loop/remote-brief.test.ts` ("startup with runner.kind codex and the default codex.commit fails naming the commit policy").
- "Local brief keeps the worktree text": `test/loop/remote-brief.test.ts` ("a launch without access remote names the worktree and the absolute fallback path, with no push line").
- "OpenCode Reporting section names its tools", "OpenCode brief keeps the API", "Deny wording in the brief", "Ask instead of retrying" and "Patterns in order": `test/loop/brief.test.ts` ("an opencode brief under derived names the orchestrator_ tools, the deny wording, the derived patterns and the check command"), `test/fixtures/brief/opencode-derived.md`, `src/brief/compose.ts`.
- "Permission rules without a sandbox": `test/loop/brief.test.ts` (the same test and "an opencode brief under allow says every command is allowed and lists no patterns").
- "OpenCode runner in the brief input": `test/loop/brief.test.ts` ("fills the derived bash patterns, git first, and no allowedTools or sandbox", "under permission: allow fills no patterns").
- "Same text as claude-code": `test/loop/brief.test.ts` ("a claude-code launch and a brief without a runner write the same Definition of done and Workspace sections").
- "Daemon commit of an OpenCode submit": `test/slice/launch.test.ts` ("under runner.opencode.commit: daemon a dirty opencode submit is committed by the orchestrator and reaches done").
- "Malformed sealedSha": `test/slice/remote-seal.test.ts` ("a remote submit without sealedSha answers 400 naming the field, and a malformed one too").
- "Local seal reads the worktree": `test/slice/remote-seal.test.ts` ("a local submit ignores sealedSha"), `src/loop/orchestrator.ts` (`sealSubmission`).
- "Same seq after a dirty refusal": `test/slice/launch.test.ts` ("dirty submit gets 409, then succeeds with the same seq").
- "Numbered and loosely quoted entries": `test/loop/scenarios.test.ts` ("submission checks: dirty 409, undeclared empty fails, declared passes, missing evidence fails"), `src/agent/seal.ts` (`normaliseCriterion`, `checkSubmission`).
- "Same seq after the answer": `test/loop/scenarios.test.ts` ("waiting frees a slot and resume requires admission").
- "Codex default tool timeout": `test/runner/codex.test.ts` ("sizes the tool timeout a minute above maxWaitMs"), `src/runner/codex.ts`.
- "Daemon fallback submit records the commit": `test/loop/scenarios.test.ts` ("under codex the derived daemon policy commits a dirty worktree at submit and at a fallback submit").
- "Codex registers the façade with its env file": `test/runner/codex.test.ts` ("composes the verified flags, the shim registration, the approvals, and the timeouts, with no token").
- "Remote mode needs both variables", "ORCH_WORKTREE alone changes nothing" and "Remote description and help text": `test/slice/shim-remote.test.ts` ("at start: remote mode needs ORCH_BRANCH and ORCH_WORKTREE; the description and --help name the remote mode").
- "Untracked file refused": `test/slice/shim-remote.test.ts` ("a dirty clone answers 409 dirtyWorktree without a round trip; .orchestrator/ alone does not count").
- "Rewritten branch pushed with force": `test/slice/shim-remote.test.ts` ("a rewritten branch: after a shaMismatch refusal, the amended commit is pushed (forced) and accepted with the same seq").
- "Pushed HEAD forwarded as sealedSha": `test/slice/shim-remote.test.ts` ("an accepted submit: pushes the unpushed commit, names HEAD as sealedSha, and the task is submitted"), `src/agent/mcp-shim.ts` (the `report` input schema has no `sealedSha`).
- "Git failure without a round trip": `test/slice/shim-remote.test.ts` ("a git failure answers 500 gitFailed without a round trip").
- "Fail report in remote mode": `test/slice/shim-remote.test.ts` ("a fail report is forwarded as it is: nothing is pushed and no sealedSha is sent").
- "Codex and OpenCode registrations": `test/runner/codex.test.ts` (same test as the env file), `test/runner/opencode.test.ts` ("carries the shim, the timeout, snapshots off, sharing off, and the derived ruleset").
- "OpenCode timeout above maxWaitMs": `test/runner/opencode.test.ts` (same test: 90 500 gives 150 500, `toolTimeoutMs` 120 000 gives 120 000).

## Capabilities

### New Capabilities

### Modified Capabilities

- `agent-protocol`: "Standalone brief", "Submission sealing", "Acceptance evidence", "Block and wait", "Fallback file" and "MCP façade" have their descriptions cut to one behavior each; the moved behaviors become forty ADDED requirements. What the spec requires is unchanged.

## Impact

Only `openspec/changes/openspec-2-agent-protocol-1/`. No code changes.
