## Context

The journal (`JournaledStore`, ORC-10) and its Postgres sink (`PgSink`, ORC-15) exist but are not booted. ORC-21 made origin the source of truth for the integration branch and milestone tags. This change boots the journal over Postgres when configured and removes everything that tied a daemon to its volume: the SQLite file, the graph file, the clone and its worktrees.

## Goals / Non-Goals

**Goals:** select the store by configuration; keep the password out of every printed surface; exit rather than run on with unflushable state; keep the graph in the store with a rejected proposal never displacing the accepted graph; recover on a fresh clone without spending attempts; manifests with no daemon volume.

**Non-Goals:** reconnecting a lost session (the sink never does, by design); moving logs or worktrees off the pod; a migration path from an existing SQLite run to Postgres.

## Decisions

1. **The store block is read before the store opens, from the file and the environment only.** `main.ts` resolves the file layer once without detection (`early`), takes `store` and `leaseTtlMs` from it, and opens the store; the override document is read only afterwards, from the store just opened. `readOverrides` drops a `store` key and keeps the rest, because the override schema is strict and one stray key would otherwise discard the whole document. `store` is not an overridable key, so `PUT /v1/config` and `--set` refuse it.
2. **The run id must exist before the store opens.** With `--repo` it is the repository's run id, as before. With `--config` and `postgres`, it is derived from the repository's real path the same way, instead of a random id kept in the store.
3. **Redaction at the boundary.** `main.ts` keeps the real URL in the early config only. The resolution handed to the orchestrator (config, base layer and file layer) carries the URL with its password removed, so `GET /v1/config`, status, `config.json` and the `config.resolved` event never see it. The config report gains `store: { kind, url, urlSource, flushDeadlineMs }`. The stderr logger scrubs the password (raw, percent-encoded and JSON-escaped) from every line, as a backstop for driver error text.
4. **The lease check applies under `postgres` only.** A lease shorter than the flush deadline could expire while the records that granted or renewed it are unflushed. Under `sqlite` there is no deadline, and existing configurations (and tests) run leases shorter than the 120 s default deadline, which must stay valid.
5. **Two fatal paths.** The deadline path is the journal's (`flushDeadlineMs`). A lost session is fatal at once: `PgSink.onLost` fires on the client's `error`/`end` while the sink is open (not on `close`), and `open.ts` calls `JournaledStore.fence`, so both paths reach the same `onFatal`, which logs `{ reason, unflushedBatches }` and exits 1. Probing showed that `pg_ctl stop -m fast` terminates the session exactly like `pg_terminate_backend` (SQLSTATE 57P01, then the socket closes), so a stopped server exits at once through the fenced path; the deadline path is what a stalled or partitioned server (no FIN, no reply) takes. The tests stop the backend process (`SIGSTOP`) for the deadline and terminate it for the fenced path.
6. **Readiness.** `Store.readiness()` (optional; the journal implements it) reports a fatal condition, a lost lock, or a lag above `retryMaxMs` (one flush retry). `/readyz` appends its entries.
7. **The proposed slot is a kv row** (`graph.proposed`, `{ rev, content, stamp, at }`), so no migration is needed and both sinks carry it. `StoreGraphSource` evaluates a document once per stamp: a rejected document is not classified again every tick, and a re-sent identical one is. After a restart the proposed document is evaluated once more; if it is still incompatible it is rejected again and the snapshot (loaded and trusted first, as before) stays active.
8. **Fresh-clone recovery** runs after `workspace.integrationHead()`, which fetches origin when `git.pushIntegration` is on. A commit is lost only when `git cat-file -e <full sha>` exits 1 in a confirmed repository; any other failure is not a loss. The lost-commit pass runs after the publishing pass, so requeued jobs are covered, and drops the job. The two new transitions charge nothing: the loss is the platform's, not the agent's.
9. **Manifests.** The CloudNativePG Cluster is named `postgres` (its claim is `postgres-1`), so the smoke assertion "no claim matching `orchestrator`" is unambiguous. `git.pushIntegration: true` makes origin hold publications across pods. Two pods can overlap briefly when a pod is deleted; the second cannot take the run lock, exits, and is restarted until the first is gone.

## Risks / Trade-offs

- A daemon whose Postgres stalls keeps serving reads from its image until the deadline; writes made in that window are lost with the process. Responses to POST/PUT already wait for durability, so no client was told they landed.
- A run moved from `sqlite` to `postgres` starts empty: there is no import of an existing SQLite store.
- Claimed launches on a remote worker that kept its own worktree are not affected; only the daemon's prepared worktree is checked.
