## Context

A Postgres run is keyed by its run id: every row carries `run_id`, and the daemon holds a session advisory lock keyed by it (changes `postgres-journal-sink` and `store-selection`). The id was the repository path hash, which is the same for every pod of the reference manifest (`--repo /data/repo`). Child processes inherited the daemon's whole environment, including `DATABASE_URL`.

## Decisions

### Run id precedence
With `store.kind: postgres`, in order:
1. `store.runId` from the config file. Like the rest of the `store` block it is read from the file and the environment only, never from the stored override document (`readOverrides` already drops `store`).
2. `ORCH_RUN_ID` from the environment.
3. `sha256("origin\0" + url)` cut to 16 hex characters, for `git.originUrl` when it is set.
4. The same hash of the clone's `origin` remote, when `git.originUrl` is unset and `git.pushIntegration` is on.
5. The repository path hash, as before, with one `warn` log line from the daemon naming the risk.

Step 4 goes beyond the task's wording ("a hash of `git.originUrl` when it is set"). The reference manifest has no `git.originUrl`: the origin is the URL the init container cloned (`REPO_URL`), and `git.originUrl` unset means "use the clone's existing origin". Hashing that origin gives each deployment its own id with nothing to set, and there is no second copy of `REPO_URL` in the ConfigMap to keep in step. The step is limited to `pushIntegration` on, the mode where origin is the source of truth. A local Postgres run without it keeps its path-hash id.

Before hashing, user information is removed from the origin URL, so rotating a token in `https://user:token@host/repo.git` keeps the id. The raw URL never appears in a log line or in the id.

An explicit id (steps 1 and 2) must match `^[A-Za-z0-9_-]{1,64}$`. The id names the run directory and appears in SQL parameters and tracker comments, so a slash, a dot-dot or a space is refused at startup: `invalid run id "<value>" from <source>`.

With `store.kind: sqlite` the inputs are ignored, even invalid ones. The id and the run directory stay the path hash (`--repo`), or a random id per store (`--config`), as before.

### Run directory follows the id
`runDirFor(repo, env)` reads `<repo>/orchestrator.yaml` and the environment and names the directory after the chosen id. The signature does not change, so `orchestrator-ctl`, the operator MCP server and `lifecycle.ts` find the same directory the daemon uses. `deploy/smoke.sh` already reads the id as `basename(status.runDir)`.

The warning is logged once, from `main.ts`. The resolver itself does not log, because it runs several times per start.

### Child environments
`childEnv.ts` holds the rule:
- `STORE_VARS = ['DATABASE_URL', 'ORCH_RUN_ID']` join the delete set that `isolationEnv` emits. Every caller that merges its own base gets them: the agent environment from the orchestrator core, and the check command through `childEnv`.
- `withholdStoreUrl(url)` registers the resolved store URL. `main.ts` calls it beside `scrubSecretsOf` once the store block is resolved. `withoutStore(env)` drops the store variables and any variable whose trimmed value equals a withheld URL.
- `childEnv()` (the check command) applies `withoutStore` last. `SubprocessRunner.spawn` applies it to the merged environment, and every runner kind (claude-code, codex, opencode, command) spawns through it.

`process.env` is not modified: the daemon re-resolves its configuration later (`resolveWith`), and that reads `DATABASE_URL`.

### Config file with the URL
Worktrees are git worktrees, so they contain tracked files only. When `store.url` comes from the config file and that file is tracked by git in the repository, startup is refused: `<file> sets store.url and is tracked by git, so every worktree would carry the database URL: set DATABASE_URL instead, or keep the file untracked`. An untracked file (the reference manifest mounts `orchestrator.yaml` and adds it to `.git/info/exclude`) is never checked out into a worktree. Nothing else in `src` copies the config file into a worktree.

## Risks / Trade-offs

- `src/workspace/git.ts` builds the environment for the daemon's own git commands from `process.env` at import time, so a project git hook run by the daemon (for example on a kept-release WIP commit) still sees `DATABASE_URL`. That file is outside this task's scope and is reported as a follow-up.
- A run started before this change on a Postgres store with `git.originUrl` set, or with `pushIntegration` on and an origin remote, changes id on upgrade. It starts a new run, and the old rows stay under the old id. Setting `store.runId` to the old path hash keeps the run.
