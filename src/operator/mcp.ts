#!/usr/bin/env node
/**
 * Operator MCP server: the tools a host session uses to drive a run.
 * Full implementation in task group 5; this file holds the entrypoint and usage.
 */
import path from 'node:path';

export const USAGE = `orchestrator-mcp: operator MCP server for a host session.

  orchestrator-mcp [--repo <path>]

A stdio MCP server exposing start, stop, status, runs, import_issues,
import_graph, wait, review, answer, cancel, reopen, unblock, accept, reject,
pause, resume, logs, outbox, and ack. Forwards to the daemon over loopback HTTP; never opens
the store. The run is resolved from --repo, ORCH_REPO, or the git top level of
the working directory. ORCH_HOME overrides ~/.orchestrator.
`;

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isEntry && (process.argv.includes('--help') || process.argv.includes('-h'))) {
  process.stdout.write(USAGE);
} else if (isEntry) {
  import('./mcp-server.js')
    .then(({ startOperatorServer }) => startOperatorServer(process.argv.slice(2)))
    .catch((err) => {
      process.stderr.write(`${String(err)}\n`);
      process.exit(1);
    });
}
