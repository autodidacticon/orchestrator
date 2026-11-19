## ADDED Requirements

### Requirement: Claude worker image
The repository SHALL carry `deploy/worker-claude/Dockerfile`, the Claude worker image: one stage `FROM ${PROJECT_BASE}` (default `orchestrator:dev`) that installs the Claude Code CLI at the build argument `CLAUDE_CODE_VERSION`, whose default the Dockerfile sets, runs as `node` with command `orchestrator-worker`, and sets `ORCH_WORKER_COMMAND` to a Claude template the worker loop composes. The image SHALL hold no key for the model. The daemon's `Dockerfile` is not changed.

#### Scenario: Image asserted without a Docker daemon
- **WHEN** `test/host/worker-image.test.ts` reads `deploy/worker-claude/Dockerfile`
- **THEN** its first instruction is `ARG PROJECT_BASE=orchestrator:dev`, its only `FROM` is `${PROJECT_BASE}`, `ARG CLAUDE_CODE_VERSION` and `USER root` stand after the `FROM` and before the `RUN` that installs the CLI at that version, the last `USER` is `node`, `CMD` is the exec form `["orchestrator-worker"]`, and there is no `ENTRYPOINT`

#### Scenario: Command template without an allow list
- **WHEN** the worker loop composes the image's `ORCH_WORKER_COMMAND` for a claim
- **THEN** it reads `claude -p --output-format json --mcp-config {mcpConfig} --strict-mcp-config --dangerously-skip-permissions --model {model} --effort {effort} --no-session-persistence < {brief}` with every slot filled; it has no `{allowedTools}` slot, because a remote brief carries no allow list, so every tool call of the agent is allowed and the container is the boundary, and a deployment that wants `--permission-mode acceptEdits` with an allow list sets its own `ORCH_WORKER_COMMAND`

#### Scenario: Git identity, no self-update, no key
- **WHEN** the Dockerfile is read
- **THEN** it sets `GIT_AUTHOR_NAME` and `GIT_COMMITTER_NAME` to `orchestrator-worker`, `GIT_AUTHOR_EMAIL` and `GIT_COMMITTER_EMAIL` to `worker@orchestrator.local`, and `DISABLE_AUTOUPDATER=1`, and no line of it holds `ANTHROPIC_`

#### Scenario: A project layers its toolchain
- **WHEN** a project builds an image from `orchestrator:dev` that installs its toolchain and passes it as `PROJECT_BASE`
- **THEN** the worker image is built on that image, with the toolchain, the CLI and `orchestrator-worker`

#### Scenario: Deploy notes describe the image
- **WHEN** a reader opens `deploy/README.md`
- **THEN** a section "Claude worker image" names `orchestrator-worker-claude:dev` and the build command `docker build -f deploy/worker-claude/Dockerfile -t orchestrator-worker-claude:dev deploy/worker-claude`, says how a project layers its toolchain through `PROJECT_BASE`, names `CLAUDE_CODE_VERSION` as the build argument that fixes the CLI version and says that the Dockerfile sets its default, gives the command template and says that the agent runs with every tool call allowed, names the git identity, and says that the key is never in the image; "The workers" says that the shim's `report` tool pushes the branch and names `sealedSha`
