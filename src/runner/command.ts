/**
 * The headless Claude Code runner command as a template: the allow list, the
 * model, and the effort are slots filled at every spawn from the effective
 * configuration and the launch. See specs/toolchain-discovery "Runner command
 * composition" and specs/model-selection.
 */
export const ALLOWED_TOOLS_SLOT = '{allowedTools}';
export const MODEL_SLOT = '{model}';
export const EFFORT_SLOT = '{effort}';

export const DEFAULT_CLAUDE_COMMAND = `claude -p --output-format json --mcp-config {mcpConfig} --strict-mcp-config --permission-mode acceptEdits --allowedTools ${ALLOWED_TOOLS_SLOT} --model ${MODEL_SLOT} --effort ${EFFORT_SLOT} --no-session-persistence < {brief}`;

export function hasAllowedToolsSlot(template: string): boolean {
  return template.includes(ALLOWED_TOOLS_SLOT);
}

export function hasModelSlot(template: string): boolean {
  return template.includes(MODEL_SLOT);
}

export function hasEffortSlot(template: string): boolean {
  return template.includes(EFFORT_SLOT);
}

/** Each rule double-quoted, space-separated; rules are validated as safe before they get here. */
export function quoteRules(rules: readonly string[]): string {
  return rules.map((r) => `"${r}"`).join(' ');
}
