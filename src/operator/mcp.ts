#!/usr/bin/env node
/**
 * Operator MCP server: the tools a host session uses to drive a run.
 * Full implementation in task group 5; this file holds the entrypoint and usage.
 */
import { isEntrypoint } from '../entry.js';

export const USAGE = `orchestrator-mcp: operator MCP server for a host session.

  orchestrator-mcp [--repo <path>]

A stdio MCP server exposing start, stop, status, runs, configure, import_issues,
import_graph, wait, review, answer, cancel, reopen, unblock, accept, reject,
pause, resume, logs, outbox, ack, nudge, proposals, accept_proposal,
reject_proposal, and the worker tools claim, release, launch_heartbeat,
launch_report, launch_block, launch_inbox, launch_log. Forwards to the daemon over loopback HTTP; never opens
the store. The run is resolved from --repo, ORCH_REPO, or the git top level of
the working directory. ORCH_HOME overrides ~/.orchestrator.
`;

const isEntry = isEntrypoint(import.meta.url);
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
