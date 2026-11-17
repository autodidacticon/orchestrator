## 1. Server

- [x] 1.1 Build the accepted `Host` set on every successful `listen`, undefined on a non-loopback bind (`src/agent/server.ts`)
- [x] 1.2 Refuse a request with `Origin`, then one with a foreign or missing `Host`, as the first step of `dispatch`, with `connection: close` (`src/agent/server.ts`)

## 2. Tests

- [x] 2.1 Origin refusals (POST, `null`, GET, OPTIONS, unknown path) with no handler call and no `requestBegan` (`test/agent/server.test.ts`)
- [x] 2.2 Host rules on a `127.0.0.1` bind, with `apiBaseUrl` over http and https, HTTP/1.0 without `Host`, and a `0.0.0.0` bind (`test/agent/server.test.ts`)
