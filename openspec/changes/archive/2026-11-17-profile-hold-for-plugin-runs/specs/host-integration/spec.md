## ADDED Requirements

### Requirement: Run skill asks for a held profile

Each run skill (Claude Code, Codex, OpenCode) SHALL hold one paragraph that starts with `**Worker profile.**`, directly after the paragraph that starts "Tell the user who is executing the work". It SHALL say that the `start` result's `confirmProfile` tells whether the profile hold is on; that before a graph is loaded, with `confirmProfile` true and `config.model.source` or `config.effort.source` `default`, the session asks the user for the model and effort, naming the value shown as one option; that with a graph the session reads `status.profiles` (again after every import), tells the user every entry with its sources (`modelSource`, `effortSource`) and asks for the keys in `missing` of every entry with `held: true`; that the answer is applied with `configure` (`model` and `effort` for the kind in force, or the `claude`, `codex` or `opencode` object), also when the user accepts the value shown; that the session never chooses from the model of this session nor without the user's answer; and that `orchestrator.yaml` holds a lasting choice and `runner.confirmProfile: false` there turns the hold off. Each monitor list SHALL hold one bullet that starts with `- **profileHeld**`, directly after the `needsConfig` bullet, that sends the session to that paragraph and says the run is not slow or stalled. The Claude Code work skill SHALL hold one bullet in section 1 that starts with `- **Worker profile.**` and says to follow the run skill's paragraph before running workers when `status.profiles` has an entry with `held: true`. No existing paragraph or bullet SHALL change, and the Codex and OpenCode blocks SHALL be equal after the edition substitutions.

#### Scenario: The paragraph read alone

- **WHEN** the **Worker profile.** paragraph is cut out of any of the three run skills
- **THEN** it holds `confirmProfile`, `status.profiles`, `held`, `missing`, `modelSource`, `configure`, `runner.confirmProfile`, `orchestrator.yaml` and the words "model of this session"

#### Scenario: The work skill bullet

- **WHEN** the **Worker profile.** bullet is cut out of the Claude Code work skill
- **THEN** it holds `status.profiles` and `held: true`

### Requirement: Import skill reports held tasks

Each import skill SHALL hold one bullet in section 1 that starts with `- **Worker profile.**`, directly after the bullet that starts "The orchestrator daemon must be running for this repository": when the `start` result has `confirmProfile` true and `config.model.source` or `config.effort.source` is `default`, the imported tasks will be held, so the session asks the user for the model and effort before the import and applies the answer with `configure`, as the run skill's Worker profile paragraph says. Each import skill SHALL hold one paragraph in section 5 that starts with `**Held tasks.**`, directly before "Then offer to run it": the session calls `status` after the import and, when `status.profiles` has an entry with `held: true`, tells the user how many tasks are held and that the daemon will not launch them, asks for the keys in `missing` and applies the answer with `configure`, never choosing from the model of this session.

#### Scenario: The blocks read alone

- **WHEN** the **Worker profile.** bullet and the **Held tasks.** paragraph are cut out of any of the three import skills
- **THEN** the bullet holds `confirmProfile`, `default` and `configure`
- **AND** the paragraph holds `status.profiles`, `held`, `missing`, `configure` and the words "model of this session"
