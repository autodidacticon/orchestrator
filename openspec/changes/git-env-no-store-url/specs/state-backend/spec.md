## MODIFIED Requirements

### Requirement: No store URL in child environments
Check commands, agents of every runner kind together with the processes they start, and the git commands the daemon runs itself through its git wrapper (`src/workspace/git.ts`) together with the project git hooks they trigger, SHALL NOT receive `DATABASE_URL`, `ORCH_RUN_ID`, or any variable whose value equals the resolved `store.url`. The daemon's own environment SHALL keep them. The environment of each daemon git command SHALL be built when the command runs, so a store URL resolved after startup is removed too, and SHALL still set `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_OPTIONAL_LOCKS=0`. The read-only startup lookups in `src/runs/runDir.ts` (`git config --get remote.origin.url`, `git ls-files --error-unmatch`, `git rev-parse --show-toplevel`) run no hooks and are not covered.

#### Scenario: Printed environments
- **WHEN** a Postgres daemon whose environment holds `DATABASE_URL` and another variable with the same URL runs a check command and a spawned agent that print their environment
- **THEN** neither printout contains `DATABASE_URL`, `ORCH_RUN_ID`, the other variable, or the password, and unrelated variables are kept

#### Scenario: URL from the config file
- **WHEN** `store.url` comes from an untracked config file and another variable holds the same URL
- **THEN** that variable is absent from the check and agent environments, and no worktree contains the config file

#### Scenario: Hook run by a daemon git command
- **WHEN** the daemon's environment holds `DATABASE_URL`, `ORCH_RUN_ID` and another variable with the store URL, and a project git hook that prints its environment runs under the daemon's kept-release work-in-progress commit or another daemon `git commit`
- **THEN** the printout contains none of those variables and not the password, keeps unrelated variables, and shows `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_OPTIONAL_LOCKS=0`

#### Scenario: Store URL withheld after import
- **WHEN** the store URL is withheld after the git module has loaded, as the daemon does once its configuration is resolved
- **THEN** the next daemon git command's environment no longer holds a variable with that URL
