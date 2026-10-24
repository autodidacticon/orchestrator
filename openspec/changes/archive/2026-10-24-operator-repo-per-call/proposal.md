## Why

The CODEX-M5 review (2026-10-24, read at a094d2b) found that the operator server kept a call's `repo` only in the shared session state, and every handler read it back from there. MCP stdio servers handle requests concurrently, so with a call for repo A and a call for repo B in flight together, A's handler could reach B's daemon. A `wait` for A resolved the daemon again on every slice, so after a call with repo B it polled B's daemon with A's seq and returned B's events and digest. `launch_*` calls carrying tokens from A's daemon could be sent to B. Sessions that pass a single repo, which is what the Codex and OpenCode skills do, were not affected.

## What Changes

- The tool wrapper resolves each call's repository once, before the handler runs: the call's `repo`, else the repo the session last passed, else the server's default. Every request the handler forwards goes to that repository's daemon. A later call that names another repo does not move it.
- A `wait` polls the daemon of the repository it was bound to on every slice, for its whole duration.
- A call without `repo` is still served by the repo the session last passed.

## Capabilities

### Modified Capabilities
- `operator-mcp`: "Operator MCP server" binds every call to its repository once; "Wait tool" keeps polling that repository's daemon.

## Impact

- src/operator/mcp-server.ts (`OperatorClient.useRepo`, `at`, `repo`, `url`, `call`, `wait`, the `tool` wrapper and every handler), test/slice/operator-mcp.test.ts.
