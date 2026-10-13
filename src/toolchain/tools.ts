/**
 * The allow list for agents the daemon spawns: base rules, rules derived per
 * found toolchain, then rules from the file and from arguments, composed in
 * layer order with duplicates dropped. See specs/toolchain-discovery "Derived
 * allowed tools" and "Resolution order and provenance".
 */
import type { ToolchainKind, ToolchainRecord } from './detect.js';

export const BASE_RULES: readonly string[] = ['Bash(git:*)', 'mcp__orchestrator__heartbeat', 'mcp__orchestrator__report', 'mcp__orchestrator__block', 'mcp__orchestrator__inbox', 'mcp__orchestrator__log'];

const ORDER: readonly ToolchainKind[] = ['make', 'node', 'rust', 'go', 'python', 'ruby', 'gradle', 'maven', 'elixir', 'dotnet'];

function rulesOf(kind: ToolchainKind, record: ToolchainRecord): string[] {
  switch (kind) {
    case 'make':
      return ['Bash(make:*)'];
    case 'node': {
      const pm = record.packageManager ?? 'npm';
      const extra = pm === 'npm' ? ['Bash(npm ci:*)', 'Bash(npx:*)'] : pm === 'bun' ? ['Bash(bunx:*)'] : ['Bash(npx:*)'];
      return [`Bash(${pm} test:*)`, `Bash(${pm} run:*)`, `Bash(${pm} install:*)`, `Bash(${pm} exec:*)`, 'Bash(node:*)', ...extra];
    }
    case 'rust':
      return ['Bash(cargo:*)'];
    case 'go':
      return ['Bash(go:*)'];
    case 'python':
      return ['Bash(pytest:*)', 'Bash(python:*)', 'Bash(python3:*)', 'Bash(pip:*)', ...(record.python === 'uv' ? ['Bash(uv:*)'] : record.python === 'poetry' ? ['Bash(poetry:*)'] : [])];
    case 'ruby':
      return ['Bash(bundle:*)', 'Bash(rake:*)', 'Bash(rspec:*)', 'Bash(ruby:*)'];
    case 'gradle':
      return ['Bash(./gradlew:*)', 'Bash(gradle:*)'];
    case 'maven':
      return ['Bash(mvn:*)', 'Bash(./mvnw:*)'];
    case 'elixir':
      return ['Bash(mix:*)', 'Bash(elixir:*)'];
    case 'dotnet':
      return ['Bash(dotnet:*)'];
  }
}

/** Rules for every found toolchain, in table order. */
export function rulesFor(record: ToolchainRecord | undefined): string[] {
  if (!record) return [];
  const out: string[] = [];
  for (const kind of ORDER) if (record.kinds.includes(kind)) out.push(...rulesOf(kind, record));
  return out;
}

/** A rule is quoted into a shell command line; these characters would break out of the quotes. */
export function isSafeRule(rule: string): boolean {
  return rule.trim() !== '' && !/["\\$`]/.test(rule);
}

export interface AllowedToolsParts {
  default: string[];
  detected: string[];
  file: string[];
  argument: string[];
}

/** Layers composed in order, each rule attributed to the first layer that contributed it. */
export function composeAllowedTools(input: { record?: ToolchainRecord; deriveTools: boolean; fileRules: string[]; argumentRules: string[] }): { value: string[]; parts: AllowedToolsParts } {
  const seen = new Set<string>();
  const take = (rules: readonly string[]) => rules.filter((r) => (seen.has(r) ? false : (seen.add(r), true)));
  const parts: AllowedToolsParts = {
    default: take(BASE_RULES),
    detected: take(input.deriveTools ? rulesFor(input.record) : []),
    file: take(input.fileRules),
    argument: take(input.argumentRules),
  };
  return { value: [...parts.default, ...parts.detected, ...parts.file, ...parts.argument], parts };
}
