## Why

The API server read neither the `Origin` nor the `Host` header, so a web page open in a browser on the same machine could send requests to a laptop daemon, directly or through DNS rebinding (ORC-126).

## What Changes

- A request that carries an `Origin` header, whatever its value, is answered 403 with `code: 'originHeader'`, on every bind, for every method and every path.
- When the bind is loopback (`localhost`, `::1`, or an IPv4 address in `127.0.0.0/8`), a request is answered 403 with `code: 'hostHeader'` unless its `Host` is the bound address with the listening port, `localhost` with the listening port, or the host and port of `apiBaseUrl`. A request without `Host` is refused. On any other bind there is no `Host` check.
- The refusal comes before routing, before the request counts as activity, and before the body is read. Probes get no exemption.
- No CORS header, no `OPTIONS` route, no configuration key.
- **BREAKING** for a browser page or a client that sends `Origin`, and for a client that reaches a loopback daemon through a name other than the bound address, `localhost` or `apiBaseUrl` (a tunnel, an `/etc/hosts` alias): such a client sets `apiBaseUrl`.

## Capabilities

### Modified Capabilities

- `operator-control`: ADDED requirement "Requests from another origin are refused".

## Impact

- `src/agent/server.ts`: the accepted `Host` set built in `listen`, and a refusal checked first in `dispatch`.
- Tests in `test/agent/server.test.ts`.
- No client changes: no client in the repository sends `Origin`, and each calls the advertised URL, `localhost`, or a daemon on a non-loopback bind.
