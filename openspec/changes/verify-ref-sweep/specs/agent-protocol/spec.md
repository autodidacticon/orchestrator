## ADDED Requirements

### Requirement: Request body limit
The agent server SHALL read a request body of at most 1 MiB (1,048,576 bytes). A larger body SHALL be answered 413 with an error naming the limit, and no handler SHALL run for it. The rest of the body SHALL be read and discarded, so the client receives the answer.

#### Scenario: Body over 1 MiB
- **WHEN** a client posts a body one byte or more over 1 MiB
- **THEN** the answer is 413 and the route's handler does not run

#### Scenario: Body of exactly 1 MiB
- **WHEN** a client posts a body of exactly 1 MiB
- **THEN** the route's handler runs and answers as usual
