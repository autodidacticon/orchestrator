## 1. Specs

- [x] 1.1 operator-control "Shutdown: reap before the verifier wait": local job runs to its end, remote wait ends at once
- [x] 1.2 verifier-pool "Remote verification and restarts: stop": the second counts from the end of the reap and the prepare-command stop
- [x] 1.3 `openspec validate reap-stop-remote-wait --strict`
