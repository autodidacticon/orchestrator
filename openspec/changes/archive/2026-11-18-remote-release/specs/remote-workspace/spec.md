## ADDED Requirements

### Requirement: Remote launch end
The end of a remote launch, by release, lease expiry or any other path through the loop's release and expiry, SHALL NOT call `Workspace.fingerprint`, `Workspace.preserve` or `Workspace.remove` for it: the daemon holds no tree for a remote launch, and its work lives on the launch branch at origin. A kept remote release SHALL read the branch at origin instead (a fetch for a release with `keep`, `ls-remote` for a lease expiry), as specs/pull-runner "Release" and "Lease expiry" state.

#### Scenario: Kept remote release touches no tree
- **WHEN** a remote worker releases with `keep` and the pushed `headSha`, under a workspace that counts its calls
- **THEN** the release is kept and `fingerprint`, `preserve` and `remove` were each called zero times

#### Scenario: Remote expiry touches no tree
- **WHEN** a remote launch's lease expires after a push
- **THEN** the expiry is kept and neither `preserve` nor `remove` was called
