## MODIFIED Requirements

### Requirement: Verifier termination
SIGTERM or SIGINT SHALL make the loop print `terminating` and claim no more; a second signal SHALL change nothing. While the loop waits between claims it SHALL exit 0 at once. The signal SHALL abort a claim in flight, which is sent again within 5000 ms: a job it grants SHALL be released at once with reason `podTerminating`, and any other end of the claim, no answer included, SHALL exit 0. Every call SHALL be bounded as `Verifier termination: bounded calls` says.

#### Scenario: Nothing to claim
- **WHEN** a verifier loop with nothing to claim gets SIGTERM, or SIGINT
- **THEN** it exits 0 with a `terminating` line and no `verify.released` event is appended

#### Scenario: Claim never answered
- **WHEN** in `test/verifier/loop.test.ts`, with `retryWindowMs` 60000, a claim is in flight at SIGTERM and the daemon never answers it
- **THEN** the loop exits 0 within `TERMINATION_CALL_MS` plus 1000 ms of the signal

### Requirement: Verifier termination: job in progress
While a job is worked and before its result is posted, the signal SHALL abort the job, which kills the check, and the loop SHALL wait at most 5000 ms for the job to return. It SHALL then post the release with the job token and `{ reason: 'podTerminating' }`, print `released` on a 200, and exit 0 whatever the answer. After the signal no answered result post SHALL be posted again, a signal in the pause between posts included.

#### Scenario: SIGTERM while the check runs
- **WHEN** a verifier loop gets SIGTERM while its check runs
- **THEN** it exits 0 within five seconds with `terminating` and `released` lines, the daemon holds one `verify.released` event with reason `podTerminating`, origin has no `refs/verify/<jobId>`, and another verifier can claim the job

#### Scenario: Signal in the pause between posts
- **WHEN** a result post is answered 503 and the signal lands during the 1000 ms pause before the next post
- **THEN** no further post is made, so exactly one result post is made in total, and the job is released with reason `podTerminating`

## ADDED Requirements

### Requirement: Verifier termination: refused result post
After the signal, a result post that ends neither stored (200) nor lost (401), because it is answered 400 or 5xx or gets no answer, SHALL be followed by one release with the job token and reason `podTerminating`, through the short window, and the loop SHALL then exit 0. A post stored or lost SHALL be followed by no release. The job is handed back, so it does not stay leased until `leaseTtlMs` runs out.

#### Scenario: Refused after the signal
- **WHEN** in `test/verifier/loop.test.ts` the result post in flight at SIGTERM is answered 400, or 503, or gets no answer
- **THEN** the loop posts one release `{ reason: 'podTerminating' }` with the job token, prints `released`, and exits 0 within 6000 ms of the signal

#### Scenario: Result post never answered
- **WHEN** with `retryWindowMs` 60000 a result post is in flight at SIGTERM and the daemon never answers it
- **THEN** the loop posts the release and exits 0 within `TERMINATION_CALL_MS` plus 1000 ms of the signal

### Requirement: Verifier termination: bounded calls
The verifier and worker loops SHALL share one termination-aware API client. The signal SHALL abort each fetch in flight through its `AbortSignal`, and that call SHALL retry with at most 5000 ms (`TERMINATION_CALL_MS`) left; a call started after the signal SHALL retry for at most the smaller of the retry window and 5000 ms. A fetch SHALL be aborted once its call's window has passed, but no sooner than 5000 ms before the signal or 1000 ms after it.

#### Scenario: Daemon holds the connection
- **WHEN** a call's fetch is accepted and never answered and the call's remaining window passes
- **THEN** the fetch is aborted and the call throws its error, so a call in flight at the signal ends at most `TERMINATION_CALL_MS` plus 1000 ms after it

#### Scenario: Answer cut off by the signal
- **WHEN** the signal aborts a fetch after its headers have arrived and while its body is read
- **THEN** the call counts it as no answer and sends it again, so a claim's grant is not taken for an empty answer: the repeated claim returns the job, which is released with `podTerminating`

#### Scenario: Before the signal
- **WHEN** no signal has come and a fetch is started with less than 5000 ms of its window left
- **THEN** the fetch is given 5000 ms, so a slow answer near the end of the window is still awaited
