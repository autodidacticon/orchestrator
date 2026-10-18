## ADDED Requirements

### Requirement: Codex brief reports through the MCP server
The brief of a `codex` launch SHALL tell the agent to call heartbeat, report, block, inbox and log through the `orchestrator` MCP server's tools, and not to call the agent API from a command (curl or a script), because the Codex sandbox refuses a command's network access while Codex runs the MCP server outside the sandbox. It SHALL keep the fallback report file for the case where an MCP tool call itself fails. A `claude-code` brief SHALL NOT carry this text.

#### Scenario: Codex brief names the MCP tools
- **WHEN** a brief is composed for a `codex` launch
- **THEN** its Reporting section names the `orchestrator` MCP server's tools and says not to call the API from a command

#### Scenario: Real Codex reports through the MCP server
- **WHEN** the opt-in e2e (`ORCH_E2E_CODEX=1`) runs four tasks under `workspace-write`
- **THEN** every task is published through an MCP `report`, no launch ends with `fallback:submit`, and the question task's log holds exactly one completed `block` item carrying the answer
