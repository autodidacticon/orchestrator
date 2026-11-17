## ADDED Requirements

### Requirement: Work loop silence leaves out a sleep
As an exception to "Work loop ends a hung agent" and "Work loop silence limit", the work loop SHALL leave a sleep of its own machine out of an agent's silence. The loop SHALL note its own clock for each running agent at spawn, every second (or every quarter of the threshold when that is shorter), and immediately before each verdict of the watcher. A *gap* SHALL be two consecutive notes more than `--gap-after-ms` apart (default 60000); a step exactly at the threshold, and a note earlier than the one before it, SHALL NOT be gaps. When the loop finds a gap it SHALL add the gap's length to the agent's last output time, capped at the present, and SHALL log one line with the length it left out, when that is above zero. The gap SHALL NOT be measured between two looks of the watcher. `--gap-after-ms 0` SHALL turn the rule off. The loop SHALL NOT read the daemon's gap record, the silence limit SHALL be chosen as before, and the report grace SHALL keep counting wall time.

#### Scenario: A sleep longer than the limit
- **WHEN** the agent wrote output, then the machine slept for twice the silence limit, and the loop notes its clock after the wake
- **THEN** the sleep is left out of the silence, the silence is below the limit, the loop logs the length it left out, and the loop does not end the agent
- **AND** the agent is ended when it then stays silent for the limit while the machine is awake

#### Scenario: Silence while awake
- **WHEN** the machine stays awake and the agent writes nothing for longer than the silence limit, with the loop's notes one second apart
- **THEN** no gap is found, the silence equals the wall time, and the loop ends the agent and releases the launch without keep

#### Scenario: A slow look of the watcher is not a sleep
- **WHEN** the machine is awake and a look of the watcher takes more than a minute because the daemon is unreachable
- **THEN** the per-agent timer's notes stay one second apart, no gap is found, and the silence limit applies as before

#### Scenario: The rule turned off
- **WHEN** the loop runs with `--gap-after-ms 0` and the machine sleeps for twice the silence limit
- **THEN** the sleep counts as silence and the loop ends the agent as it did before this rule
