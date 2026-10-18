## 1. Tracker record

- [x] 1.1 `src/import/mapping.ts`: `trackerSchema.kind` gains `'github'`; add `inProgressLabel: z.string().min(1).optional()` with a refinement that refuses it unless `kind` is `github`; the `import_issues` tool description in `src/operator/mcp-server.ts` names GitHub and the label
- [x] 1.2 Confirm the recorded tracker, including `inProgressLabel`, reaches `status` and the outbox `policy.tracker` (it is stored and reported as a document today; add the field to any typed shape that narrows it)
- [x] 1.3 Tests: `test/import/mapping.test.ts` accepts `{ kind: 'github', workspace: 'acme/app', inProgressLabel: 'in-progress' }` without changing the mapping and refuses the label on `linear`; a slice or MCP test asserts `status` and `outbox` report the label after import

## 2. Import skill

- [x] 2.1 `hosts/claude-code/skills/import/SKILL.md`: prerequisites name three connectors and the `gh auth status` check through Bash; the refusal message names all three
- [x] 2.2 Section 2 gains "For **GitHub**": root by number, URL, or milestone; children from `subIssues` or the milestone's issues; `blockedBy` from dependencies; fetch outside blockers; the exact `gh api graphql` query shapes for an issue's `parent`, `subIssues`, `blockedBy`, `state`, `stateReason`, `labels`, `milestone`, `url`
- [x] 2.3 Section 3 gains the GitHub record rules: ids `GH-<n>`, `GH-<owner>-<repo>-<n>`, `GH-M<n>`; state from `state` and `stateReason` plus the label; priority from `P0`..`P4` or `priority:<n>`; always `url`; section 4 documents `tracker: { kind: "github", workspace: "owner/repo", inProgressLabel? }` and the offer to use an existing label; the empty-root refusal
- [x] 2.4 Skill frontmatter description and README mentions name GitHub beside Linear and Jira

## 3. Run skill

- [x] 3.1 `hosts/claude-code/skills/run/SKILL.md` section 2a: the GitHub branch acting on `url`: `gh issue close --reason completed`, `--reason "not planned"`, `gh issue reopen` then `gh issue edit --add-label <inProgressLabel>`, skip-ack when the label is unset; milestone root: close the milestone on `done`, skip-ack comments; comments through `gh issue comment` with the marker and the existing-marker check through `gh issue view --comments`
- [x] 3.2 Proposals: `gh issue create --parent <root URL>` with the criteria heading in the body, then the `addBlockedBy` GraphQL mutation for the proposing issue, then `accept_proposal` with `GH-<number>`
- [x] 3.3 Section 2b: answers from comments work unchanged through `gh issue view --comments`; say so

## 4. Documentation and tests

- [x] 4.1 README: the intro and the skills paragraph name GitHub Issues as a tracker through `gh`; the Contents index gains this change
- [x] 4.2 `test/host/package.test.ts`: both skills mention `github`, `gh auth status`, `inProgressLabel`, and `GH-`; the import skill names the three-connector refusal
- [x] 4.3 `npm test` green; `openspec validate add-github-tracker`. No end-to-end test: exercising the GitHub path needs a live repository and is done by hand against a throwaway repository before the next release
