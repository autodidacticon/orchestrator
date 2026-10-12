## 1. Scaffold and graph

- [x] 1.1 Initialize package.json (ESM, Node 22, npm scripts for test, build, dev), tsconfig.json, vitest.config.ts
- [x] 1.2 Add dependencies better-sqlite3, zod, yaml, @modelcontextprotocol/sdk and dev dependencies vitest, fast-check, tsx, typescript
- [x] 1.3 Add test/fixtures/graphs/standard.yaml (T1 to T5 plus gated MVP) and a cyclic, a dangling, and a duplicate-id fixture
- [x] 1.4 Implement src/crash.ts with crashPoint(name) gated by ORCH_CRASH_AT
- [x] 1.5 Implement src/graph/model.ts and src/graph/load.ts: JSON and YAML parsing, zod schema, content-hash rev, validation with cycle path reporting
- [x] 1.6 Implement src/graph/query.ts: deps, dependents, closure, satisfied, ready, milestonesDue, incomplete, awaitingReview, openQuestions, finished, stalled, stallRoots, started, revocable, quiescent
- [x] 1.7 Implement src/graph/diff.ts: compatible versus incompatible reload classification with reasons
- [x] 1.8 Unit tests for loading, each validation failure, closure(MVP), and every reload classification case
- [x] 1.9 fast-check properties over random DAGs: ready contains only tasks with satisfied deps; marking a ready node done never removes another node from ready; chained automatic milestones reach a fixed point in one pass

## 2. State, store, and loop logic

- [x] 2.1 Implement src/state/status.ts: Status union, Entry, Lease, structured blocked reasons, counters
- [x] 2.2 Implement src/state/transitions.ts: the transition table as data, a single guard function, counter increment and reset effects per row
- [x] 2.3 Define src/state/store.ts: overlay, events, dedup responses, launches, verifier jobs, reports, payload overlays, milestone reviews, pause flag
- [x] 2.4 Implement src/state/sqlite.ts with better-sqlite3: schema, WAL mode, transactions, append-only event log
- [x] 2.5 Implement src/loop/schedule.ts: Policy interface, FIFO, resumables first, capacity and maxWaiting caps
- [x] 2.6 Implement src/loop/tick.ts (reconcile, drain verification, milestones to fixed point, admit and launch, evaluate) and src/loop/orchestrator.ts (timer plus event wake, pause, start and stop)
- [x] 2.7 Implement src/runner/inproc.ts as an in-process fake runner for logic tests
- [x] 2.8 Tests: every table row allowed and every non-row rejected; counter effects; revocable across safe and unsafe dependents; two concurrent claims yield one lease; dedup returns the stored response; event log and overlay agree after reopening the database
- [x] 2.9 Inproc scenarios on the fixture: happy path; fail, retry with context, blocked; cancel without release leaves T2 and T3 in stallRoots and with release they run; reopen refused while a dependent runs and allowed after it fails; gated MVP reject, repair, accept at version 2; pause stops admission; waiting frees a slot and resume requires admission
- [x] 2.10 Reachable-state property: random action sequences through the tick, then quiescent and stalled implies stallRoots non-empty

## 3. Launch, API, and recovery

- [x] 3.1 Implement src/workspace/git.ts: execFile wrapper for worktree add and remove, status --porcelain, rev-parse, rebase, squash, compare-and-swap update-ref, trailer search, tag
- [x] 3.2 Implement src/workspace/workspace.ts: per-launch worktree lifecycle and the primary clone invariant
- [x] 3.3 Implement src/launch/launch.ts: preparing, launching, live, ended, revoked with durable records and crash points at each boundary
- [x] 3.4 Implement src/runner/subprocess.ts: detached spawn, stdio to per-launch log files, launch id in argv, alive and reap
- [x] 3.5 Implement src/agent/api.ts: zod schemas for the five operations, submit and fail bodies, and the fallback file
- [x] 3.6 Implement src/agent/server.ts: loopback HTTP, bearer auth per launch, dedup by (launchId, seq), heartbeat, report, block long-poll, inbox, log, loop wake
- [x] 3.7 Implement src/agent/seal.ts: worktree cleanliness check with 409 file list, sealedSha, declared no-op, acceptance evidence coverage
- [x] 3.8 Implement a minimal src/brief/compose.ts producing brief.json with workspace facts, token, API URL, fallback path, and direct dependency reports
- [x] 3.9 Implement src/launch/recovery.ts: per-boundary recovery, adoption, token revocation, kill by launch id, worktree and process sweeps, fallback file application
- [x] 3.10 Implement test/agents/scripted.ts with behaviors commitAndSubmit, submitDirtyThenFix, fail, blockThenExit, blockAndWait, hang, exitSilently, noopDeclared, noopUndeclared, conflictWith, offlineSubmit, ignore401, and a pid log
- [x] 3.11 Slice tests over real worktrees and loopback HTTP: dirty submit 409 then success; later commits ignored; undeclared no-op fails and declared passes; missing acceptance evidence fails; token scoping; same-seq replay; block, answer, admission, resume; maxWait degrades and a later answer becomes a new launch; offline submit applied on exit; revoked launch gets 401 and stays isolated; stray worktree sweep

## 4. Verifier and publication

- [x] 4.1 Implement src/verify/job.ts: durable job states queued, checking, verified, publishing, published, failed, conflict
- [x] 4.2 Implement src/verify/verifier.ts: single worker in submission order, temp worktree, rebase sealedSha, check command with timeout, squash with Orchestrator-Task and Orchestrator-Launch trailers, compare-and-swap publish, requeue on head movement, publishedSha and done in one transaction
- [x] 4.3 Implement conflict handling: integrationRetries, context for the next brief (files, siblings landed, previous branch), cap to failed
- [x] 4.4 Implement the foreign-commit sweep and expose it in status
- [x] 4.5 Implement milestone tagging at the pinned sha, idempotent
- [x] 4.6 Tests against a temp repository: one squash commit with trailers and the verified tree; red check fails with output; timeout fails; conflict retry names files and sibling; cap exhaustion; compare-and-swap failure requeues; foreign commit flagged; tag at pinned sha and idempotent re-tag

## 5. Crash suite

- [x] 5.1 Build the harness: run the daemon as a subprocess with ORCH_CRASH_AT, wait for exit, restart without it, wait for finished
- [x] 5.2 Implement invariant checks: pid log never shows two live processes per task; exactly one trailer commit per task; no stray or temp worktrees; store invariants; final state equals the uninterrupted run
- [x] 5.3 Run the matrix over every named crash point on the standard fixture and make it the gating test

## 6. Brief, shim, and operator

- [x] 6.1 Implement src/brief/template.ts (slots with source, required, minLength) and src/brief/validate.ts with validateAt ready or ingest
- [x] 6.2 Implement src/brief/remediate.ts: hook interface, block default, review and auto modes, payload overlay keyed by graph rev
- [x] 6.3 Complete src/brief/compose.ts: brief.md with task payload, acceptance criteria, definition of done, workspace facts, dependency reports, attempt context, reporting instructions
- [x] 6.4 Implement src/agent/mcp-shim.ts: stdio MCP server exposing the five tools, forwarding over HTTP with the launch token, retrying through daemon restarts for the retry window
- [x] 6.5 Implement src/operator/routes.ts and src/operator/cli.ts: status, answer, cancel --release, reopen, unblock, accept, reject, pause, resume, logs, each recorded as an event
- [x] 6.6 Implement src/config.ts (zod schema and loader) and src/main.ts (daemon entrypoint with graceful and --reap shutdown)
- [x] 6.7 Tests: validation blocks with the missing slot list; review-mode candidate lands as needsDecision and unblock applies it; the shim exposes five tools, forwards, and retries through a restart; every CLI command produces its event; stale accept rejected; pause and resume; graceful shutdown keeps agents and --reap stops them

## 7. Claude Code runner and end to end

- [x] 7.1 Verify the headless Claude Code flags against claude --help before writing the command template
- [x] 7.2 Implement src/runner/claude-code.ts: command template, per-launch MCP config pointing at the shim with the token in its environment, logs per launch
- [x] 7.3 End to end on a toy repository with the standard fixture using scripted agents: one trailer commit per task, milestone tag present, status reports finished
- [x] 7.4 End to end with Claude Code on a three-task graph
- [x] 7.5 Verify adoption after a plain daemon restart with agents mid-task, and --reap shutdown
