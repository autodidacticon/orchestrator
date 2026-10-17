# deploy

Everything for running the orchestrator in a cluster lives here.

## Daemon image

The image is `orchestrator:dev` when built locally, from the `Dockerfile` at the repository root:

```sh
docker build -t orchestrator:dev .
```

It is multi-stage on `node:22-slim`: the build stage compiles `dist/`, and the final stage holds Node, `git`, `openssh-client`, the built `dist/src`, and production dependencies only. It carries no project toolchain; workers and verifiers get their own images.

Two entrypoints are on `PATH`:

- `orchestrator`: the daemon (the default command).
- `orchestrator-ctl`: the operator CLI.

```sh
docker run --rm orchestrator:dev orchestrator --help
docker run --rm orchestrator:dev orchestrator-ctl
```

The image runs as the unprivileged `node` user.
