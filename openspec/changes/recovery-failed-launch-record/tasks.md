## 1. Implementation

- [x] 1.1 Recovery's dead-launch branch calls `o.failExited(launch, reason, 'deadOrExpired')` instead of `o.fail(...)`, keeping the waiting and fallback branches as they are.
- [x] 1.2 Move the uncharged count into the transaction in `failExited`.

## 2. Tests

- [x] 2.1 A launch dead at restart diagnosed `startupContended` returns the task to `unstarted` with `attempts` unchanged and one `launch.failed` event with `reason: startupContended, charged: false`.
- [x] 2.2 A launch dead at restart with any other reason records `launch.failed` with `charged: true` and fails as before.
- [x] 2.3 Restart deaths and tick deaths share one allowance.

## 3. Specs

- [x] 3.1 crash-recovery "Recovery per boundary" and task-lifecycle "Retry and exhaustion" deltas.
