## ADDED Requirements

### Requirement: Verifier termination: bounded calls: timer cap
The timeout the shared API client gives `setTimeout` for one fetch SHALL be capped at 2^31 - 1 ms (`MAX_TIMER_MS`), the longest delay the timer takes, so a retry window of 2^31 ms or more cannot overflow it. The retry window itself SHALL keep its configured value.

#### Scenario: Retry window past the timer's range
- **WHEN** the retry window is 3e9 ms and the daemon answers a call in 50 ms
- **THEN** the call returns that first answer after one fetch, and no `TimeoutOverflowWarning` is emitted
