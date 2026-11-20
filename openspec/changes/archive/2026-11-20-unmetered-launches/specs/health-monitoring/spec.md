## ADDED Requirements

### Requirement: Usage accounting: unmetered launches
A launch row that is `ended` or `revoked`, had an agent (`worker` or `spawnedAt` is set), and holds no usage (no cost, turns, duration, or tokens) SHALL be unmetered: its cost is unknown and outside the run cost. Unmetered launches SHALL NOT overlap unpriced launches, SHALL NOT pause admission, and the daemon SHALL append no event of its own when a launch becomes unmetered. A worker's later usage post SHALL take its launch out of the count.

#### Scenario: A spawned launch ends with no usage
- **WHEN** a spawned launch ends and its runner reads no usage
- **THEN** it is unmetered, and the same launch with a scripted usage is not

#### Scenario: A claimed launch's usage arrives after its end
- **WHEN** a launch a worker claimed is submitted and ended, then its worker posts usage
- **THEN** it is unmetered until the post and not after it, with one `launch.usage` event

#### Scenario: Not unmetered
- **WHEN** a launch is live, or a parked launch ends unclaimed after its task is cancelled, or a launch recorded tokens with no price
- **THEN** none of them is unmetered, and the launch with tokens counts as unpriced

#### Scenario: Under a cost budget
- **WHEN** `budgets.maxRunCostUsd` is 5 and three launches are unmetered
- **THEN** the run is not paused, the run cost is 0, and no `budget.exceeded` or `config.warning` event is appended
