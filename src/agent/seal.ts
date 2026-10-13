/**
 * Structural submission checks that run at seal time. See specs/agent-protocol
 * "Declared no-op" and "Acceptance evidence". The orchestrator applies the outcome.
 */
export interface SubmissionCheckInput {
  sealedSha: string;
  baseSha: string;
  noChanges: boolean;
  criteria: string[];
  covered: string[];
}

export type SubmissionCheck =
  | { ok: true }
  | { ok: false; reason: 'emptySubmission'; message: string }
  | { ok: false; reason: 'missingAcceptanceEvidence'; message: string; uncovered: string[] };

/**
 * Criteria are compared after dropping markdown code spans and emphasis, a
 * leading list marker such as the brief's "3.", and trailing punctuation,
 * collapsing whitespace, and ignoring case, so an agent that quotes a criterion
 * loosely still covers it. See specs/agent-protocol "Acceptance evidence".
 */
export function normaliseCriterion(text: string): string {
  return text
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:\d+[.)]|[-+])\s*/, '')
    .replace(/[.;:,]+$/, '')
    .toLowerCase();
}

export function checkSubmission(input: SubmissionCheckInput): SubmissionCheck {
  if (input.sealedSha === input.baseSha && !input.noChanges) {
    return { ok: false, reason: 'emptySubmission', message: 'no commits ahead of base and no noChanges declaration' };
  }
  // A criterion is covered by its normalised text or by its 1-based position in the brief's list.
  const covered = new Set(input.covered.map(normaliseCriterion));
  const uncovered = input.criteria.filter((c, i) => !covered.has(normaliseCriterion(c)) && !covered.has(String(i + 1)));
  if (uncovered.length) {
    return { ok: false, reason: 'missingAcceptanceEvidence', message: `no evidence for: ${uncovered.join('; ')}`, uncovered };
  }
  return { ok: true };
}
