// See specs/host-integration "Run skill names unmetered launches".
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const editions = ['claude-code', 'codex', 'opencode'] as const;
const skill = (host: string) => readFileSync(path.join(root, 'hosts', host, 'skills/run/SKILL.md'), 'utf8');

/** Paragraphs and list items, whitespace normalised. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n|\n(?=- )/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** The text of a `## ` section whose heading starts with `heading`, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}`);
  expect(start, heading).toBeGreaterThan(-1);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next === -1 ? undefined : next).replace(/\s+/g, ' ');
}

describe('run skills name unmetered launches', () => {
  for (const host of editions) {
    it(`${host}: one paragraph names cost.unmeteredLaunches, no usage recorded and budgets.maxRunCostUsd`, () => {
      const hits = paragraphs(skill(host)).filter((p) => p.includes('cost.unmeteredLaunches') && p.includes('no usage recorded') && p.includes('budgets.maxRunCostUsd'));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain("the digest's `unmeteredLaunches`");
    });

    it(`${host}: the costBudget bullet names cost.unmeteredLaunches`, () => {
      const bullets = paragraphs(skill(host)).filter((p) => p.startsWith('- **pausedReason** is `costBudget`'));
      expect(bullets).toHaveLength(1);
      expect(bullets[0]).toContain('`cost.unmeteredLaunches`');
    });
  }

  it("the Claude Code edition's section 1a says session subagents record no usage", () => {
    const a = section(skill('claude-code'), '1a.');
    expect(a).toContain("Launches worked by this session's subagents record no usage with the daemon");
    expect(a).toContain('`cost.unmeteredLaunches`');
  });

  it('the Codex and OpenCode editions carry the same paragraph', () => {
    const para = (host: string) => paragraphs(skill(host)).find((p) => p.includes('no usage recorded'));
    expect(para('opencode')).toBe(para('codex'));
    expect(para('claude-code')).toBe(para('codex'));
  });
});
