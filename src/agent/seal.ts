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

export function checkSubmission(input: SubmissionCheckInput): SubmissionCheck {
  if (input.sealedSha === input.baseSha && !input.noChanges) {
    return { ok: false, reason: 'emptySubmission', message: 'no commits ahead of base and no noChanges declaration' };
  }
  const covered = new Set(input.covered.map((c) => c.trim()));
  const uncovered = input.criteria.filter((c) => !covered.has(c.trim()));
  if (uncovered.length) {
    return { ok: false, reason: 'missingAcceptanceEvidence', message: `no evidence for: ${uncovered.join('; ')}`, uncovered };
  }
  return { ok: true };
}
