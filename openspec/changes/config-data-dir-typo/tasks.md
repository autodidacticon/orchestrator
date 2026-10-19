## 1. CLI

- [x] 1.1 Refuse `config --data-dir <value>` other than `shared` or `launch` when `--url` or `ORCH_URL` is set, before any request, naming both meanings and the accepted values
- [x] 1.2 Say so in the CLI usage and the header comment

## 2. Tests

- [x] 2.1 Slice test: `--url X config --data-dir lanch` and `config --data-dir lanch` under `ORCH_URL` throw and a stand-in daemon sees no request; `config --data-dir launch` still sends one PUT; without a URL a store path still resolves the daemon
