# The Claude worker image: the orchestrator image (or a project image built from it) plus the Claude Code CLI, running
# the remote worker loop with a Claude agent. See deploy/README.md "Claude worker image".
#
#   docker build -f deploy/worker-claude/Dockerfile -t orchestrator-worker-claude:dev deploy/worker-claude
#
# A project layers its toolchain into an image built FROM orchestrator:dev and passes it as PROJECT_BASE.
# The model's credential is never in the image: the deployment supplies it to the pod at run time.
ARG PROJECT_BASE=orchestrator:dev
FROM ${PROJECT_BASE}

# The CLI version this image installs: an exact version, the one deploy/smoke.sh's pod printed (`claude --version`).
# Build another with --build-arg CLAUDE_CODE_VERSION=<version>.
ARG CLAUDE_CODE_VERSION=2.1.328
USER root
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
  && npm cache clean --force
USER node

# The pinned CLI does not replace itself at run time.
ENV DISABLE_AUTOUPDATER=1
# The agent's git identity, so its own `git commit` works (the scripted agent's identity).
ENV GIT_AUTHOR_NAME=orchestrator-worker \
    GIT_AUTHOR_EMAIL=worker@orchestrator.local \
    GIT_COMMITTER_NAME=orchestrator-worker \
    GIT_COMMITTER_EMAIL=worker@orchestrator.local
# The agent command the loop composes for each launch. No {allowedTools} slot: a remote brief carries no allow list,
# and every tool call is allowed, with the container as the boundary. A deployment that wants an allow list sets its
# own ORCH_WORKER_COMMAND (for instance with --permission-mode acceptEdits and --allowedTools).
ENV ORCH_WORKER_COMMAND="claude -p --output-format json --mcp-config {mcpConfig} --strict-mcp-config --dangerously-skip-permissions --model {model} --effort {effort} --no-session-persistence < {brief}"

CMD ["orchestrator-worker"]
