## ADDED Requirements

### Requirement: Critical path length
The system SHALL compute, for every node, its critical path length: the number of task nodes on the longest chain of dependents below it. Milestone and external nodes SHALL be passed through and SHALL contribute zero, so a chain continues through a milestone to its dependents. A node with no dependents SHALL have length zero. The lengths SHALL be computed from the graph alone, once per graph revision, and cached with the loaded graph.

#### Scenario: Standard fixture lengths
- **WHEN** the standard fixture is loaded
- **THEN** the lengths are T1 2, T2 1, T3 0, T4 0, T5 0, and MVP 0

#### Scenario: Milestone passed through
- **WHEN** milestone M1 depends on T1 and task T9 depends on M1
- **THEN** T1's length is 1 and M1's length is 1

#### Scenario: Monotone along dependencies
- **WHEN** random acyclic graphs are generated
- **THEN** for every dependency edge the dependency's length is at least the dependent's length, plus one when the dependent is a task
