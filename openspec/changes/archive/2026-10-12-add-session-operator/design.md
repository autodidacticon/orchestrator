## Context

v1 is a working daemon with a CLI, verified by a crash-injection suite and a real Claude Code run. The intended user sits inside a coding-agent session with a tracker connected. Conversation 10 (2026-10-12) decided how that session imports an epic, starts a run, and monitors it, and how the project is packaged for Claude Code first and other hosts later. Constraints: the daemon needs a native SQLite module, so it must run from an installed package; a session cannot be pushed to, so monitoring is a bounded blocking call; Claude Code moves a tool call that runs longer than two minutes to the background, so `wait` must return before that.

## Goals / Non-Goals

**Goals:**
- Start, import into, monitor, answer, and review a run from a Claude Code session without a terminal.
- Keep the daemon the sole writer and the sole durable process; the session is a window onto the run.
- Make the project installable for other hosts without restructuring: executables on PATH, thin wrappers per host.
- Keep tracker access in the session and tracker code out of the core.

**Non-Goals:**
- Headless tracker sync, status mirroring, and tracker comments (conversation 9).
- Marketplace distribution of the plugin, and wrappers for hosts other than Claude Code.
- A pull-based runner that lets workflow agents execute launches.
- Migration of v1 `.orchestrator-run` directories.

## Decisions

**Thin per-host wrappers over executables on PATH, not the repo root as plugin and not a monorepo.** A wrapper that references `${CLAUDE_PLUGIN_ROOT}/dist/...` is welded to this package's files and would have to ship the native dependency inside every marketplace copy. A wrapper that runs `orchestrator-mcp` is pure configuration, so the npm package is the single distribution unit for every host. A monorepo would be right only if the core gained code consumers with independent releases; per-host wrappers are not code.

**Run data lives per user, keyed by the repository's real path.** `~/.orchestrator/runs/<sha256 prefix>/`, `ORCH_HOME` to override, a `repo` file inside for reverse lookup, and a `runs` listing. The repository is never touched except for an optional committed `orchestrator.yaml`. The alternative, an ignored directory inside the repo, pollutes every repository the tool is pointed at and needs a `.gitignore` edit per repo. Resolution goes through `git rev-parse --show-toplevel` and `realpath` so symlinked checkouts and subdirectories map to one run.

**The operator MCP server speaks HTTP to the daemon and never opens the store.** Opening SQLite from a second process would break the sole-writer rule that the crash-safety argument depends on. The cost is that the daemon must be running for most tools, which `start` makes a one-call fix.

**`wait` is a bounded long-poll with a digest, not an event firehose.** Default sixty seconds, capped at ninety, below Claude Code's two-minute auto-background threshold. It returns a digest (open questions, awaiting review, finished, stalled, running, blocked) with the events since a sequence number, so a session loop costs one short tool result per minute at idle and the conversation holds summaries rather than logs. An `until` filter lets the run skill wait specifically for a question or a review.

**The mapping from issues to graph is code; the fetching is the session's.** The import skill requires the vendor's MCP server in the session and passes normalized records to `import_issues`. Mapping in code is deterministic and unit-tested and identical across hosts; auth stays the session's, which already works. The alternative, our process as an MCP client of the vendor server, is the right shape for headless sync later, where it also keeps vendor SDKs out of the project forever.

**External nodes carry a `done` flag in the graph file.** They cover three cases with one rule: a blocker outside the epic, a child already done in the tracker, and a child a human has in progress. They are never scheduled, never hold overlay state, and are always editable on reload, so re-importing after the tracker changes is always compatible. The in-progress rule defaults to external because the orchestrator must not take over a human's work; it is configurable for teams that want it to.

**The daemon reuses its recorded port.** v1 picked a random port on every start, so a restart stranded surviving agents on a dead URL; they fell back to report files, which works but loses the live channel. Recording the port and reusing it when free closes that gap and is what adoption after restart was designed for.

**Reaping shutdown becomes a route.** `--reap-on-exit` was a startup flag, which a session cannot set on an already running daemon. A `shutdown` route with a `reap` flag gives `stop --reap` a clean path, with the signal as fallback.

**Three skills, not one.** `import`, `run`, and `review` are distinct moments with distinct prerequisites: import needs the tracker, run needs a daemon, review needs a submitted milestone. One skill with modes would blur the refusal conditions.

## Risks / Trade-offs

- [A session that leaves mid-run loses its monitoring loop] → the daemon is durable; `status` and `wait` reattach; questions degrade to blocked at `maxWait` and are answerable later.
- [Import rules misread a tracker's description format] → the heading is configurable; the summary names every task missing criteria before anything launches; validation blocks at ready rather than launching a thin brief.
- [Stale pid files or port collisions on start] → health check on the recorded URL decides liveness; a busy recorded port falls through to a new one and is re-recorded.
- [Marketplace copies of the plugin have no executables] → out of scope here; the executable-on-PATH contract makes the later fix an install step, not a restructuring.
- [Two sessions drive the same run] → every operator action is an event; the daemon serializes them; the second session sees the first's effects through `wait`.
- [Review bundle for a large closure is big] → summaries only; the session reads the diff itself from the repository when it needs detail.

## Migration Plan

Greenfield for users; v1 had none. The run directory default changes, and `dataDir` and `graphPath` remain honored when set explicitly in `orchestrator.yaml`. Existing tests that pin `dataDir` keep working.

## Open Questions

- Which other hosts first, and whether a `hosts/<host>/` wrapper is generated by an `init` command, OpenSpec-style, or hand-maintained.
- Whether `wait` should also be offered as a Claude Code monitor so questions surface without a loop.
- The pull-based runner for workflow agents: after this change, as its own conversation.
