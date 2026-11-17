## ADDED Requirements

### Requirement: Origin identity is frozen

The identity hashed for an origin run id SHALL be the URL trimmed, normalised as the scenarios state and otherwise kept as written; an address that does not parse as a URL SHALL be taken unchanged. No form SHALL lose a `.git` suffix or a trailing slash. The rule SHALL NOT change in a later release, and a test SHALL hold run ids as literals.

#### Scenario: https host case, default port and credential

- **WHEN** the origin is `https://git.example.com/team/project.git`, `https://GIT.example.com:443/team/project.git` or `https://x-access-token:secret@git.example.com/team/project.git`
- **THEN** the run id is `88b53ae7afc6f781` for each, because an `http` or `https` URL has its user information removed, its host lowercased and its default port dropped

#### Scenario: http default port

- **WHEN** the origin is `http://GIT.example.com:80/team/project.git`
- **THEN** the run id is `559e44dca6da773f`

#### Scenario: ssh URL keeps host and port as written

- **WHEN** the origin is `ssh://git@git.example.com/team/project.git` or `ssh://other@git.example.com/team/project.git`
- **THEN** the run id is `80a522b921e76c20` for both, because user information is removed
- **AND WHEN** the origin is `ssh://git@GIT.example.com/team/project.git`
- **THEN** the run id is `a929f8abcff79ed4`
- **AND WHEN** the origin is `ssh://git@git.example.com:22/team/project.git`
- **THEN** the run id is `a52c4abb760e2b58`

#### Scenario: git URL keeps host and port as written

- **WHEN** the origin is `git://git-origin.orch.svc:9418/fixture.git`
- **THEN** the run id is `af1507c5d17cfdef`
- **AND WHEN** the origin is `git://git-origin.orch.svc/fixture.git`
- **THEN** the run id is `f62598e6976ef69f`

#### Scenario: Three path spellings are three run ids

- **WHEN** the origin is `https://git.example.com/team/project.git`, `https://git.example.com/team/project` or `https://git.example.com/team/project/`
- **THEN** the run ids are `88b53ae7afc6f781`, `30774d330900e9dc` and `884bf3a568293c95`

#### Scenario: scp-like address with a user is taken unchanged

- **WHEN** the origin is `git@git.example.com:team/project.git`
- **THEN** the run id is `9245f0dda77f617c`
- **AND WHEN** the origin is `other@git.example.com:team/project.git`
- **THEN** the run id is `a93c1af9aa06b2a6`, because the address does not parse as a URL and its user is kept
- **AND WHEN** the origin is `git@GIT.example.com:team/project.git`
- **THEN** the run id is `27f5d6b225cee7c8`, because its host case is kept

#### Scenario: scp-like address without a user

- **WHEN** the origin is `git.example.com:team/project.git` or `GIT.example.com:team/project.git`
- **THEN** the run id is `430a03b607b6e432` for both, because the address parses as a URL whose scheme is the host name, and only that name is lowercased

#### Scenario: Local path

- **WHEN** the origin is `/srv/git/project.git`
- **THEN** the run id is `86fb6c3ee3132ede`
