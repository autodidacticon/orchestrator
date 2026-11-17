## ADDED Requirements

### Requirement: Requests from another origin are refused
The API server SHALL answer 403 to any request that carries an `Origin` header, whatever its value (`null` and an empty value included), on every bind, for every method and every path. When the bind is a loopback address (`localhost`, `::1`, or an IPv4 address in `127.0.0.0/8`), the server SHALL also answer 403 to a request whose `Host` header is missing or is not one of: the bound address with the listening port; `localhost` with the listening port; with `apiBind: localhost`, `127.0.0.1` and `[::1]` with the listening port; the host and port of `apiBaseUrl` when that key is set. When the bind is not loopback (`0.0.0.0` and `::` included) there SHALL be no `Host` check. The `Host` comparison SHALL ignore case and one trailing dot on the name, SHALL compare an IPv6 address in its bracketed form, and SHALL take a missing port to be the default port of the entry's scheme (`http` for the bound address and `localhost`, the URL's own scheme for `apiBaseUrl`). The `Origin` rule SHALL be tested before the `Host` rule, and both SHALL be applied before the route is matched, before the request counts as activity for the idle exit, and before the body is read, so a refused request runs no handler and writes nothing. The probes SHALL get no exemption. The answer SHALL be JSON `{ error, code }` with `code` `originHeader` or `hostHeader`; the `error` text SHALL name the header, and for `hostHeader` the value received and that `apiBaseUrl` adds a host. No CORS header SHALL be sent and no configuration key SHALL switch the rules off.

#### Scenario: Origin header on a loopback bind
- **WHEN** a daemon bound to `127.0.0.1` receives a `POST` with `Origin: https://example.com` and `Host: 127.0.0.1:<port>`
- **THEN** it answers 403 with `code: 'originHeader'` and the route handler does not run

#### Scenario: Origin header on a cluster bind
- **WHEN** a daemon bound to `0.0.0.0` receives a request with `Host: 10.1.2.3:8080` and an `Origin` header
- **THEN** it answers 403 with `code: 'originHeader'`

#### Scenario: Foreign Host on a loopback bind
- **WHEN** a daemon bound to `127.0.0.1` receives a request with `Host: evil.example:<port>`, `Host: localhost:<other port>`, or no `Host`
- **THEN** it answers 403 with `code: 'hostHeader'` and the route handler does not run

#### Scenario: localhost with the listening port
- **WHEN** a daemon bound to `127.0.0.1` receives a request with `Host: localhost:<port>` or `Host: LOCALHOST:<port>` and no `Origin`
- **THEN** the request reaches its route

#### Scenario: The apiBaseUrl host
- **WHEN** a daemon bound to `127.0.0.1` with `apiBaseUrl: https://orch.test` receives a request with `Host: orch.test` or `Host: orch.test:443`
- **THEN** the request reaches its route, and `Host: 127.0.0.1:<port>` still does, while `Host: orch.test:80` is answered 403 with `code: 'hostHeader'`

#### Scenario: No Host check on a cluster bind
- **WHEN** a daemon bound to `0.0.0.0` receives a request with `Host: 10.1.2.3:8080` and no `Origin`
- **THEN** the request reaches its route

#### Scenario: A kubelet probe is answered as before
- **WHEN** a daemon bound to `0.0.0.0` receives `GET /healthz` with `Host: <pod IP>:8080` and no `Origin`
- **THEN** it answers the probe as before

#### Scenario: A refused request does not count as activity
- **WHEN** a page polls a route with an `Origin` header
- **THEN** each request is answered 403 before it is counted as activity, so it does not keep the daemon from its idle exit
