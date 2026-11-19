## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. In `host-integration`, 27 of the 40 requirements are over the limit. This change, part 1 of 2 of the OpenSpec 2.1 migration of `host-integration` (ORC-156, under ORC-139), splits 13 of them the way OpenSpec 2.1 prescribes, without changing what the spec requires. "Codex host" is left for the later migration (OS2); the other long requirements are split by `openspec-2-host-integration-2`, which touches disjoint requirements.

## What Changes

- MODIFIED, 13 requirements: "Package entrypoints", "Per-host wrappers", "Skills", "Import skill records the tracker", "Run skill mirrors to the tracker", "Run skill handles proposals", "Work skill and workflow", "Marketplace manifest", "No native dependencies", "Plugin launcher", "Session start hook", "Session end hook", "Skills report the toolchain". Each keeps its header and every scenario, names and texts unchanged, and its description is cut to one behavior of at most 500 characters.
- ADDED, 72 requirements: each behavior removed from a description becomes a requirement of its own, with a name `host-integration` does not have and a prefix naming where it came from, a description of at most 500 characters, and at least one new scenario. Each new scenario states behavior the code has at e2e2197; the file that shows it is named below.
- Nothing is REMOVED or RENAMED, and no requirement outside the 13 is touched.

### How sentences moved

A sentence marked *unchanged* moved word for word. A sentence marked *explicit* moved with only its references made explicit (a pronoun, "the skill", "these rules", "the first", "both" or "the change" replaced by what it names). Eight sentences were longer than 500 characters on their own and cannot fit in one description: each is marked *split* and was cut at its own joints (a semicolon, a colon list, or the `(a)`/`(b)`/`(c)` list), every fragment keeping its words, with the sentence's lead-in repeated and its subject made explicit in each fragment. The split sentences are "Per-host wrappers" 3, "Import skill records the tracker" 2, "Run skill mirrors to the tracker" 2, "Work skill and workflow" 2, 7 and 11, "Plugin launcher" 1, and "Session start hook" 6 (counting from 1). The split of "Plugin launcher" 1 leaves in the MODIFIED description the sentence's head ending "from the first of three sources that applies", followed by new pointer wording, "(a), (b), and (c), each stated in a requirement of its own", naming the three ADDED requirements that hold the sources. No SHALL or MUST was dropped: the 13 original descriptions hold 152, the cut and ADDED descriptions 160, the extra ones coming from repeated lead-ins.


#### Package entrypoints

Stays in the MODIFIED description: sentence 1 (unchanged).


- "Package entrypoints: publishable package" (scenario from package.json; test/host/package.test.ts ('the plugin declares its server through the launcher and pins the published package')):
  - sentence 2, unchanged: "The package SHALL be publishable as `@autodidacticon/orchestrator`: not `private`, with `publishConfig.access` `public`, `prepublishOnly` running the build, and `files` covering `dist/src`, `hosts`, and `README.md`."

- "Package entrypoints: wrappers reach the package through the launcher" (scenario from hosts/claude-code/.mcp.json; hosts/claude-code/bin/orchestrator.mjs):
  - sentence 3, unchanged: "Host wrappers SHALL NOT reference executables by name on PATH; they SHALL reach the package through the plugin launcher, which resolves a checkout or the published package."

#### Per-host wrappers

Stays in the MODIFIED description: sentence 1 (unchanged), sentence 5 (explicit).

  - sentence 5, explicit: "The second SHALL be `hosts/codex/`, specified under "Codex host"." → "The second host SHALL be `hosts/codex/`, specified under "Codex host"."


- "Per-host wrappers: Claude Code plugin layout" (scenario from hosts/claude-code/.claude-plugin/plugin.json; hosts/claude-code/hooks/hooks.json; hosts/claude-code/skills/):
  - sentence 2, explicit: "The first SHALL be `hosts/claude-code/`, a Claude Code plugin named `orchestrator` with `.claude-plugin/plugin.json`, an `.mcp.json` declaring a server `operator` that runs `node ${CLAUDE_PLUGIN_ROOT}/bin/orchestrator.mjs mcp` with a tool-call `timeout` above the `wait` cap, hooks under `hooks/`, and skills under `skills/`." → "The first host SHALL be `hosts/claude-code/`, a Claude Code plugin named `orchestrator` with `.claude-plugin/plugin.json`, an `.mcp.json` declaring a server `operator` that runs `node ${CLAUDE_PLUGIN_ROOT}/bin/orchestrator.mjs mcp` with a tool-call `timeout` above the `wait` cap, hooks under `hooks/`, and skills under `skills/`."
  - sentence 4, unchanged: "The plugin SHALL pass `claude plugin validate --strict` and SHALL load with `claude --plugin-dir hosts/claude-code`."

- "Per-host wrappers: plugin package manifest" (scenario from hosts/claude-code/package.json):
  - sentence 3, split: "The plugin directory SHALL contain a private `package.json`, named for the plugin and not for the orchestrator package, whose only dependency is the published package pinned to the exact version in `.claude-plugin/plugin.json` (no range operator), together with a committed `package-lock.json` of lockfile version 2 or 3 that resolves exactly that dependency, so that a marketplace install triggers Claude Code's automatic dependency install into `${CLAUDE_PLUGIN_ROOT}/node_modules`; it SHALL declare no other dependency, and the plugin's `node_modules` SHALL be ignored by git." → "The plugin directory SHALL contain a private `package.json`, named for the plugin and not for the orchestrator package, whose only dependency is the published package pinned to the exact version in `.claude-plugin/plugin.json` (no range operator), together with a committed `package-lock.json` of lockfile version 2 or 3 that resolves exactly that dependency, so that a marketplace install triggers Claude Code's automatic dependency install into `${CLAUDE_PLUGIN_ROOT}/node_modules`."

- "Per-host wrappers: plugin dependencies" (scenario from hosts/claude-code/package.json; .gitignore; test/host/package.test.ts ('the plugin declares its server through the launcher and pins the published package')):
  - sentence 3, split: "The plugin directory SHALL contain a private `package.json`, named for the plugin and not for the orchestrator package, whose only dependency is the published package pinned to the exact version in `.claude-plugin/plugin.json` (no range operator), together with a committed `package-lock.json` of lockfile version 2 or 3 that resolves exactly that dependency, so that a marketplace install triggers Claude Code's automatic dependency install into `${CLAUDE_PLUGIN_ROOT}/node_modules`; it SHALL declare no other dependency, and the plugin's `node_modules` SHALL be ignored by git." → "The plugin directory's `package.json` SHALL declare no other dependency, and the plugin's `node_modules` SHALL be ignored by git."

#### Skills

Stays in the MODIFIED description: sentence 1 (unchanged).


- "Skills: import requires a tracker connector" (scenario from hosts/claude-code/skills/import/SKILL.md (section 1, section 5)):
  - sentence 2, unchanged: "`import` SHALL require a tracker connector: a Linear or Atlassian MCP server, or GitHub through a `gh` CLI whose `gh auth status` succeeds or a GitHub MCP server; it SHALL refuse with a clear message naming the three options otherwise, SHALL have the session fetch the root, its children, their blocking relations, and the state of every referenced issue, SHALL build normalized records, SHALL call `import_issues`, and SHALL report the summary including tasks missing criteria."

- "Skills: run starts the workflow" (scenario from hosts/claude-code/skills/run/SKILL.md (sections 1 and 1a)):
  - sentence 3, unchanged: "`run` SHALL call `start`."
  - sentence 4, unchanged: "When the mode in force is `pull` or `mixed` and the run can hold `claude-code` launches, `run` SHALL run the bundled `workflows/work.js` with a worker count no larger than the run's capacity and a run tag."

- "Skills: run monitor loop" (scenario from hosts/claude-code/skills/run/SKILL.md (sections 1a and 2)):
  - sentence 5, explicit: "It SHALL then loop on `wait`, surfacing each open question to the user and answering through `answer`, invoking the review skill when a milestone awaits review, re-running the workflow with the same run tag when it has ended while launches are still claimable, and stopping on finished or stalled with a report." → "`run` SHALL then loop on `wait`, surfacing each open question to the user and answering through `answer`, invoking the review skill when a milestone awaits review, re-running the workflow with the same run tag when it has ended while launches are still claimable, and stopping on finished or stalled with a report."

- "Skills: run says who executes the work" (scenario from hosts/claude-code/skills/run/SKILL.md (section 1)):
  - sentence 6, explicit: "It SHALL tell the user who is executing the work and SHALL offer `mode: spawn` as the explicit alternative." → "`run` SHALL tell the user who is executing the work and SHALL offer `mode: spawn` as the explicit alternative."

- "Skills: codex launches need spawn or mixed" (scenario from hosts/claude-code/skills/run/SKILL.md, hosts/claude-code/skills/work/SKILL.md, hosts/claude-code/skills/import/SKILL.md):
  - sentence 7, unchanged: "The `run`, `work`, and `import` skills SHALL state that codex launches are worked only in `spawn` or `mixed` mode, because pull-mode workers are the session's Claude subagents."
  - sentence 8, unchanged: "`run` SHALL NOT start the workflow for a run whose runner kind is `codex` unless its graph has `claude-code` tasks or `claimableByKind["claude-code"]` is above zero."

- "Skills: review decides with a note" (scenario from hosts/claude-code/skills/review/SKILL.md (sections 1 to 3)):
  - sentence 9, unchanged: "`review` SHALL call `review`, examine the diff and the closure reports against the acceptance criteria, and call `accept` or `reject` with a note."

- "Skills: work adds workers or switches the mode" (scenario from hosts/claude-code/skills/work/SKILL.md (front matter and section 1)):
  - sentence 10, unchanged: "`work` SHALL remain the explicit way to add workers from a session or to switch the mode."

- "Skills: Codex edition and its discovery" (scenario from hosts/codex/skills/; hosts/codex/README.md (section 2)):
  - sentence 11, explicit: "The Codex host's edition of `import`, `run`, and `review` SHALL follow these rules with the differences stated under "Codex host", and has no `work` skill." → "The Codex host's edition of `import`, `run`, and `review` SHALL follow the rules of "Skills" with the differences stated under "Codex host", and has no `work` skill."
  - sentence 12, unchanged: "Codex SHALL find that edition where it discovers skills: each skill linked or copied as `~/.codex/skills/<name>` (under `CODEX_HOME`), or as `.agents/skills/<name>` in a target repository that vendors them."

- "Skills: Codex README documents discovery" (scenario from hosts/codex/README.md (section 2)):
  - sentence 13, explicit: "`hosts/codex/README.md` SHALL document both, and SHALL say that a `[[skills.config]]` entry with a `path` only selects a skill Codex has already discovered (for example to disable it) and does not load one." → "`hosts/codex/README.md` SHALL document both places, `~/.codex/skills/<name>` and `.agents/skills/<name>`, and SHALL say that a `[[skills.config]]` entry with a `path` only selects a skill Codex has already discovered (for example to disable it) and does not load one."

- "Skills: OpenCode edition and its discovery" (scenario from hosts/opencode/README.md (section 2); hosts/opencode/skills/):
  - sentence 14, explicit: "The OpenCode host's edition of `import`, `run`, and `review` SHALL follow the same rules with the differences stated under "OpenCode host"." → "The OpenCode host's edition of `import`, `run`, and `review` SHALL follow the same rules of "Skills" with the differences stated under "OpenCode host"."
  - sentence 15, unchanged: "OpenCode SHALL find it where it discovers skills: each skill linked or copied as `~/.agents/skills/orchestrator-<name>`, or as `.opencode/skills/orchestrator-<name>` in a repository; `hosts/opencode/README.md` SHALL document both, and SHALL say not to link the Codex edition, which has the same names, into `~/.agents/skills` as well."

- "Skills: no PATH and digests only" (scenario from hosts/claude-code/skills/run/SKILL.md (opening paragraph); hosts/claude-code/skills/*/SKILL.md):
  - sentence 16, unchanged: "No skill SHALL instruct the user to put the package on PATH."
  - sentence 17, unchanged: "Skills SHALL keep digests, not raw events, in the conversation."

#### Import skill records the tracker

Stays in the MODIFIED description: sentence 1 (unchanged).


- "Import skill: GitHub root and children" (scenario from hosts/claude-code/skills/import/SKILL.md (section 2, GitHub)):
  - sentence 2, split: "For GitHub it SHALL build records as follows: the root is an issue named by number or URL, or a milestone; children are the root's sub-issues, or the milestone's issues; `blockedBy` comes from the issue's `blockedBy` dependencies, with every blocker outside the child set fetched for its state; ids are `GH-<number>` for issues in the tracker's repository and `GH-<owner>-<repo>-<number>` otherwise, a milestone root is `GH-M<number>`, and every record carries its `url`; `state` is `open` for an open issue, `inProgress` for an open issue carrying `inProgressLabel` when one is configured, `done` for a closed issue with reason `COMPLETED`, and `cancelled` for `NOT_PLANNED` or `DUPLICATE`; `priority` is the number from a `P0`..`P4` or `priority:<n>` label and is otherwise omitted; `labels` and `description` pass through." → "For GitHub the `import` skill SHALL build records as follows: the root is an issue named by number or URL, or a milestone; children are the root's sub-issues, or the milestone's issues; `blockedBy` comes from the issue's `blockedBy` dependencies, with every blocker outside the child set fetched for its state."

- "Import skill: GitHub record ids" (scenario from hosts/claude-code/skills/import/SKILL.md (section 3, GitHub records)):
  - sentence 2, split: "For GitHub it SHALL build records as follows: the root is an issue named by number or URL, or a milestone; children are the root's sub-issues, or the milestone's issues; `blockedBy` comes from the issue's `blockedBy` dependencies, with every blocker outside the child set fetched for its state; ids are `GH-<number>` for issues in the tracker's repository and `GH-<owner>-<repo>-<number>` otherwise, a milestone root is `GH-M<number>`, and every record carries its `url`; `state` is `open` for an open issue, `inProgress` for an open issue carrying `inProgressLabel` when one is configured, `done` for a closed issue with reason `COMPLETED`, and `cancelled` for `NOT_PLANNED` or `DUPLICATE`; `priority` is the number from a `P0`..`P4` or `priority:<n>` label and is otherwise omitted; `labels` and `description` pass through." → "For GitHub the `import` skill SHALL build records as follows: ids are `GH-<number>` for issues in the tracker's repository and `GH-<owner>-<repo>-<number>` otherwise, a milestone root is `GH-M<number>`, and every record carries its `url`."

- "Import skill: GitHub record fields" (scenario from hosts/claude-code/skills/import/SKILL.md (section 3)):
  - sentence 2, split: "For GitHub it SHALL build records as follows: the root is an issue named by number or URL, or a milestone; children are the root's sub-issues, or the milestone's issues; `blockedBy` comes from the issue's `blockedBy` dependencies, with every blocker outside the child set fetched for its state; ids are `GH-<number>` for issues in the tracker's repository and `GH-<owner>-<repo>-<number>` otherwise, a milestone root is `GH-M<number>`, and every record carries its `url`; `state` is `open` for an open issue, `inProgress` for an open issue carrying `inProgressLabel` when one is configured, `done` for a closed issue with reason `COMPLETED`, and `cancelled` for `NOT_PLANNED` or `DUPLICATE`; `priority` is the number from a `P0`..`P4` or `priority:<n>` label and is otherwise omitted; `labels` and `description` pass through." → "For GitHub the `import` skill SHALL build records as follows: `state` is `open` for an open issue, `inProgress` for an open issue carrying `inProgressLabel` when one is configured, `done` for a closed issue with reason `COMPLETED`, and `cancelled` for `NOT_PLANNED` or `DUPLICATE`; `priority` is the number from a `P0`..`P4` or `priority:<n>` label and is otherwise omitted; `labels` and `description` pass through."

- "Import skill: offer an in-progress label" (scenario from hosts/claude-code/skills/import/SKILL.md (section 4)):
  - sentence 3, unchanged: "When a repository has a label that looks like an in-progress marker and none is configured, the skill SHALL offer it."

- "Import skill: no empty epic" (scenario from hosts/claude-code/skills/import/SKILL.md (section 2)):
  - sentence 4, unchanged: "When the root has no sub-issues or milestone issues the skill SHALL say so and SHALL NOT import an empty epic."

- "Import skill: re-import sends current states" (scenario from hosts/claude-code/skills/import/SKILL.md (section 2); test/graph/diff.test.ts ('a done task may become a done external; ...')):
  - sentence 5, unchanged: "A re-import after the run has published tasks SHALL send the tracker's current states as they are: the daemon accepts a published task becoming a done external, and a task the tracker shows reopened is not reopened by import but by `reopen`."

#### Run skill mirrors to the tracker

Stays in the MODIFIED description: sentence 1 (unchanged), sentence 6 (unchanged).


- "Run skill mirrors: Linear and Jira states" (scenario from hosts/claude-code/skills/run/SKILL.md (section 2a, setState)):
  - sentence 2, split: "It SHALL map `setState` by state type, never by name: for Linear the workflow state of type `started`, `completed`, or `canceled`; for Jira a transition to a status in the category In Progress or Done, and to a canceled-type status when the workflow has one; for GitHub, acting on the effect's `url`, `done` closes the issue with reason `completed`, `cancelled` closes it with reason `not planned`, both removing the policy's `inProgressLabel` when the issue carries it, and `inProgress` reopens the issue when it is closed and adds the label, or is acknowledged as skipped when no label is configured." → "The `run` skill SHALL map `setState` by state type, never by name: for Linear the workflow state of type `started`, `completed`, or `canceled`; for Jira a transition to a status in the category In Progress or Done, and to a canceled-type status when the workflow has one."
  - sentence 3, unchanged: "When the tracker has no canceled-type state the skill SHALL leave the state and post a comment saying the task was cancelled."

- "Run skill mirrors: GitHub states" (scenario from hosts/claude-code/skills/run/SKILL.md (section 2a, setState)):
  - sentence 2, split: "It SHALL map `setState` by state type, never by name: for Linear the workflow state of type `started`, `completed`, or `canceled`; for Jira a transition to a status in the category In Progress or Done, and to a canceled-type status when the workflow has one; for GitHub, acting on the effect's `url`, `done` closes the issue with reason `completed`, `cancelled` closes it with reason `not planned`, both removing the policy's `inProgressLabel` when the issue carries it, and `inProgress` reopens the issue when it is closed and adds the label, or is acknowledged as skipped when no label is configured." → "The `run` skill SHALL map `setState` by state type, never by name: for GitHub, acting on the effect's `url`, `done` closes the issue with reason `completed`, `cancelled` closes it with reason `not planned`, both removing the policy's `inProgressLabel` when the issue carries it, and `inProgress` reopens the issue when it is closed and adds the label, or is acknowledged as skipped when no label is configured."

- "Run skill mirrors: GitHub milestone root" (scenario from hosts/claude-code/skills/run/SKILL.md (section 2a, setState and comment)):
  - sentence 4, unchanged: "For a GitHub milestone root, `done` SHALL close the milestone and `comment` effects SHALL be acknowledged as skipped."

- "Run skill mirrors: comments posted once" (scenario from hosts/claude-code/skills/run/SKILL.md (section 2a, comment)):
  - sentence 5, explicit: "Before posting a `comment` it SHALL list the issue's recent comments and, if one carries the effect's marker, SHALL `ack` with that comment's id instead of posting; otherwise it SHALL post the body with the marker as the last line and `ack` with the new comment's id." → "Before posting a `comment` the `run` skill SHALL list the issue's recent comments and, if one carries the effect's marker, SHALL `ack` with that comment's id instead of posting; otherwise it SHALL post the body with the marker as the last line and `ack` with the new comment's id."

- "Run skill mirrors: answers from comments" (scenario from hosts/claude-code/skills/run/SKILL.md (section 2b)):
  - sentence 7, unchanged: "When the policy's `answersFromComments` is true, the skill SHALL then, for every task in `openQuestions`, read the issue's comments, ignore any carrying the orchestrator marker, and relay through `answer` the first human comment posted after the latest marked comment that it has not relayed before, remembering what it relayed."
  - sentence 8, unchanged: "An `answer` the daemon refuses with 409 because the task is no longer `waiting` or `blocked` SHALL be reported to the user and not retried."

- "Run skill mirrors: GitHub proposal issue" (scenario from hosts/claude-code/skills/run/SKILL.md (section 2, proposals)):
  - sentence 9, unchanged: "On accepting a proposal in a GitHub run the skill SHALL create the issue as a sub-issue of the root, add a dependency on the proposing task's issue, and pass `GH-<number>` as `nodeId`."

- "Run skill mirrors: payloads stay out of the conversation" (scenario from hosts/claude-code/skills/run/SKILL.md (section 2a, closing line)):
  - sentence 10, unchanged: "The skill SHALL keep effect payloads out of the conversation except for a one-line count of what it applied."

#### Run skill handles proposals

Stays in the MODIFIED description: sentence 1 (unchanged), sentence 5 (unchanged).


- "Run skill proposals: accepting creates the node" (scenario from hosts/claude-code/skills/run/SKILL.md (section 2, proposals)):
  - sentence 2, unchanged: "On acceptance in a run imported from a tracker, the skill SHALL create the issue through the session's tracker tools as a child of the epic, blocked by the proposing task's issue, with a description that carries the acceptance criteria under the configured heading, and SHALL call `accept_proposal` with the new issue's identifier as `nodeId`."
  - sentence 3, explicit: "In a file-based run it SHALL call `accept_proposal` without `nodeId`." → "In a file-based run the skill SHALL call `accept_proposal` without `nodeId`."

- "Run skill proposals: rejection" (scenario from hosts/claude-code/skills/run/SKILL.md (section 2, proposals)):
  - sentence 4, explicit: "On rejection it SHALL call `reject_proposal` with the user's note." → "On rejection the run skill SHALL call `reject_proposal` with the user's note."

- "Run skill proposals: reopen with blockers" (scenario from hosts/claude-code/skills/run/SKILL.md (section 2c)):
  - sentence 6, unchanged: "When the user asks to reopen a task and `reopen` returns `blockers`, the skill SHALL show the blockers, offer `cascade`, and show the returned plan."

#### Work skill and workflow

Stays in the MODIFIED description: sentence 1 (unchanged), sentence 9 (unchanged).


- "Work skill: starting the workflow" (scenario from hosts/claude-code/skills/work/SKILL.md (sections 1 and 2)):
  - sentence 2, split: "The skill SHALL call `start` with mode `pull` or `mixed`, check that a graph is loaded, choose a worker count no larger than the run's capacity, run the workflow with the worker count, the run's `capacity`, and a run tag, and when the workflow returns: present open questions to the user, answer them through `answer`, and re-run the workflow with the same run tag; invoke the review skill for milestones awaiting review; and stop when the digest reports finished, or stalled with nothing claimable and nothing being prepared (`claimable` and `preparing` are 0)." → "The `work` skill SHALL call `start` with mode `pull` or `mixed`, check that a graph is loaded, choose a worker count no larger than the run's capacity, run the workflow with the worker count, the run's `capacity`, and a run tag."

- "Work skill: after the workflow returns" (scenario from hosts/claude-code/skills/work/SKILL.md (section 3)):
  - sentence 2, split: "The skill SHALL call `start` with mode `pull` or `mixed`, check that a graph is loaded, choose a worker count no larger than the run's capacity, run the workflow with the worker count, the run's `capacity`, and a run tag, and when the workflow returns: present open questions to the user, answer them through `answer`, and re-run the workflow with the same run tag; invoke the review skill for milestones awaiting review; and stop when the digest reports finished, or stalled with nothing claimable and nothing being prepared (`claimable` and `preparing` are 0)." → "When the workflow returns, the `work` skill SHALL: present open questions to the user, answer them through `answer`, and re-run the workflow with the same run tag; invoke the review skill for milestones awaiting review; and stop when the digest reports finished, or stalled with nothing claimable and nothing being prepared (`claimable` and `preparing` are 0)."

- "Work skill: codex launches left to the daemon" (scenario from hosts/claude-code/skills/work/SKILL.md (section 1)):
  - sentence 3, explicit: "The skill SHALL say that pull-mode workers are this session's Claude subagents, which claim only `claude-code` launches, so that codex launches are worked only in `spawn` or `mixed`; when only codex launches are parked it SHALL offer `start` with `mode: "spawn"` or `"mixed"` instead of running the workflow." → "The `work` skill SHALL say that pull-mode workers are this session's Claude subagents, which claim only `claude-code` launches, so that codex launches are worked only in `spawn` or `mixed`; when only codex launches are parked it SHALL offer `start` with `mode: "spawn"` or `"mixed"` instead of running the workflow."

- "Work workflow: claims only claude-code launches" (scenario from hosts/claude-code/workflows/work.js (claimPrompt)):
  - sentence 4, unchanged: "The workflow SHALL claim with `runner: "claude-code"`, so that codex-kind launches are never claimed by the Claude worker loop, and its stop rule SHALL count only `claimableByKind["claude-code"]` and `preparingByKind["claude-code"]` (0 when the status has no `preparingByKind`)."

- "Work workflow: clamp and fan-out" (scenario from hosts/claude-code/workflows/work.js):
  - sentence 5, unchanged: "The workflow SHALL clamp the worker count to the `capacity` argument when one is given, logging the clamp, and SHALL fan out one loop per worker with `parallel`."

- "Work workflow: claimer agent" (scenario from hosts/claude-code/workflows/work.js (claimPrompt, loop)):
  - sentence 6, unchanged: "Each cycle SHALL run a claimer agent on the model named by the `claimModel` argument at the effort named by `claimEffort`, defaulting to `claude-haiku-5-5` at `low`, labelled `claim <workerId>`; the claimer SHALL claim with the loop's worker id and, when nothing is claimable, SHALL wait for up to 90 seconds with `until: "any"`, read `status`, evaluate the stop rule, and claim again, up to three polls before returning without a launch."

- "Work workflow: worker agent" (scenario from hosts/claude-code/workflows/work.js (loop, workerPrompt)):
  - sentence 7, split: "On a claim the loop SHALL run a worker agent labelled `work <workerId> <taskId>` with the claim's `model` and `effort` as the agent's model and effort options, whose prompt is composed from the brief plus tool instructions: work in the worktree with ordinary tools, commit on the launch branch, ask questions through `launch_block` and call it again while pending, report through `launch_report`, commit and resubmit with the same seq on a 409 dirty-worktree rejection, never write the fallback file, and stop on 401." → "On a claim the loop SHALL run a worker agent labelled `work <workerId> <taskId>` with the claim's `model` and `effort` as the agent's model and effort options, whose prompt is composed from the brief plus tool instructions."

- "Work workflow: worker tool instructions" (scenario from hosts/claude-code/workflows/work.js (workerPrompt)):
  - sentence 7, split: "On a claim the loop SHALL run a worker agent labelled `work <workerId> <taskId>` with the claim's `model` and `effort` as the agent's model and effort options, whose prompt is composed from the brief plus tool instructions: work in the worktree with ordinary tools, commit on the launch branch, ask questions through `launch_block` and call it again while pending, report through `launch_report`, commit and resubmit with the same seq on a 409 dirty-worktree rejection, never write the fallback file, and stop on 401." → "On a claim the loop SHALL run a worker agent whose prompt is composed from the brief plus tool instructions: work in the worktree with ordinary tools, commit on the launch branch, ask questions through `launch_block` and call it again while pending, report through `launch_report`, commit and resubmit with the same seq on a 409 dirty-worktree rejection, never write the fallback file, and stop on 401."

- "Work workflow: loop end" (scenario from hosts/claude-code/workflows/work.js (claimPrompt stop rule)):
  - sentence 8, unchanged: "A loop SHALL end when nothing is claimable, nothing is being prepared for `claude-code`, no loop holds a launch, and the digest reports finished, stalled, or an open question."

- "Work skill: claimer options and worktree access" (scenario from hosts/claude-code/skills/work/SKILL.md (section 2); hosts/claude-code/skills/run/SKILL.md (section 1a)):
  - sentence 10, unchanged: "The `work` and `run` skills SHALL document `claimModel` and `claimEffort` with their defaults and pass them only when the user asks for a different claimer, and SHALL say that workers edit worktrees under the run directory, outside the repository, so a session in `acceptEdits` mode prompts for each file there unless started with `--add-dir` for that directory."

- "Work skill: workflow script passed inline" (scenario from hosts/claude-code/skills/work/SKILL.md, hosts/claude-code/skills/run/SKILL.md; test/host/work-loop.test.ts ('Claude Code skills start the work workflow inline (ORC-140)')):
  - sentence 11, split: "The `work` and `run` skills SHALL tell the session to read `workflows/work.js` from the plugin directory and pass its whole text as the Workflow tool's `script` input with the workflow's `args`, because the Workflow tool refuses a `scriptPath` outside the working directory and added directories; they SHALL present `scriptPath` with the plugin path only as an alternative when the plugin directory has been added with `/add-dir`, and SHALL say that after one inline run the tool returns a saved script path that a re-run with the same run tag may use." → "The `work` and `run` skills SHALL tell the session to read `workflows/work.js` from the plugin directory and pass its whole text as the Workflow tool's `script` input with the workflow's `args`, because the Workflow tool refuses a `scriptPath` outside the working directory and added directories."

- "Work skill: scriptPath as the alternative" (scenario from hosts/claude-code/skills/work/SKILL.md, hosts/claude-code/skills/run/SKILL.md; test/host/work-loop.test.ts ('Claude Code skills start the work workflow inline (ORC-140)')):
  - sentence 11, split: "The `work` and `run` skills SHALL tell the session to read `workflows/work.js` from the plugin directory and pass its whole text as the Workflow tool's `script` input with the workflow's `args`, because the Workflow tool refuses a `scriptPath` outside the working directory and added directories; they SHALL present `scriptPath` with the plugin path only as an alternative when the plugin directory has been added with `/add-dir`, and SHALL say that after one inline run the tool returns a saved script path that a re-run with the same run tag may use." → "The `work` and `run` skills SHALL present `scriptPath` with the plugin path only as an alternative when the plugin directory has been added with `/add-dir`, and SHALL say that after one inline run the tool returns a saved script path that a re-run with the same run tag may use."

#### Marketplace manifest

Stays in the MODIFIED description: sentence 1 (unchanged).


- "Marketplace manifest: self-contained install" (scenario from hosts/claude-code/bin/orchestrator.mjs (resolve); test/host/package.test.ts ('the launcher resolves a checkout, a plugin-local copy, and npx, ...')):
  - sentence 2, unchanged: "Because a marketplace install copies only the plugin directory, the installed plugin SHALL be self-contained: the plugin-local install from its `package.json` and lockfile SHALL provide the package, and the launcher SHALL fall back to the published package at the plugin manifest's version through `npx` when that tree is missing or incomplete."

- "Marketplace manifest: versions agree" (scenario from test/host/package.test.ts ('ships a marketplace manifest ...', 'the plugin declares its server ...', 'the plugin lockfile resolves the pinned package')):
  - sentence 3, unchanged: "The plugin manifest version, the package version, and the pin in the plugin's `package.json` SHALL be equal, the launcher's package name and the pinned dependency SHALL equal the package name `@autodidacticon/orchestrator`, the lockfile SHALL be present and consistent with the pin, and a test SHALL assert all of it."

- "Marketplace manifest: plugin validates with every part" (scenario from test/host/package.test.ts ('ships a marketplace manifest whose plugin version matches the package, and the plugin validates with the work skill and workflow')):
  - sentence 4, unchanged: "The plugin SHALL still pass `claude plugin validate --strict` with the work skill, the workflow, the launcher, the plugin manifest, and the hooks present."

#### No native dependencies

Stays in the MODIFIED description: sentence 1 (unchanged), sentence 4 (unchanged).


- "No native dependencies: Postgres driver" (scenario from package.json; package-lock.json; test/host/package.test.ts ('the production dependency tree has no native module')):
  - sentence 2, unchanged: "The Postgres driver `pg` is allowed because it is pure JavaScript (its dependencies, including the optional `pg-cloudflare`, carry no install script); its optional native peer `pg-native` SHALL NOT be a dependency or be installed."

- "No native dependencies: built-in SQLite" (scenario from package.json; test/host/package.test.ts ('the production dependency tree has no native module')):
  - sentence 3, unchanged: "The store SHALL use Node's built-in `node:sqlite` binding, and `engines.node` SHALL be `>=22.13.0`, the first release that loads `node:sqlite` without a flag."

#### Plugin launcher

Stays in the MODIFIED description: sentence 1 (split).

  - sentence 1, split: "The plugin SHALL ship `bin/orchestrator.mjs`, a dependency-free ES module that locates the plugin directory from its own module URL, takes `mcp`, `ctl`, `daemon`, or `shim` as its first argument, and runs the corresponding package executable from the first of three sources that applies: (a) a repository checkout, recognised when the plugin directory's grandparent holds a `package.json` whose `name` is the published package name `@autodidacticon/orchestrator`, running `dist/src/<entry>.js` when present and otherwise the TypeScript entry through the checkout's `tsx` loader; (b) the plugin-local copy, `<plugin>/node_modules/<name>/dist/src/<entry>.js`, when that file exists; (c) the published package through `npx --yes --package=<name>@<version> <executable>`, using the `npx` beside the running Node and the version from `.claude-plugin/plugin.json`, when the plugin-local tree is missing or incomplete." → "The plugin SHALL ship `bin/orchestrator.mjs`, a dependency-free ES module that locates the plugin directory from its own module URL, takes `mcp`, `ctl`, `daemon`, or `shim` as its first argument, and runs the corresponding package executable from the first of three sources that applies, (a), (b), and (c), each stated in a requirement of its own ("Plugin launcher: checkout source", "Plugin launcher: plugin-local source", "Plugin launcher: npx source")."


- "Plugin launcher: checkout source" (scenario from hosts/claude-code/bin/orchestrator.mjs (resolve); test/host/package.test.ts ('the launcher resolves a checkout, ...')):
  - sentence 1, split: "The plugin SHALL ship `bin/orchestrator.mjs`, a dependency-free ES module that locates the plugin directory from its own module URL, takes `mcp`, `ctl`, `daemon`, or `shim` as its first argument, and runs the corresponding package executable from the first of three sources that applies: (a) a repository checkout, recognised when the plugin directory's grandparent holds a `package.json` whose `name` is the published package name `@autodidacticon/orchestrator`, running `dist/src/<entry>.js` when present and otherwise the TypeScript entry through the checkout's `tsx` loader; (b) the plugin-local copy, `<plugin>/node_modules/<name>/dist/src/<entry>.js`, when that file exists; (c) the published package through `npx --yes --package=<name>@<version> <executable>`, using the `npx` beside the running Node and the version from `.claude-plugin/plugin.json`, when the plugin-local tree is missing or incomplete." → "The plugin launcher SHALL run the corresponding package executable from the first of three sources that applies: (a) a repository checkout, recognised when the plugin directory's grandparent holds a `package.json` whose `name` is the published package name `@autodidacticon/orchestrator`, running `dist/src/<entry>.js` when present and otherwise the TypeScript entry through the checkout's `tsx` loader."

- "Plugin launcher: plugin-local source" (scenario from hosts/claude-code/bin/orchestrator.mjs (resolve)):
  - sentence 1, split: "The plugin SHALL ship `bin/orchestrator.mjs`, a dependency-free ES module that locates the plugin directory from its own module URL, takes `mcp`, `ctl`, `daemon`, or `shim` as its first argument, and runs the corresponding package executable from the first of three sources that applies: (a) a repository checkout, recognised when the plugin directory's grandparent holds a `package.json` whose `name` is the published package name `@autodidacticon/orchestrator`, running `dist/src/<entry>.js` when present and otherwise the TypeScript entry through the checkout's `tsx` loader; (b) the plugin-local copy, `<plugin>/node_modules/<name>/dist/src/<entry>.js`, when that file exists; (c) the published package through `npx --yes --package=<name>@<version> <executable>`, using the `npx` beside the running Node and the version from `.claude-plugin/plugin.json`, when the plugin-local tree is missing or incomplete." → "The plugin launcher SHALL run the corresponding package executable from the first of three sources that applies: (b) the plugin-local copy, `<plugin>/node_modules/<name>/dist/src/<entry>.js`, when that file exists."

- "Plugin launcher: npx source" (scenario from hosts/claude-code/bin/orchestrator.mjs (resolve); test/host/package.test.ts ('the launcher resolves a checkout, ...')):
  - sentence 1, split: "The plugin SHALL ship `bin/orchestrator.mjs`, a dependency-free ES module that locates the plugin directory from its own module URL, takes `mcp`, `ctl`, `daemon`, or `shim` as its first argument, and runs the corresponding package executable from the first of three sources that applies: (a) a repository checkout, recognised when the plugin directory's grandparent holds a `package.json` whose `name` is the published package name `@autodidacticon/orchestrator`, running `dist/src/<entry>.js` when present and otherwise the TypeScript entry through the checkout's `tsx` loader; (b) the plugin-local copy, `<plugin>/node_modules/<name>/dist/src/<entry>.js`, when that file exists; (c) the published package through `npx --yes --package=<name>@<version> <executable>`, using the `npx` beside the running Node and the version from `.claude-plugin/plugin.json`, when the plugin-local tree is missing or incomplete." → "The plugin launcher SHALL run the corresponding package executable from the first of three sources that applies: (c) the published package through `npx --yes --package=<name>@<version> <executable>`, using the `npx` beside the running Node and the version from `.claude-plugin/plugin.json`, when the plugin-local tree is missing or incomplete."

- "Plugin launcher: Node floor" (scenario from hosts/claude-code/bin/orchestrator.mjs (main); test/host/package.test.ts ('... checks the Node floor ...')):
  - sentence 2, explicit: "Before spawning, it SHALL compare `process.versions.node` with the package's `engines.node` floor and, when the running Node is older, SHALL print one line naming the running version and the floor to stderr and exit 1, so that a Node too old for `node:sqlite` fails with a readable message rather than `ERR_UNKNOWN_BUILTIN_MODULE`." → "Before spawning, the plugin launcher SHALL compare `process.versions.node` with the package's `engines.node` floor and, when the running Node is older, SHALL print one line naming the running version and the floor to stderr and exit 1, so that a Node too old for `node:sqlite` fails with a readable message rather than `ERR_UNKNOWN_BUILTIN_MODULE`."

- "Plugin launcher: spawn and dry run" (scenario from hosts/claude-code/bin/orchestrator.mjs (main)):
  - sentence 3, explicit: "It SHALL spawn the resolved command with inherited stdio, forward `SIGTERM`, `SIGINT`, and `SIGHUP`, exit with the child's code, and, when `ORCH_LAUNCHER_DRY_RUN` is set, print the chosen source (`checkout`, `plugin`, or `npx`) and the resolved command as JSON instead of running it." → "The plugin launcher SHALL spawn the resolved command with inherited stdio, forward `SIGTERM`, `SIGINT`, and `SIGHUP`, exit with the child's code, and, when `ORCH_LAUNCHER_DRY_RUN` is set, print the chosen source (`checkout`, `plugin`, or `npx`) and the resolved command as JSON instead of running it."

- "Plugin launcher: package name constant" (scenario from hosts/claude-code/bin/orchestrator.mjs (PACKAGE_NAME); test/host/package.test.ts ('the plugin declares its server through the launcher ...')):
  - sentence 4, unchanged: "The package name constant in the launcher SHALL equal `package.json` `name`, and a host test SHALL assert it."

- "Plugin launcher: daemon and shim from the same tree" (scenario from src/runs/lifecycle.ts (daemonCommand)):
  - sentence 5, unchanged: "The daemon and the agent shim SHALL keep resolving from the tree the server runs in, so that a launcher-started server spawns a daemon from the same checkout, the same plugin-local tree, or the same `npx` installation."

- "Plugin launcher: host copies" (scenario from hosts/codex/bin/orchestrator.mjs; hosts/opencode/bin/orchestrator.mjs; test/host/codex-host.test.ts ('the launcher is the Claude Code launcher but for its version source'); test/host/opencode-host.test.ts ('the launcher is the Claude Code and Codex launchers but for its version source')):
  - sentence 6, explicit: "The Codex host and the OpenCode host SHALL each ship a copy, `hosts/codex/bin/orchestrator.mjs` and `hosts/opencode/bin/orchestrator.mjs`, that differs from the plugin's only in the version source of (c): the published package's dependency pin in that host's own `package.json`, never `.claude-plugin/plugin.json`." → "The Codex host and the OpenCode host SHALL each ship a copy, `hosts/codex/bin/orchestrator.mjs` and `hosts/opencode/bin/orchestrator.mjs`, that differs from the plugin's only in the version source of (c), the published package through `npx`: the published package's dependency pin in that host's own `package.json`, never `.claude-plugin/plugin.json`."
  - sentence 7, unchanged: "The two host copies SHALL be identical but for comments, and a host test SHALL assert both facts."

#### Session start hook

Stays in the MODIFIED description: sentence 1 (unchanged), sentence 2 (unchanged).


- "Session start hook: Codex and OpenCode" (scenario from hosts/codex/config.toml; test/host/codex-host.test.ts ('the config template declares the session hooks ...')):
  - sentence 3, explicit: "The Codex host declares it as `[[hooks.SessionStart]]` with the same matcher in `hosts/codex/config.toml`, which SHALL also set `features.hooks = true` and say that Codex runs a hook only once it is trusted." → "The Codex host declares `hooks/session-start.mjs` as `[[hooks.SessionStart]]` with the same matcher as the Claude Code plugin in `hosts/codex/config.toml`, which SHALL also set `features.hooks = true` and say that Codex runs a hook only once it is trusted."
  - sentence 4, unchanged: "OpenCode has no hook configuration, so the OpenCode host runs the script from its plugin on `session.created` ("OpenCode host")."

- "Session start hook: one script, no package code" (scenario from hosts/claude-code/hooks/session-start.mjs; test/host/codex-host.test.ts and test/host/opencode-host.test.ts ('the hook scripts are the Claude Code plugin's, byte for byte')):
  - sentence 5, explicit: "The hosts' copies of the script SHALL be identical." → "The hosts' copies of `hooks/session-start.mjs` SHALL be identical."
  - sentence 7, explicit: "It SHALL load no package code, SHALL need nothing on PATH but `node`, and SHALL exit 0 whatever happens." → "The session start script SHALL load no package code, SHALL need nothing on PATH but `node`, and SHALL exit 0 whatever happens."

- "Session start hook: reading runs" (scenario from hosts/claude-code/hooks/session-start.mjs (probe, describe)):
  - sentence 6, split: "The script SHALL read every run directory under `ORCH_HOME` (default `~/.orchestrator`), SHALL probe an alive daemon with `GET /v1/status?probe=1` and a one-second timeout, SHALL print one line naming each run whose daemon is alive (with its running, waiting, parked, attached, awaiting-review, and open-question counts) or whose daemon is dead with an exit record showing parked launches, open questions, a milestone awaiting review, or a stall (with the exit reason and age) or with no exit record (as not stopped cleanly), ending with how to continue, and SHALL print nothing when no run qualifies." → "The session start script SHALL read every run directory under `ORCH_HOME` (default `~/.orchestrator`), and SHALL probe an alive daemon with `GET /v1/status?probe=1` and a one-second timeout."

- "Session start hook: the line" (scenario from hosts/claude-code/hooks/session-start.mjs (describe, main)):
  - sentence 6, split: "The script SHALL read every run directory under `ORCH_HOME` (default `~/.orchestrator`), SHALL probe an alive daemon with `GET /v1/status?probe=1` and a one-second timeout, SHALL print one line naming each run whose daemon is alive (with its running, waiting, parked, attached, awaiting-review, and open-question counts) or whose daemon is dead with an exit record showing parked launches, open questions, a milestone awaiting review, or a stall (with the exit reason and age) or with no exit record (as not stopped cleanly), ending with how to continue, and SHALL print nothing when no run qualifies." → "The session start script SHALL print one line naming each run whose daemon is alive (with its running, waiting, parked, attached, awaiting-review, and open-question counts) or whose daemon is dead with an exit record showing parked launches, open questions, a milestone awaiting review, or a stall (with the exit reason and age) or with no exit record (as not stopped cleanly), ending with how to continue, and SHALL print nothing when no run qualifies."

#### Session end hook

Stays in the MODIFIED description: sentence 1 (unchanged), sentence 2 (unchanged), sentence 3 (unchanged).


- "Session end hook: the reason" (scenario from hosts/claude-code/hooks/session-end.mjs (main)):
  - sentence 5, explicit: "The script SHALL read the hook input for `reason`, and SHALL use `sessionEnded` when the input has none or is not JSON." → "The session end script SHALL read the hook input for `reason`, and SHALL use `sessionEnded` when the input has none or is not JSON."
  - sentence 8, unchanged: "The hook is not needed to release a session's launches."
  - sentence 9, unchanged: "The operator server ends its own attachment when its stdio closes, and the daemon ends attachments whose first pid is dead (operator-control "Session attachments")."
  - sentence 10, unchanged: "What the hook adds is the host's reason."

- "Session end hook: posting the ancestry" (scenario from hosts/claude-code/hooks/session-end.mjs (ancestry, main); test/host/codex-host.test.ts ('the hook scripts are the Claude Code plugin's, byte for byte')):
  - sentence 4, explicit: "The hosts' copies of the script SHALL be identical." → "The hosts' copies of `hooks/session-end.mjs` SHALL be identical."
  - sentence 6, explicit: "It SHALL collect its own ancestor process ids up to six levels within 300 ms, SHALL post `{ pids, reason }` to `POST /v1/attachments/ended` of every alive daemon under `ORCH_HOME` in parallel with 400 ms timeouts, SHALL NOT wait for any release, and SHALL exit 0 within the SessionEnd budget whatever happens." → "The session end script SHALL collect its own ancestor process ids up to six levels within 300 ms, SHALL post `{ pids, reason }` to `POST /v1/attachments/ended` of every alive daemon under `ORCH_HOME` in parallel with 400 ms timeouts, SHALL NOT wait for any release, and SHALL exit 0 within the SessionEnd budget whatever happens."
  - sentence 7, explicit: "It SHALL load no package code." → "The session end script SHALL load no package code."

#### Skills report the toolchain

Stays in the MODIFIED description: sentence 1 (unchanged), sentence 2 (unchanged).


- "Toolchain report: defaults by kind" (scenario from hosts/claude-code/skills/run/SKILL.md, hosts/claude-code/skills/work/SKILL.md (section 1)):
  - sentence 3, explicit: "The default named SHALL be the one of the kind in force: `claude-opus-5-5` at `medium` for `claude-code`, `gpt-6-astra` at `medium` for `codex`, `anthropic/claude-opus-5-5` at `medium` for `opencode`." → "The default named in the toolchain line SHALL be the one of the kind in force: `claude-opus-5-5` at `medium` for `claude-code`, `gpt-6-astra` at `medium` for `codex`, `anthropic/claude-opus-5-5` at `medium` for `opencode`."

- "Toolchain report: allow-list and model parts" (scenario from hosts/claude-code/skills/run/SKILL.md (section 1)):
  - sentence 4, explicit: "For a `claude-code` run whose daemon spawns agents, the line SHALL also name the toolchains whose commands agents may run (for example "detected: npm test on main; workers claude-opus-5-5 at medium (default); agents may run npm and node")." → "For a `claude-code` run whose daemon spawns agents, the toolchain line SHALL also name the toolchains whose commands agents may run (for example "detected: npm test on main; workers claude-opus-5-5 at medium (default); agents may run npm and node")."
  - sentence 14, explicit: "When launches are worked by session subagents the allow-list part of the report SHALL be omitted; when the runner command does not apply `model` or `effort` the model part SHALL be omitted." → "When launches are worked by session subagents the allow-list part of the toolchain report SHALL be omitted; when the runner command does not apply `model` or `effort` the model part SHALL be omitted."

- "Toolchain report: Codex line" (scenario from hosts/claude-code/skills/run/SKILL.md (section 1), hosts/claude-code/skills/import/SKILL.md (section 1)):
  - sentence 5, explicit: "For a `codex` run the line SHALL name the kind, the sandbox, and the commit policy, and SHALL have no allow-list part (for example "detected: npm test on main; workers codex gpt-6-astra at medium (file); sandbox workspace-write, daemon commits")." → "For a `codex` run the toolchain line SHALL name the kind, the sandbox, and the commit policy, and SHALL have no allow-list part (for example "detected: npm test on main; workers codex gpt-6-astra at medium (file); sandbox workspace-write, daemon commits")."

- "Toolchain report: OpenCode line" (scenario from hosts/claude-code/skills/run/SKILL.md (section 1), hosts/claude-code/skills/work/SKILL.md (section 1)):
  - sentence 6, explicit: "For an `opencode` run the line SHALL name the kind, the permission, and the commit policy, and SHALL have no allow-list part (for example "detected: npm test on main; workers opencode anthropic/claude-opus-5-5 at medium (default); permission derived, agent commits")." → "For an `opencode` run the toolchain line SHALL name the kind, the permission, and the commit policy, and SHALL have no allow-list part (for example "detected: npm test on main; workers opencode anthropic/claude-opus-5-5 at medium (default); permission derived, agent commits")."

- "Toolchain report: resolving the check command" (scenario from hosts/claude-code/skills/run/SKILL.md (section 1b)):
  - sentence 7, explicit: "When `needsConfig` names `checkCommand`, in the `start` result or in a later `wait` digest, the skill SHALL look for the test command in `CLAUDE.md`, the README, and the manifests in the repository root; when one is stated unambiguously it SHALL set it through `configure` and report the command and where it found it; otherwise it SHALL propose its best reading, or say it found none, and SHALL set what the user confirms." → "When `needsConfig` names `checkCommand`, in the `start` result or in a later `wait` digest, the `run`, `import`, and `work` skills SHALL look for the test command in `CLAUDE.md`, the README, and the manifests in the repository root; when one is stated unambiguously the skill SHALL set it through `configure` and report the command and where it found it; otherwise it SHALL propose its best reading, or say it found none, and SHALL set what the user confirms."

- "Toolchain report: check command never left unresolved" (scenario from hosts/claude-code/skills/run/SKILL.md (sections 1b and 2, needsConfig)):
  - sentence 8, explicit: "It SHALL NOT leave `checkCommand` unresolved while a task is `submitted` without having asked the user." → "The `run`, `import`, and `work` skills SHALL NOT leave `checkCommand` unresolved while a task is `submitted` without having asked the user."

- "Toolchain report: access question offers" (scenario from hosts/claude-code/skills/run/SKILL.md (section 2, openQuestions)):
  - sentence 9, unchanged: "In the `run` skill, when an agent asks a `needsAccess` question naming a command, the skill SHALL offer a configuration change through `configure` for subsequent launches, SHALL say that the live agent cannot gain it, and SHALL offer to run the command on the agent's behalf and answer with the result."

- "Toolchain report: access change by kind" (scenario from hosts/claude-code/skills/run/SKILL.md (section 2, openQuestions)):
  - sentence 10, explicit: "The change SHALL be the one for the launch's kind: an `allowedTools` rule for `claude-code`, a wider `sandbox` for `codex`, and `permission: "allow"` for `opencode`, whose `derived` permission rejects a command outside the derived rules automatically." → "The configuration change the `run` skill offers for a `needsAccess` question SHALL be the one for the launch's kind: an `allowedTools` rule for `claude-code`, a wider `sandbox` for `codex`, and `permission: "allow"` for `opencode`, whose `derived` permission rejects a command outside the derived rules automatically."

- "Toolchain report: labels and keys documented" (scenario from hosts/claude-code/skills/import/SKILL.md (sections 3 and 5), hosts/claude-code/skills/run/SKILL.md (section 1)):
  - sentence 11, unchanged: "The `import` skill SHALL document the `runner:<kind>`, `model:<name>`, and `effort:<level>` labels as the way an issue chooses its worker kind, model, and effort, and SHALL report any `ignoredLabels` from the import summary to the user."
  - sentence 12, unchanged: "The `import` skill's labels SHALL name the three kinds."
  - sentence 13, unchanged: "The `run` skill SHALL document `runner.kind`, `runner.codex.*`, `runner.opencode.*`, and `budgets.prices`."


## Capabilities

### New Capabilities

### Modified Capabilities

- `host-integration`: 13 long requirements cut to one behavior each; the behaviors removed from them added as requirements of their own.

## Impact

Spec text only. No code, test or other spec changes. The change is archived after the milestone review; archiving appends the ADDED requirements at the end of `openspec/specs/host-integration/spec.md`.
