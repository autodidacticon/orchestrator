## ADDED Requirements

### Requirement: No native dependencies
The npm package SHALL depend only on pure-JavaScript packages: no production dependency, direct or transitive, optional dependencies included, SHALL carry an `install`, `preinstall`, or `postinstall` script or a `binding.gyp`, so that an install with `--ignore-scripts`, such as a Claude Code plugin's automatic dependency install, yields a working package. The store SHALL use Node's built-in `node:sqlite` binding, and `engines.node` SHALL be `>=22.13.0`, the first release that loads `node:sqlite` without a flag. A host test SHALL assert the property from `package-lock.json` and the installed tree.

#### Scenario: Lockfile has no native module
- **WHEN** the host tests read `package-lock.json` and `node_modules`
- **THEN** no entry other than a dev-only one carries `hasInstallScript`, no production package directory contains `binding.gyp`, and `better-sqlite3` is in neither `dependencies` nor `devDependencies`

#### Scenario: Node floor declared
- **WHEN** the host tests read `package.json`
- **THEN** `engines.node` is `>=22.13.0`

### Requirement: Quiet SQLite binding
No executable of the package SHALL write the `node:sqlite` ExperimentalWarning to stderr, and the daemon log SHALL NOT contain it, whether the process was started by `daemonCommand()`, by a host, by `npx`, or directly from a terminal. Every other process warning SHALL still be printed. After the warning has been handled, or after the first turn of the event loop if it never arrives, the process's `warning` listeners SHALL be the ones that were installed before the store was loaded.

#### Scenario: Direct invocation is clean
- **WHEN** `orchestrator-ctl --data-dir <empty directory> status` runs
- **THEN** it exits with status 2 and stderr carries only the `no daemon url recorded` error

#### Scenario: Daemon log is clean
- **WHEN** a daemon started by `startDaemon` has run and stopped
- **THEN** its `daemon.log` contains no `ExperimentalWarning` line

#### Scenario: Other warnings still print
- **WHEN** a process that has opened the store calls `process.emitWarning` with another warning
- **THEN** that warning is written to stderr

#### Scenario: Listeners restored
- **WHEN** the store module has been loaded and one turn of the event loop has passed
- **THEN** `process.listeners('warning')` is the list that was installed before the load, in the same order
