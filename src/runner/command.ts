/**
 * The runner commands as templates, one per kind: the allow list (Claude only),
 * the model, and the effort are slots filled at every spawn from the effective
 * configuration and the launch. See specs/toolchain-discovery "Runner command
 * composition" and specs/model-selection.
 */
export const ALLOWED_TOOLS_SLOT = '{allowedTools}';
export const MODEL_SLOT = '{model}';
export const EFFORT_SLOT = '{effort}';

export const DEFAULT_CLAUDE_COMMAND = `claude -p --output-format json --mcp-config {mcpConfig} --strict-mcp-config --permission-mode acceptEdits --allowedTools ${ALLOWED_TOOLS_SLOT} --model ${MODEL_SLOT} --effort ${EFFORT_SLOT} --no-session-persistence < {brief}`;

/**
 * The Codex runner command, built only from flags verified against codex-cli 0.163.0: the prompt on
 * stdin (`-`), JSONL on stdout, and the final message in the worktree. {sandbox}, {ephemeral},
 * {ignoreUserConfig}, and {codexOverrides} are filled by the Codex runner at every spawn. No
 * `--full-auto` (removed) and no `--dangerously-bypass-approvals-and-sandbox`. See specs/worker-runners
 * "Codex runner command composition".
 */
export const DEFAULT_CODEX_COMMAND = `codex exec --json {ephemeral} {ignoreUserConfig} -C {worktree} -m ${MODEL_SLOT} -c model_reasoning_effort='"${EFFORT_SLOT}"' -s {sandbox} {codexOverrides} -o {worktree}/.orchestrator/last-message.txt - < {brief}`;

/**
 * The OpenCode runner command: JSONL on stdout, the structured log on stderr at WARN, and the brief
 * on stdin as the whole message (a run whose stdin stays open hangs, so it is always redirected).
 * {pure} is `--pure` under `runner.opencode.pure`; {variant} is `--variant <effort>`, empty when the
 * launch has no effort, so it carries the effort. The orchestrator MCP server, the permission
 * ruleset, and snapshots are in the per-launch OPENCODE_CONFIG_CONTENT, never on argv. See
 * specs/worker-runners "OpenCode runner command composition".
 */
export const VARIANT_SLOT = '{variant}';
export const DEFAULT_OPENCODE_COMMAND = `opencode run --format json {pure} --print-logs --log-level WARN -m ${MODEL_SLOT} ${VARIANT_SLOT} < {brief}`;

export function hasAllowedToolsSlot(template: string): boolean {
  return template.includes(ALLOWED_TOOLS_SLOT);
}

export function hasModelSlot(template: string): boolean {
  return template.includes(MODEL_SLOT);
}

export function hasEffortSlot(template: string): boolean {
  return template.includes(EFFORT_SLOT) || template.includes(VARIANT_SLOT);
}

/** Each rule double-quoted, space-separated; rules are validated as safe before they get here. */
export function quoteRules(rules: readonly string[]): string {
  return rules.map((r) => `"${r}"`).join(' ');
}
