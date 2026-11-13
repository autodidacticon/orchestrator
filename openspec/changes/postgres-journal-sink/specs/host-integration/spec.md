## MODIFIED Requirements

### Requirement: No native dependencies
The npm package SHALL depend only on pure-JavaScript packages: no production dependency, direct or transitive, optional dependencies included, SHALL carry an `install`, `preinstall`, or `postinstall` script or a `binding.gyp`, so that an install with `--ignore-scripts`, such as a Claude Code plugin's automatic dependency install, yields a working package. The Postgres driver `pg` is allowed because it is pure JavaScript (its dependencies, including the optional `pg-cloudflare`, carry no install script); its optional native peer `pg-native` SHALL NOT be a dependency or be installed. The store SHALL use Node's built-in `node:sqlite` binding, and `engines.node` SHALL be `>=22.13.0`, the first release that loads `node:sqlite` without a flag. A host test SHALL assert the property from `package-lock.json` and the installed tree.

#### Scenario: Lockfile has no native module
- **WHEN** the host tests read `package-lock.json` and `node_modules`
- **THEN** no entry other than a dev-only one carries `hasInstallScript`, no production package directory contains `binding.gyp`, and `better-sqlite3` is in neither `dependencies` nor `devDependencies`

#### Scenario: Node floor declared
- **WHEN** the host tests read `package.json`
- **THEN** `engines.node` is `>=22.13.0`

#### Scenario: Postgres driver is pure JavaScript
- **WHEN** the state tests read `package-lock.json`
- **THEN** `node_modules/pg` is a production entry, no production entry carries `hasInstallScript`, and no `pg-native` or `libpq` entry exists
