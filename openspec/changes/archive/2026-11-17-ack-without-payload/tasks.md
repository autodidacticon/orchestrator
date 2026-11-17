## 1. Routes

- [x] 1.1 Add `effectState` beside the outbox routes and use it in the four ack and nack answers (`src/operator/routes.ts`)
- [x] 1.2 Say in the `ack` tool's description that the answer carries the effect's id and state, not its payload (`src/operator/mcp-server.ts`)

## 2. Tests

- [x] 2.1 Key sets of the first ack, repeated ack, nacks below and at the cap and the 409 answer; the listing still carries the payload (`test/slice/outbox.test.ts`)
- [x] 2.2 CLI `ack` answers have no payload (`test/slice/operator.test.ts`)
- [x] 2.3 `ack` tool answers have no payload and its description names the payload (`test/slice/operator-mcp.test.ts`)
